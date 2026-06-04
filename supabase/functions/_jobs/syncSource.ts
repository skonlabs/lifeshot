// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob, enqueueMany } from "../_pipeline/enqueuer.ts";
import { takeSourceToken } from "../_pipeline/ratelimit.ts";
import { getConnector } from "../_sources/registry.ts";
import { ConnectorAuthError, ConnectorRateLimitError } from "../_sources/types.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { shouldResyncAsset } from "../../../src/lib/api/sync-status.logic.ts";

// Worker continuation enqueues the next page and nudges /worker/drain so the
// queue keeps moving immediately instead of waiting for the next cron tick.

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

function getProgressFileLabel(item: {
  provider_asset_id?: string;
  provider_url?: string;
  raw?: Record<string, unknown>;
}): string | null {
  const raw = item.raw && typeof item.raw === "object" ? item.raw : {};
  const pathCandidate = [raw.path_display, raw.path, raw.name, item.provider_url, item.provider_asset_id]
    .find((value) => typeof value === "string" && value.trim().length > 0);
  if (typeof pathCandidate !== "string") return null;
  const leaf = pathCandidate.split(/[\\/]/).filter(Boolean).pop();
  return leaf ?? pathCandidate;
}

async function nudgeWorkerDrain() {
  const base = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("PROJECT_URL") ?? "";
  const secret = Deno.env.get("WORKER_SECRET") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? "";
  if (!base) return;

  let workerUrl = "";
  try {
    workerUrl = `${new URL(base).origin}/functions/v1/worker/drain?batch=1&budget_ms=50000`;
  } catch {
    return;
  }

  const request = fetch(workerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(anonKey ? { authorization: `Bearer ${anonKey}` } : {}),
      ...(secret ? { "x-worker-secret": secret } : {}),
    },
    body: JSON.stringify({}),
  }).catch((error) => {
    console.warn("syncSource continuation nudge failed:", String(error));
    return undefined;
  });

  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(request);
    return;
  }

  await request;
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

function decodeStoredCursor(value: unknown): string | null {
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try {
      const parsed = JSON.parse(value) as { token?: unknown; providerCursor?: unknown; folderIndex?: unknown } | null;
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.token === "string") {
          return parsed.token;
        }
        if (typeof parsed.providerCursor === "string") {
          return value;
        }
      }
    } catch {
      // Legacy rows store the raw provider cursor as plain text.
    }
    return value;
  }

  if (value && typeof value === "object") {
    const parsed = value as { token?: unknown; providerCursor?: unknown; folderIndex?: unknown };
    if (typeof parsed.token === "string") return parsed.token;
    if (
      typeof parsed.providerCursor === "string" ||
      typeof parsed.folderIndex === "number"
    ) {
      return JSON.stringify(value);
    }
    return null;
  }

  return null;
}

async function loadCursor(sb: ReturnType<typeof serviceClient>, sourceAccountId: string, cursorKind: string): Promise<string | null> {
  const modern = await sb.from("source_sync_cursors")
    .select("cursor")
    .eq("source_account_id", sourceAccountId)
    .eq("kind", cursorKind)
    .maybeSingle();

  if (!modern.error && modern.data) {
    return decodeStoredCursor(modern.data?.cursor ?? null);
  }

  const legacy = await sb.from("source_sync_cursors")
    .select("cursor, delta_token")
    .eq("source_account_id", sourceAccountId)
    .maybeSingle();
  if (legacy.error) throw new Error(`load cursor: ${legacy.error.message}`);
   return decodeStoredCursor(cursorKind === "delta" ? legacy.data?.delta_token ?? null : legacy.data?.cursor ?? null);
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

  const legacyRow = await sb.from("source_sync_cursors")
    .select("id")
    .eq("source_account_id", sourceAccountId)
    .maybeSingle();
  if (legacyRow.error) throw new Error(`save cursor legacy lookup: ${legacyRow.error.message}`);

  if (legacyRow.data?.id) {
    const legacyUpdate = await sb.from("source_sync_cursors").update(patch).eq("id", legacyRow.data.id);
    if (legacyUpdate.error) throw new Error(`save cursor legacy update: ${legacyUpdate.error.message}`);
    return;
  }

  const legacyInsert = await sb.from("source_sync_cursors").insert({
    source_account_id: sourceAccountId,
    cursor: cursorKind === "delta" ? null : nextCursor,
    delta_token: cursorKind === "delta" ? nextCursor : null,
  });
  if (legacyInsert.error) throw new Error(`save cursor legacy insert: ${legacyInsert.error.message}`);
}

