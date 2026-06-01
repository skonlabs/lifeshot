// deno-lint-ignore-file no-explicit-any
/**
 * Scans Edge Function — Universal Metadata Extraction & Indexing Engine
 *
 * Routes (mount basePath: /scans):
 *   POST   /v1/start                Start a new scan session
 *   GET    /v1/:id                  Get full scan session
 *   GET    /v1/:id/progress         Get live progress
 *   POST   /v1/:id/batch            Ingest one batch of canonical metadata
 *   POST   /v1/:id/cancel           Request cancellation
 *   POST   /v1/:id/resume           Resume a paused or cancelled scan
 *   POST   /v1/:id/finalize         Mark scan complete
 *   POST   /v1/:id/checkpoint       Persist a resume checkpoint
 *   GET    /v1/:id/errors           List errors for a scan
 *   GET    /v1/:id/results          List asset_ids upserted by a scan
 *   GET    /v1/assets/:assetId/metadata  Full canonical metadata view
 */
import { z, type Context } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody, parseParams, parseQuery } from "../_shared/validation.ts";
import { ApiError } from "../_shared/errors.ts";
import { getServiceClient } from "../_shared/clients.ts";
import {
  ScanRequestSchema,
  MetadataBatchSchema,
  ScanCheckpointSchema,
  type ScanProgress,
} from "../../../packages/core/metadata/types.ts";
import { ingestBatch } from "../_metadata/persistence.ts";

const app = createApi("/scans");
authed(app);

