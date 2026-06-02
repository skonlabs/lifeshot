// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob, enqueueMany } from "../_pipeline/enqueuer.ts";
import { takeSourceToken } from "../_pipeline/ratelimit.ts";
import { getConnector } from "../_sources/registry.ts";
import { ConnectorAuthError, ConnectorRateLimitError } from "../_sources/types.ts";
import type { JobContext } from "../_pipeline/runner.ts";

// Wake the worker for chained pages using the same two-path strategy as the
// initial /sync request:
// 1) in-process drain via runner.ts so continuation works even if /worker/drain
//    is misconfigured or unavailable;
// 2) best-effort HTTP kick to the dedicated worker endpoint.
//
// This fixes the failure mode where page 1 completes, enqueues page 2, but the
// continuation stays pending forever because only the HTTP wake-up path is used
// and that path silently fails.
async function kickWorkerDrain(options: { inline?: boolean } = {}) {
  try {
    // deno-lint-ignore no-explicit-any
    const globalAny = globalThis as any;
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const secret = Deno.env.get("WORKER_SECRET") ?? "";
    const inProcess = (async () => {
      try {
        const { drainOnce, drainUntilEmpty } = await import("../_pipeline/runner.ts");
        if (options.inline) {
          await drainOnce({ batch: 1 });
          return;
        }
        await drainOnce({ batch: 1 });
        await drainUntilEmpty(55_000, 16);
      } catch {
        // swallow
      }
    })();

    const httpKick = (!url || !serviceKey)
      ? Promise.resolve()
      : fetch(`${url}/functions/v1/worker/drain`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${serviceKey}`,
          ...(secret ? { "x-worker-secret": secret } : {}),
        },
        body: JSON.stringify({ batch: 8 }),
      }).then(() => undefined).catch(() => undefined);

    const combined = Promise.all([inProcess, httpKick]);
    if (globalAny.EdgeRuntime?.waitUntil) {
      globalAny.EdgeRuntime.waitUntil(combined);
      return;
    }
    await combined.catch(() => {});
  } catch {
    // swallow
  }
}

// Write a progress heartbeat to source_sync_jobs.stats so the UI can show
// meaningful progress before a page completes. Never throws.
async function writeProgress(
  sb: ReturnType<typeof serviceClient>,
  jobId: string,
  patch: Record<string, unknown>,
) {
  try {
    const cur = await sb.from("source_sync_jobs").select("stats").eq("id", jobId).maybeSingle();
    const prev = (cur.data?.stats && typeof cur.data.stats === "object")
      ? cur.data.stats as Record<string, unknown>
      : {};
    await sb.from("source_sync_jobs").update({ stats: { ...prev, ...patch } }).eq("id", jobId);
  } catch {
    // best effort
  }
}

function isMissingColumnError(message?: string | null, column?: string) {
  if (!message || !column) return false;
  const normalized = message.toLowerCase();
  const target = column.toLowerCase();
  return (
    normalized.includes(`could not find the '${target}' column`) ||
    (normalized.includes(target) && normalized.includes("schema cache")) ||
    (normalized.includes(target) && normalized.includes("does not exist"))
  );
}

async function recordSyncError(
  sb: ReturnType<typeof serviceClient>,
  sourceAccountId: string,
  code: string,
  message: string,
  payload: Record<string, unknown> = {},
) {
  await sb.from("source_errors").insert({
    source_account_id: sourceAccountId,
    code,
    message,
    payload,
  });
}

async function failSyncJob(
  sb: ReturnType<typeof serviceClient>,
  sourceAccountId: string,
  jobId: string,
  code: string,
  message: string,
  payload: Record<string, unknown> = {},
) {
  await recordSyncError(sb, sourceAccountId, code, message, payload);
  await sb.from("source_sync_jobs").upsert({
    id: jobId,
    source_account_id: sourceAccountId,
    kind: "incremental",
    status: "failed",
    finished_at: new Date().toISOString(),
    stats: { ...payload, error: message },
  }, { onConflict: "id" });
  await sb.from("source_accounts").update({ status: "error" }).eq("id", sourceAccountId);
}

async function loadCursor(sb: ReturnType<typeof serviceClient>, sourceAccountId: string, cursorKind: string): Promise<string | null> {
  const modern = await sb.from("source_sync_cursors")
    .select("cursor")
    .eq("source_account_id", sourceAccountId)
    .eq("kind", cursorKind)
    .maybeSingle();

  if (!modern.error) {
    return ((modern.data?.cursor as { token?: string } | null)?.token ?? null);
  }

  const legacy = await sb.from("source_sync_cursors")
    .select("cursor, delta_token")
    .eq("source_account_id", sourceAccountId)
    .maybeSingle();
  if (legacy.error) throw new Error(`load cursor: ${legacy.error.message}`);
  return cursorKind === "delta" ? (legacy.data?.delta_token ?? null) : (legacy.data?.cursor ?? null);
}

async function saveCursor(sb: ReturnType<typeof serviceClient>, sourceAccountId: string, cursorKind: string, nextCursor: string | null) {
  const modern = await sb.from("source_sync_cursors").upsert({
    source_account_id: sourceAccountId,
    kind: cursorKind,
    cursor: { token: nextCursor },
    last_sync_at: new Date().toISOString(),
  }, { onConflict: "source_account_id,kind" });

  if (!modern.error) return;

  const patch = cursorKind === "delta"
    ? { delta_token: nextCursor, updated_at: new Date().toISOString() }
    : { cursor: nextCursor, updated_at: new Date().toISOString() };

  const legacyUpdate = await sb.from("source_sync_cursors").update(patch).eq("source_account_id", sourceAccountId);
  if (legacyUpdate.error) {
    const legacyInsert = await sb.from("source_sync_cursors").insert({
      source_account_id: sourceAccountId,
      cursor: cursorKind === "delta" ? null : nextCursor,
      delta_token: cursorKind === "delta" ? nextCursor : null,
    });
    if (legacyInsert.error) throw new Error(`save cursor: ${legacyInsert.error.message}`);
  }
}

/**
 * syncSource — pull a page of assets from a source_account, upsert assets,
 * enqueue normalizeMetadata for each new/updated, and chain itself if more pages.
 */
export async function syncSource(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { source_account_id, mode = "incremental" } = ctx.payload as { source_account_id: string; mode?: "initial" | "incremental" };
  if (!source_account_id) throw new Error("invalid: source_account_id missing");
  const syncKind = mode === "initial" ? "initial" : "incremental";

  const startJob = await sb.from("source_sync_jobs").upsert({
    id: ctx.jobId,
    source_account_id,
    kind: syncKind,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
  }, { onConflict: "id" });
  if (startJob.error) {
    await failSyncJob(sb, source_account_id, ctx.jobId, "source_sync_job_start_failed", startJob.error.message, { stage: "start" });
    throw new Error(`source_sync_jobs start failed: ${startJob.error.message}`);
  }

  const accountRunning = await sb.from("source_accounts").update({ status: "pending" }).eq("id", source_account_id);
  if (accountRunning.error) {
    await failSyncJob(sb, source_account_id, ctx.jobId, "source_account_status_failed", accountRunning.error.message, { stage: "account_running" });
    throw new Error(`source_accounts pending failed: ${accountRunning.error.message}`);
  }

  // Early heartbeat: tell the UI we're past the "discovering" gate and into
  // active work. discovered=1 keeps the existing UI guard (`> 0`) happy.
  const currentIndexedCount = await sb.from("asset_source_refs")
    .select("id", { count: "exact", head: true })
    .eq("source_account_id", source_account_id);
  const baseIndexed = currentIndexedCount.count ?? 0;
  await writeProgress(sb, ctx.jobId, {
    stage: "connecting",
    discovered: Math.max(1, baseIndexed),
    indexed: baseIndexed,
  });

  const accountSelect = await sb.from("source_accounts")
    .select("id, user_id, provider_id, provider_kind, status, sync_cancel_requested_at").eq("id", source_account_id).single();
  const accountSelectFallback = accountSelect.error && isMissingColumnError(accountSelect.error.message, "sync_cancel_requested_at")
    ? await sb.from("source_accounts")
      .select("id, user_id, provider_id, provider_kind, status").eq("id", source_account_id).single()
    : null;
  const acct = accountSelect.data ?? accountSelectFallback?.data;
  const error = accountSelectFallback
    ? accountSelectFallback.error
    : accountSelect.error;
  if (error || !acct) {
    await failSyncJob(sb, source_account_id, ctx.jobId, "source_account_lookup_failed", error?.message ?? "source account not found", { stage: "lookup" });
    throw new Error("not found: source_account");
  }
  // Honor user-requested stop. If a cancel was requested, mark this job
  // cancelled, set account back to active, and do NOT chain another page.
  const currentJob = await sb.from("source_sync_jobs").select("status, stats").eq("id", ctx.jobId).maybeSingle();
  const jobStats = currentJob.data?.stats && typeof currentJob.data.stats === "object"
    ? currentJob.data.stats as Record<string, unknown>
    : {};
  const cancellationRequested =
    (acct as any).sync_cancel_requested_at ||
    currentJob.data?.status === "cancelled" ||
    jobStats.cancelled === true;
  if (cancellationRequested) {
    await sb.from("source_sync_jobs").update({
      status: "cancelled",
      finished_at: new Date().toISOString(),
    }).eq("id", ctx.jobId);
    await sb.from("source_accounts").update({ status: "active" }).eq("id", source_account_id);
    return { cancelled: true };
  }
  if (acct.status === "disconnected" || acct.status === "revoked") return { skipped: "disconnected" };

  let providerKind = acct.provider_kind;
  if (!providerKind && acct.provider_id) {
    const { data: provider, error: providerErr } = await sb.from("source_providers")
      .select("kind")
      .eq("id", acct.provider_id)
      .single();
    if (providerErr || !provider?.kind) {
      await failSyncJob(sb, source_account_id, ctx.jobId, "provider_kind_missing", providerErr?.message ?? "provider_kind missing", { stage: "provider_lookup" });
      throw new Error("invalid: provider_kind missing");
    }
    providerKind = provider.kind;
    await sb.from("source_accounts").update({ provider_kind: providerKind }).eq("id", source_account_id);
  }

  const conn = getConnector(providerKind, { source_account_id, user_id: acct.user_id, provider_kind: providerKind }, sb);
  const caps = conn.getCapabilities();

  if (!(await takeSourceToken(source_account_id, caps.rateLimitPerMin))) {
    await enqueueJob("syncSource", { userId: acct.user_id, payload: ctx.payload, delaySeconds: 60 });
    return { rateLimited: true };
  }

  // Load cursor
  const cursorKind = mode === "initial" ? "list" : (caps.supportsDelta ? "delta" : "list");
  const cursor = await loadCursor(sb, source_account_id, cursorKind);

  await writeProgress(sb, ctx.jobId, { stage: "listing", provider_kind: providerKind });

  let page;
  try {
    page = cursorKind === "delta" ? await conn.getDeltaChanges(cursor) : await conn.listAssets(cursor);
  } catch (e) {
    if (e instanceof ConnectorAuthError) {
      await failSyncJob(sb, source_account_id, ctx.jobId, "source_connector_auth_failed", e.message, { stage: "list", provider_kind: providerKind, mode });
      await sb.from("source_accounts").update({ status: "revoked" }).eq("id", source_account_id);
      throw new Error(e.message);
    }
    if (e instanceof ConnectorRateLimitError) {
      await enqueueJob("syncSource", { userId: acct.user_id, payload: ctx.payload, delaySeconds: e.retryAfterSeconds });
      return { rateLimited: true };
    }
    const msg = e instanceof Error ? e.message : String(e);
    await failSyncJob(sb, source_account_id, ctx.jobId, "source_connector_failed", msg, { stage: "list", provider_kind: providerKind, mode });
    throw e;
  }

  await writeProgress(sb, ctx.jobId, {
    stage: "indexing",
    page_items: page.items.length,
    discovered: Math.max(baseIndexed + page.items.length, baseIndexed, 1),
  });

  // ── Bulk DB work: 4 queries total regardless of page size ───────────────────
  //
  // 1) Load all existing refs for this page in ONE query.
  // 2) Bulk-insert brand-new assets.
  // 3) Bulk-upsert all asset_source_refs.
  // 4) Bulk-enqueue normalizeMetadata for new/changed assets.
  //
  // Previous approach: ~3 sequential queries × N items = 300 round-trips/page.
  // This approach: 4 queries regardless of N — fits easily inside the 25s window.

  const providerIds = page.items.map((a) => a.provider_asset_id);

  // 1) Bulk-load existing refs.
  const { data: existingRefs } = await sb.from("asset_source_refs")
    .select("asset_id, source_asset_id, source_modified_at, is_primary")
    .eq("source_account_id", source_account_id)
    .in("source_asset_id", providerIds);

  const refMap = new Map<string, { asset_id: string; source_modified_at: string | null; is_primary: boolean }>(
    (existingRefs ?? []).map((r: any) => [r.source_asset_id, r]),
  );

  // 2) Bulk-insert new assets (those without an existing ref).
  const newItems = page.items.filter((a) => !refMap.has(a.provider_asset_id));
  let newAssetMap = new Map<string, string>(); // provider_asset_id → asset_id

  if (newItems.length > 0) {
    const rows = newItems.map((a) => ({
      user_id: acct.user_id,
      media_type: a.media_type === "image" ? "photo" : a.media_type,
      mime_type: a.mime_type ?? null,
      capture_time: a.capture_time ?? null,
      upload_time: a.upload_time ?? null,
      created_time: a.created_time ?? null,
      modified_time: a.modified_time ?? null,
      timezone: a.timezone ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
      duration_ms: a.duration_ms ?? null,
      file_size_bytes: a.file_size_bytes ?? null,
      checksum_hash: a.checksum_hex ?? null,
      perceptual_hash: a.perceptual_hash ?? null,
      location_lat: a.location?.lat ?? null,
      location_lng: a.location?.lng ?? null,
      device_make: a.device_make ?? null,
      device_model: a.device_model ?? null,
      thumbnail_cache_key: a.thumbnail_url ?? null,
      proxy_cache_key: a.preview_url ?? null,
      status: "ingested",
    }));
    const { data: inserted, error: insertErr } = await sb.from("assets")
      .insert(rows).select("id");
    if (insertErr) throw new Error(`bulk insert assets: ${insertErr.message}`);
    // Map inserted IDs back to provider_asset_ids by position.
    (inserted ?? []).forEach((row: any, i: number) => {
      newAssetMap.set(newItems[i].provider_asset_id, row.id);
    });
  }

  // 3) Bulk-upsert asset_source_refs.
  const now = new Date().toISOString();
  const refRows = page.items.map((a) => {
    const existing = refMap.get(a.provider_asset_id);
    const assetId = existing?.asset_id ?? newAssetMap.get(a.provider_asset_id)!;
    return {
      asset_id: assetId,
      source_account_id,
      source_asset_id: a.provider_asset_id,
      source_kind: providerKind,
      source_relative_path: (a as any).relative_path ?? a.provider_url ?? null,
      source_modified_at: a.modified_time ?? a.created_time ?? null,
      provider_url: a.provider_url ?? null,
      is_primary: existing ? (existing.is_primary ?? false) : true,
      last_seen_at: now,
    };
  }).filter((r) => r.asset_id); // skip any that failed to insert

  if (refRows.length > 0) {
    const { error: refErr } = await sb.from("asset_source_refs")
      .upsert(refRows, { onConflict: "source_account_id,source_asset_id" });
    if (refErr) throw new Error(`bulk upsert refs: ${refErr.message}`);
  }

  // Collect assets needing normalizeMetadata (new OR modified).
  const needsNormalize: Array<{ assetId: string; modifiedTime: string | null }> = [];
  for (const a of page.items) {
    const existing = refMap.get(a.provider_asset_id);
    const assetId = existing?.asset_id ?? newAssetMap.get(a.provider_asset_id);
    if (!assetId) continue;
    const providerModifiedAt = a.modified_time ?? a.created_time ?? null;
    const isNew = !existing;
    const hasChanged = isNew || !existing.source_modified_at ||
      (providerModifiedAt && providerModifiedAt > existing.source_modified_at);
    if (hasChanged) needsNormalize.push({ assetId, modifiedTime: providerModifiedAt });
  }

  // Cascade deletions via refs.
  const deleted = ("deleted" in page ? (page as any).deleted : []) as string[];
  if (deleted.length) {
    const { data: gone } = await sb.from("asset_source_refs")
      .select("asset_id").eq("source_account_id", source_account_id)
      .in("source_asset_id", deleted);
    const goneIds = (gone ?? []).map((r: any) => r.asset_id);
    if (goneIds.length) {
      await sb.from("assets").update({ deleted_state: "deleted", status: "deleted" }).in("id", goneIds);
    }
    await sb.from("asset_source_refs").delete()
      .eq("source_account_id", source_account_id).in("source_asset_id", deleted);
  }

  // Save cursor
  await saveCursor(sb, source_account_id, cursorKind, page.nextCursor);

  // 4) Bulk-enqueue normalizeMetadata — one INSERT for all changed assets.
  if (needsNormalize.length > 0) {
    await enqueueMany(needsNormalize.map(({ assetId, modifiedTime }) => ({
      name: "normalizeMetadata",
      opts: {
        userId: acct.user_id,
        payload: { asset_id: assetId, source_account_id },
        idempotencyKey: `normalize:${assetId}:${modifiedTime ?? "initial"}`,
      },
    })));
  }

  // Chain next page
  const { count: indexedTotal } = await sb.from("asset_source_refs")
    .select("id", { count: "exact", head: true })
    .eq("source_account_id", source_account_id);

  // Merge with previous stats so `stage` (set by writeProgress) is preserved
  // and counters like `seen_total` / `deleted` / `normalized` accumulate across
  // chained pages. Replacing stats wholesale wiped `stage` every page and reset
  // `discovered` to 0 whenever a page returned 0 file entries (common with
  // Dropbox recursive listings that interleave folders + files), which left the
  // UI stuck on "Discovering files…" forever.
  const prevStatsRes = await sb.from("source_sync_jobs").select("stats").eq("id", ctx.jobId).maybeSingle();
  const prevStats = (prevStatsRes.data?.stats && typeof prevStatsRes.data.stats === "object")
    ? prevStatsRes.data.stats as Record<string, unknown>
    : {};
  const prevSeen = Number(prevStats.seen_total ?? 0);
  const prevDeleted = Number(prevStats.deleted ?? 0);
  const prevNormalized = Number(prevStats.normalized ?? 0);
  const seenTotal = prevSeen + page.items.length;
  const indexedCount = indexedTotal ?? 0;
  const discovered = Math.max(seenTotal, indexedCount, 1);

  const finishJob = await sb.from("source_sync_jobs").update({
    status: page.nextCursor ? "running" : "completed",
    finished_at: page.nextCursor ? null : new Date().toISOString(),
    stats: {
      ...prevStats,
      stage: page.nextCursor ? "indexing" : "completed",
      provider_kind: providerKind,
      page_items: page.items.length,
      seen_total: seenTotal,
      deleted: prevDeleted + deleted.length,
      discovered,
      indexed: indexedCount,
      normalized: prevNormalized + needsNormalize.length,
      has_more: !!page.nextCursor,
    },
  }).eq("id", ctx.jobId);
  if (finishJob.error) {
    await failSyncJob(sb, source_account_id, ctx.jobId, "source_sync_job_finish_failed", finishJob.error.message, { stage: "finish" });
    throw new Error(`source_sync_jobs finish failed: ${finishJob.error.message}`);
  }

  if (!page.nextCursor) {
    const { error: resolveErrorsError } = await sb.from("source_errors")
      .update({ resolved: true })
      .eq("source_account_id", source_account_id)
      .eq("resolved", false);
    if (resolveErrorsError) {
      await failSyncJob(sb, source_account_id, ctx.jobId, "source_error_resolve_failed", resolveErrorsError.message, { stage: "resolve_errors" });
      throw new Error(`source_errors resolve failed: ${resolveErrorsError.message}`);
    }
  }

  const latestJobState = await sb.from("source_sync_jobs").select("status, stats").eq("id", ctx.jobId).maybeSingle();
  const latestStats = latestJobState.data?.stats && typeof latestJobState.data.stats === "object"
    ? latestJobState.data.stats as Record<string, unknown>
    : {};
  const stopRequested = latestJobState.data?.status === "cancelled" || latestStats.cancelled === true;

  if (page.nextCursor && !stopRequested) {
    // Re-enqueue the next page immediately so the current drain loop can
    // claim it in the same invocation. A 1s delay makes drainUntilEmpty()
    // exit before the next page becomes eligible, which leaves the chain
    // dependent on a second worker wake-up. If that wake-up misses (for
    // example a secret/config mismatch on /worker/drain), sync appears stuck
    // forever after the first page.
    await enqueueJob("syncSource", { userId: acct.user_id, payload: ctx.payload });
    // Drain the next queued page inline before returning. The previous
    // fire-and-forget wake-up was leaving follow-up jobs in `pending`
    // indefinitely, which matches the user's stuck "Discovering files..."
    // state after the first batch.
    await kickWorkerDrain({ inline: true });
  } else {
    const completeAccount = await sb.from("source_accounts").update({ last_synced_at: new Date().toISOString(), status: "active" })
      .eq("id", source_account_id);
    if (completeAccount.error) {
      await failSyncJob(sb, source_account_id, ctx.jobId, "source_account_complete_failed", completeAccount.error.message, { stage: "complete" });
      throw new Error(`source_accounts complete failed: ${completeAccount.error.message}`);
    }
  }

  return { items: page.items.length, normalized: needsNormalize.length, deleted: deleted.length, more: !!page.nextCursor };
}