/**
 * syncSource — pull a page of assets from a source_account, upsert assets,
 * enqueue normalizeMetadata for each new/updated, and chain itself if more pages.
 */
export async function syncSource(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { source_account_id, mode = "incremental", force = false } = ctx.payload as { source_account_id: string; mode?: "initial" | "incremental"; force?: boolean };
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
  const progressBaseIndexed = force ? 0 : baseIndexed;
  await writeProgress(sb, ctx.jobId, {
    stage: "connecting",
    discovered: Math.max(1, progressBaseIndexed),
    indexed: progressBaseIndexed,
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
    discovered: Math.max(progressBaseIndexed + page.items.length, progressBaseIndexed, 1),
    current_file: page.items.map(getProgressFileLabel).find(Boolean) ?? null,
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

  const existingAssetIds = Array.from(new Set((existingRefs ?? []).map((r: any) => r.asset_id).filter(Boolean)));
  const metadataCompleteness = new Map<string, {
    hasFileMetadata: boolean;
    hasMediaMetadata: boolean;
    hasPreviewMetadata: boolean;
    hasAiReadyMetadata: boolean;
    hasOrganizationSignals: boolean;
    hasVideoMetadata: boolean;
    hasDocumentMetadata: boolean;
    hasAudioMetadata: boolean;
  }>();
  if (existingAssetIds.length > 0) {
    const [
      { data: fileMetadataRows, error: fileMetadataError },
      { data: mediaMetadataRows, error: mediaMetadataError },
      { data: previewMetadataRows, error: previewMetadataError },
      { data: aiReadyRows, error: aiReadyError },
      { data: organizationRows, error: organizationError },
      { data: videoRows, error: videoError },
      { data: documentRows, error: documentError },
      { data: audioRows, error: audioError },
    ] = await Promise.all([
      sb.from("asset_file_metadata").select("asset_id").in("asset_id", existingAssetIds),
      sb.from("asset_media_metadata").select("asset_id").in("asset_id", existingAssetIds),
      sb.from("asset_preview_metadata").select("asset_id").in("asset_id", existingAssetIds),
      sb.from("asset_ai_ready_metadata").select("asset_id").in("asset_id", existingAssetIds),
      sb.from("asset_organization_signals").select("asset_id").in("asset_id", existingAssetIds),
      sb.from("asset_video_metadata").select("asset_id").in("asset_id", existingAssetIds),
      sb.from("asset_document_metadata").select("asset_id").in("asset_id", existingAssetIds),
      sb.from("asset_audio_metadata").select("asset_id").in("asset_id", existingAssetIds),
    ]);
    if (fileMetadataError) throw new Error(`load file metadata completeness: ${fileMetadataError.message}`);
    if (mediaMetadataError) throw new Error(`load media metadata completeness: ${mediaMetadataError.message}`);
    if (previewMetadataError) throw new Error(`load preview metadata completeness: ${previewMetadataError.message}`);
    if (aiReadyError) throw new Error(`load ai-ready metadata completeness: ${aiReadyError.message}`);
    if (organizationError) throw new Error(`load organization metadata completeness: ${organizationError.message}`);
    if (videoError) throw new Error(`load video metadata completeness: ${videoError.message}`);
    if (documentError) throw new Error(`load document metadata completeness: ${documentError.message}`);
    if (audioError) throw new Error(`load audio metadata completeness: ${audioError.message}`);

    const fileIds = new Set((fileMetadataRows ?? []).map((row: any) => row.asset_id).filter(Boolean));
    const mediaIds = new Set((mediaMetadataRows ?? []).map((row: any) => row.asset_id).filter(Boolean));
    const previewIds = new Set((previewMetadataRows ?? []).map((row: any) => row.asset_id).filter(Boolean));
    const aiReadyIds = new Set((aiReadyRows ?? []).map((row: any) => row.asset_id).filter(Boolean));
    const organizationIds = new Set((organizationRows ?? []).map((row: any) => row.asset_id).filter(Boolean));
    const videoIds = new Set((videoRows ?? []).map((row: any) => row.asset_id).filter(Boolean));
    const documentIds = new Set((documentRows ?? []).map((row: any) => row.asset_id).filter(Boolean));
    const audioIds = new Set((audioRows ?? []).map((row: any) => row.asset_id).filter(Boolean));
    for (const assetId of existingAssetIds) {
      metadataCompleteness.set(assetId, {
        hasFileMetadata: fileIds.has(assetId),
        hasMediaMetadata: mediaIds.has(assetId),
        hasPreviewMetadata: previewIds.has(assetId),
        hasAiReadyMetadata: aiReadyIds.has(assetId),
        hasOrganizationSignals: organizationIds.has(assetId),
        hasVideoMetadata: videoIds.has(assetId),
        hasDocumentMetadata: documentIds.has(assetId),
        hasAudioMetadata: audioIds.has(assetId),
      });
    }
  }

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
    const currentMetadata = metadataCompleteness.get(assetId) ?? {
      hasFileMetadata: false,
      hasMediaMetadata: false,
      hasPreviewMetadata: false,
      hasAiReadyMetadata: false,
      hasOrganizationSignals: false,
      hasVideoMetadata: false,
      hasDocumentMetadata: false,
      hasAudioMetadata: false,
    };
    if (force || shouldResyncAsset({
      isNew,
      mediaType: a.media_type ?? null,
      existingSourceModifiedAt: existing?.source_modified_at ?? null,
      providerModifiedAt,
      hasFileMetadata: currentMetadata.hasFileMetadata,
      hasMediaMetadata: currentMetadata.hasMediaMetadata,
      hasPreviewMetadata: currentMetadata.hasPreviewMetadata,
      hasAiReadyMetadata: currentMetadata.hasAiReadyMetadata,
      hasOrganizationSignals: currentMetadata.hasOrganizationSignals,
      hasVideoMetadata: currentMetadata.hasVideoMetadata,
      hasDocumentMetadata: currentMetadata.hasDocumentMetadata,
      hasAudioMetadata: currentMetadata.hasAudioMetadata,
    })) {
      needsNormalize.push({ assetId, modifiedTime: providerModifiedAt });
    }
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
  const prevPageCount = Number(prevStats.page_count ?? 0);
  const prevCursor = typeof prevStats.last_cursor === "string" ? prevStats.last_cursor as string : null;
  const prevIndexed = Number(prevStats.indexed ?? 0);
  const currentFile = typeof prevStats.current_file === "string" && prevStats.current_file.length > 0
    ? prevStats.current_file
    : page.items.map(getProgressFileLabel).find(Boolean) ?? null;
  const newCursor = page.nextCursor ?? null;
  const pageCount = prevPageCount + 1;

  // Safety net: terminate ONLY if the connector returns the SAME continuation
  // cursor we just processed (true infinite loop — connector bug). There is
  // NO page cap: every file in the selected folders must be processed,
  // however many pages that takes.
  const loopDetected =
    !!newCursor && !!prevCursor && newCursor === prevCursor;
  const forceTerminate = loopDetected;
  const effectiveNextCursor = forceTerminate ? null : newCursor;
  if (forceTerminate) {
    await recordSyncError(
      sb,
      source_account_id,
      "sync_cursor_loop_detected",
      `Connector returned the same continuation cursor twice; terminating sync to avoid infinite loop.`,
      { provider_kind: providerKind, page_count: pageCount },
    );
  }

  const seenTotal = prevSeen + page.items.length;
  const indexedCount = indexedTotal ?? 0;
  const progressIndexedCount = force ? seenTotal : indexedCount;
  const discovered = force ? Math.max(seenTotal, 1) : Math.max(seenTotal, indexedCount, 1);
  const indexedAdvanced = progressIndexedCount > prevIndexed;
  // Only fire the "no progress" guard AFTER we've already processed at least
  // one page. The first page of a Dropbox/Drive recursive listing frequently
  // returns only folder entries (no file items) before reaching files, with
  // a valid continuation cursor — that is normal enumeration, not a stale
  // loop. Killing the sync there leaves users stuck at 0 indexed.
  const noForwardProgress = prevPageCount > 0
    && !!newCursor
    && page.items.length === 0
    && deleted.length === 0
    && needsNormalize.length === 0
    && !indexedAdvanced;

  if (noForwardProgress) {
    await recordSyncError(
      sb,
      source_account_id,
      "sync_no_progress_terminated",
      "Connector reported more pages but this page produced no new files, deletions, or metadata work; terminating sync to avoid a stale loop.",
      { provider_kind: providerKind, page_count: pageCount, cursor: newCursor },
    );
  }

  const finishJob = await sb.from("source_sync_jobs").update({
    status: effectiveNextCursor && !noForwardProgress ? "running" : "completed",
    finished_at: effectiveNextCursor && !noForwardProgress ? null : new Date().toISOString(),
    stats: {
      ...prevStats,
      stage: effectiveNextCursor && !noForwardProgress ? "indexing" : "completed",
      provider_kind: providerKind,
      page_items: page.items.length,
      seen_total: seenTotal,
      deleted: prevDeleted + deleted.length,
      discovered,
      indexed: progressIndexedCount,
      normalized: prevNormalized + needsNormalize.length,
      ...(currentFile ? { current_file: currentFile } : {}),
      has_more: !!effectiveNextCursor && !noForwardProgress,
      page_count: pageCount,
      last_cursor: newCursor,
    },
  }).eq("id", ctx.jobId);
  if (finishJob.error) {
    await failSyncJob(sb, source_account_id, ctx.jobId, "source_sync_job_finish_failed", finishJob.error.message, { stage: "finish" });
    throw new Error(`source_sync_jobs finish failed: ${finishJob.error.message}`);
  }

  if (!effectiveNextCursor) {
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

  if (effectiveNextCursor && !noForwardProgress && !stopRequested) {
    const nextJob = await enqueueJob("syncSource", { userId: acct.user_id, payload: ctx.payload });
    if (nextJob.id) {
      await sb.from("source_sync_jobs").upsert({
        id: nextJob.id,
        source_account_id,
        kind: syncKind,
        status: "pending",
        stats: {
          ...prevStats,
          stage: "queued",
          provider_kind: providerKind,
          page_items: page.items.length,
          seen_total: seenTotal,
          deleted: prevDeleted + deleted.length,
          discovered,
          indexed: progressIndexedCount,
          normalized: prevNormalized + needsNormalize.length,
          ...(currentFile ? { current_file: currentFile } : {}),
          has_more: true,
          page_count: pageCount,
          last_cursor: newCursor,
        },
      }, { onConflict: "id" });
    }
    await nudgeWorkerDrain();
  } else {
    const completeAccount = await sb.from("source_accounts").update({ last_synced_at: new Date().toISOString(), status: "active" })
      .eq("id", source_account_id);
    if (completeAccount.error) {
      await failSyncJob(sb, source_account_id, ctx.jobId, "source_account_complete_failed", completeAccount.error.message, { stage: "complete" });
      throw new Error(`source_accounts complete failed: ${completeAccount.error.message}`);
    }
  }

  return {
    items: page.items.length,
    normalized: needsNormalize.length,
    deleted: deleted.length,
    more: !!effectiveNextCursor,
    page_count: pageCount,
    ...(forceTerminate ? { terminated: "loop_detected" } : {}),
  };
}