const IdParam = z.object({ id: z.string().uuid() });
const AssetIdParam = z.object({ assetId: z.string().uuid() });

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/start
// ─────────────────────────────────────────────────────────────────────────────
app.post("/v1/start", async (c) => {
  const uid = c.get("userId");
  const req = await parseBody(c, ScanRequestSchema);
  const svc = getServiceClient();

  const { data, error } = await svc.from("scan_sessions").insert({
    user_id: uid,
    family_id: req.familyId ?? null,
    source_account_id: req.sourceAccountId ?? null,
    source_kind: req.sourceKind,
    root_path_or_source_ref: req.rootPathOrSourceRef,
    scan_mode: req.scanMode,
    status: "running",
    phase: "discovering",
    include_hidden: req.includeHidden,
    follow_symlinks: req.followSymlinks,
    max_depth: req.maxDepth ?? null,
    enable_hashing: req.enableHashing,
    enable_perceptual_hash: req.enablePerceptualHash,
    enable_video_fingerprint: req.enableVideoFingerprint,
    enable_document_text_extraction: req.enableDocumentTextExtraction,
    enable_ocr_preparation: req.enableOcrPreparation,
    enable_ai_enrichment: req.enableAiEnrichment,
    enable_face_processing: req.enableFaceProcessing,
    ai_processing_consent: req.aiProcessingConsent,
    face_processing_consent: req.faceProcessingConsent,
    batch_size: req.batchSize,
    concurrency: req.concurrency,
    started_at: new Date().toISOString(),
  }).select("*").single();
  if (error) throw new ApiError("internal", error.message);

  return c.json({ scan: data }, 201);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/:id
// ─────────────────────────────────────────────────────────────────────────────
app.get("/v1/:id", async (c) => {
  const uid = c.get("userId");
  const { id } = parseParams(c, IdParam);
  const supa = c.get("supabase");
  const { data, error } = await supa.from("scan_sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw new ApiError("internal", error.message);
  if (!data || data.user_id !== uid) throw new ApiError("not_found", "Scan not found");
  return c.json({ scan: data });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/:id/progress
// ─────────────────────────────────────────────────────────────────────────────
app.get("/v1/:id/progress", async (c) => {
  const uid = c.get("userId");
  const { id } = parseParams(c, IdParam);
  const supa = c.get("supabase");
  const { data, error } = await supa.from("scan_sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw new ApiError("internal", error.message);
  if (!data || data.user_id !== uid) throw new ApiError("not_found", "Scan not found");
  const supported = data.supported_files ?? 0;
  const processed = data.processed_files ?? 0;
  const pct = supported > 0 ? Math.min(100, Math.round((processed / supported) * 100)) : null;
  const progress: ScanProgress = {
    scanId: data.id,
    status: data.status,
    phase: data.phase,
    discoveredFiles: data.discovered_files ?? 0,
    supportedFiles: supported,
    processedFiles: processed,
    skippedFiles: data.skipped_files ?? 0,
    errorFiles: data.error_files ?? 0,
    currentPathRedacted: data.current_path_redacted,
    percentComplete: pct,
    startedAt: data.started_at,
    updatedAt: data.updated_at,
    cancellationRequested: data.cancellation_requested ?? false,
  };
  return c.json({ progress });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/:id/batch
// ─────────────────────────────────────────────────────────────────────────────
app.post("/v1/:id/batch", async (c) => {
  const uid = c.get("userId");
  const { id } = parseParams(c, IdParam);
  const svc = getServiceClient();

  const { data: sess } = await svc.from("scan_sessions")
    .select("user_id, source_account_id, status, cancellation_requested").eq("id", id).maybeSingle();
  if (!sess || sess.user_id !== uid) throw new ApiError("not_found", "Scan not found");
  if (sess.cancellation_requested || sess.status === "cancelled") {
    return c.json({ summary: null, cancelled: true }, 409);
  }

  const body = await parseBody(c, MetadataBatchSchema);
  if (body.scanId !== id) throw new ApiError("validation_failed", "scanId mismatch");

  const summary = await ingestBatch(svc, uid, id, sess.source_account_id, body);
  return c.json({ summary });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/:id/cancel
// ─────────────────────────────────────────────────────────────────────────────
app.post("/v1/:id/cancel", async (c) => {
  const uid = c.get("userId");
  const { id } = parseParams(c, IdParam);
  const svc = getServiceClient();
  const { data: sess } = await svc.from("scan_sessions").select("user_id").eq("id", id).maybeSingle();
  if (!sess || sess.user_id !== uid) throw new ApiError("not_found", "Scan not found");
  await svc.from("scan_sessions").update({
    cancellation_requested: true,
    status: "cancelled",
    cancelled_at: new Date().toISOString(),
    phase: "cancelled",
  }).eq("id", id);
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/:id/resume
// ─────────────────────────────────────────────────────────────────────────────
app.post("/v1/:id/resume", async (c) => {
  const uid = c.get("userId");
  const { id } = parseParams(c, IdParam);
  const svc = getServiceClient();
  const { data: sess } = await svc.from("scan_sessions").select("user_id, status").eq("id", id).maybeSingle();
  if (!sess || sess.user_id !== uid) throw new ApiError("not_found", "Scan not found");
  if (sess.status === "completed") throw new ApiError("conflict", "Scan already completed");
  await svc.from("scan_sessions").update({
    cancellation_requested: false,
    status: "running",
    phase: "extracting",
  }).eq("id", id);
  const { data: cp } = await svc.from("scan_checkpoints").select("*").eq("scan_id", id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return c.json({ ok: true, checkpoint: cp ?? null });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/:id/finalize
// ─────────────────────────────────────────────────────────────────────────────
app.post("/v1/:id/finalize", async (c) => {
  const uid = c.get("userId");
  const { id } = parseParams(c, IdParam);
  const svc = getServiceClient();
  const { data: sess } = await svc.from("scan_sessions").select("user_id").eq("id", id).maybeSingle();
  if (!sess || sess.user_id !== uid) throw new ApiError("not_found", "Scan not found");
  await svc.from("scan_sessions").update({
    status: "completed", phase: "completed",
    completed_at: new Date().toISOString(),
  }).eq("id", id);
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/:id/checkpoint
// ─────────────────────────────────────────────────────────────────────────────
app.post("/v1/:id/checkpoint", async (c) => {
  const uid = c.get("userId");
  const { id } = parseParams(c, IdParam);
  const svc = getServiceClient();
  const { data: sess } = await svc.from("scan_sessions").select("user_id").eq("id", id).maybeSingle();
  if (!sess || sess.user_id !== uid) throw new ApiError("not_found", "Scan not found");
  const body = await parseBody(c, ScanCheckpointSchema.omit({ scanId: true, userId: true }));
  const { data, error } = await svc.from("scan_checkpoints").insert({
    scan_id: id, user_id: uid,
    checkpoint_type: body.checkpointType ?? "auto",
    directory_queue: body.directoryQueue ?? [],
    provider_cursor: body.providerCursor ?? null,
    last_processed_path: body.lastProcessedPath ?? null,
    last_processed_source_asset_id: body.lastProcessedSourceAssetId ?? null,
    batch_sequence: body.batchSequence ?? 0,
    current_phase: body.currentPhase ?? null,
    checkpoint_payload: body.checkpointPayload ?? {},
  }).select("id, created_at").single();
  if (error) throw new ApiError("internal", error.message);
  return c.json({ checkpoint: data });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/:id/errors
// ─────────────────────────────────────────────────────────────────────────────
app.get("/v1/:id/errors", async (c) => {
  const uid = c.get("userId");
  const { id } = parseParams(c, IdParam);
  const supa = c.get("supabase");
  const q = parseQuery(c, z.object({ limit: z.string().optional() }));
  const limit = Math.min(parseInt(q.limit ?? "100", 10) || 100, 500);
  const { data, error } = await supa.from("scan_errors").select("*")
    .eq("scan_id", id).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new ApiError("internal", error.message);
  return c.json({ errors: data ?? [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/:id/results
// ─────────────────────────────────────────────────────────────────────────────
app.get("/v1/:id/results", async (c) => {
  const uid = c.get("userId");
  const { id } = parseParams(c, IdParam);
  const supa = c.get("supabase");
  const { data: sess } = await supa.from("scan_sessions")
    .select("source_account_id, started_at").eq("id", id).maybeSingle();
  if (!sess) throw new ApiError("not_found", "Scan not found");
  let q = supa.from("asset_source_refs").select("asset_id, source_asset_id, last_seen_at")
    .eq("user_id", uid).order("last_seen_at", { ascending: false }).limit(200);
  if (sess.source_account_id) q = q.eq("source_account_id", sess.source_account_id);
  if (sess.started_at) q = q.gte("last_seen_at", sess.started_at);
  const { data, error } = await q;
  if (error) throw new ApiError("internal", error.message);
  return c.json({ results: data ?? [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/assets/:assetId/metadata
// ─────────────────────────────────────────────────────────────────────────────
app.get("/v1/assets/:assetId/metadata", async (c) => {
  const uid = c.get("userId");
  const { assetId } = parseParams(c, AssetIdParam);
  const supa = c.get("supabase");
  const [
    asset, fs, media, exif, gps, xmp, video, doc, audio, hashes, preview, ai, org, refs,
  ] = await Promise.all([
    supa.from("assets").select("*").eq("id", assetId).maybeSingle(),
    supa.from("asset_file_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_media_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_exif").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_gps").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_xmp_iptc").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_video_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_document_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_audio_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_hashes").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_preview_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_ai_ready_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_organization_signals").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_source_refs").select("*").eq("asset_id", assetId),
  ]);
  if (!asset.data || asset.data.user_id !== uid) throw new ApiError("not_found", "Asset not found");
  return c.json({
    asset: asset.data,
    fileSystem: fs.data,
    media: media.data,
    exif: exif.data,
    gps: gps.data,
    xmpIptc: xmp.data,
    video: video.data,
    document: doc.data,
    audio: audio.data,
    hashes: hashes.data,
    preview: preview.data,
    aiReady: ai.data,
    organization: org.data,
    sources: refs.data ?? [],
  });
});

Deno.serve(app.fetch);