// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import { takeSourceToken } from "../_pipeline/ratelimit.ts";
import { getConnector } from "../_sources/registry.ts";
import { ConnectorAuthError, ConnectorRateLimitError } from "../_sources/types.ts";
import type { JobContext } from "../_pipeline/runner.ts";

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

  // Upsert: per-source ref + a bare canonical asset row (if not existing).
  const upsertedAssetIds: string[] = [];
  for (const a of page.items) {
    // 1) Find existing ref → asset_id
    const { data: existingRef } = await sb.from("asset_source_refs")
      .select("asset_id").eq("source_account_id", source_account_id)
      .eq("source_asset_id", a.provider_asset_id).maybeSingle();

    let assetId: string | null = existingRef?.asset_id ?? null;
    if (!assetId) {
      const { data: newAsset, error: aErr } = await sb.from("assets").insert({
        user_id: acct.user_id,
        media_type: a.media_type === "image" ? "photo" : a.media_type,
        mime_type: a.mime_type,
        capture_time: a.capture_time,
        upload_time: a.upload_time,
        created_time: a.created_time,
        modified_time: a.modified_time,
        timezone: a.timezone,
        width: a.width, height: a.height, duration_ms: a.duration_ms,
        file_size_bytes: a.file_size_bytes,
        checksum_hash: a.checksum_hex,
        perceptual_hash: a.perceptual_hash,
        location_lat: a.location?.lat ?? null,
        location_lng: a.location?.lng ?? null,
        device_make: a.device_make, device_model: a.device_model,
        thumbnail_cache_key: a.thumbnail_url ?? null,
        proxy_cache_key: a.preview_url ?? null,
        status: "ingested",
      }).select("id").single();
      if (aErr) throw new Error(`insert asset: ${aErr.message}`);
      assetId = newAsset!.id as string;
    }

    await sb.from("asset_source_refs").upsert({
      asset_id: assetId, source_account_id, source_asset_id: a.provider_asset_id,
      provider_url: a.provider_url ?? null, is_primary: !existingRef,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: "source_account_id,source_asset_id" });

    upsertedAssetIds.push(assetId);
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

  // Fan-out normalizeMetadata
  for (const id of upsertedAssetIds) {
    await enqueueJob("normalizeMetadata", {
      userId: acct.user_id, payload: { asset_id: id },
      idempotencyKey: `normalize:${id}`,
    });
  }

  // Chain next page
  const { count: indexedTotal } = await sb.from("asset_source_refs")
    .select("id", { count: "exact", head: true })
    .eq("source_account_id", source_account_id);

  const finishJob = await sb.from("source_sync_jobs").update({
    status: page.nextCursor ? "running" : "completed",
    finished_at: page.nextCursor ? null : new Date().toISOString(),
    stats: {
      page_items: page.items.length,
      deleted: deleted.length,
      discovered: indexedTotal ?? upsertedAssetIds.length,
      indexed: indexedTotal ?? upsertedAssetIds.length,
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
    await enqueueJob("syncSource", { userId: acct.user_id, payload: ctx.payload, delaySeconds: 1 });
  } else {
    const completeAccount = await sb.from("source_accounts").update({ last_synced_at: new Date().toISOString(), status: "active" })
      .eq("id", source_account_id);
    if (completeAccount.error) {
      await failSyncJob(sb, source_account_id, ctx.jobId, "source_account_complete_failed", completeAccount.error.message, { stage: "complete" });
      throw new Error(`source_accounts complete failed: ${completeAccount.error.message}`);
    }
  }

  return { items: page.items.length, deleted: deleted.length, more: !!page.nextCursor };
}