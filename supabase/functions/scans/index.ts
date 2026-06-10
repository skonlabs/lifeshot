// deno-lint-ignore-file no-explicit-any
/**
 * Scans Edge Function — slimmed-down post-B-NUKE.
 *
 * The scan_sessions / scan_batches / scan_errors / scan_checkpoints tables
 * were dropped. Scan sessions are now ephemeral: clients generate their own
 * scan id and POST batches to /v1/:id/batch, which goes straight into the
 * canonical metadata pipeline. Start/progress/finalize/cancel/checkpoint
 * become no-ops that return the data the client already knows.
 */
import { z } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody, parseParams } from "../_shared/validation.ts";
import { ApiError } from "../_shared/errors.ts";
import { getServiceClient } from "../_shared/clients.ts";
import {
  ScanRequestSchema,
  MetadataBatchSchema,
  type ScanProgress,
} from "../../../packages/core/metadata/types.ts";
import { ingestBatch } from "../_metadata/persistence.ts";

const app = createApi("/scans");
authed(app);

const IdParam = z.object({ id: z.string().uuid() });
const AssetIdParam = z.object({ assetId: z.string().uuid() });

function ephemeralProgress(id: string, status = "running"): ScanProgress {
  return {
    scanId: id, status, phase: "extracting",
    discoveredFiles: 0, supportedFiles: 0, processedFiles: 0,
    skippedFiles: 0, errorFiles: 0,
    currentPathRedacted: null, percentComplete: null,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    cancellationRequested: false,
  } as unknown as ScanProgress;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/start
// ─────────────────────────────────────────────────────────────────────────────
app.post("/v1/start", async (c) => {
  await parseBody(c, ScanRequestSchema);
  const id = crypto.randomUUID();
  return c.json({ scan: { id, status: "running", phase: "extracting", started_at: new Date().toISOString() } }, 201);
});

app.get("/v1/:id", async (c) => {
  const { id } = parseParams(c, IdParam);
  return c.json({ scan: { id, status: "running", phase: "extracting" } });
});

app.get("/v1/:id/progress", async (c) => {
  const { id } = parseParams(c, IdParam);
  return c.json({ progress: ephemeralProgress(id) });
});

app.post("/v1/:id/batch", async (c) => {
  const uid = c.get("userId");
  const { id } = parseParams(c, IdParam);
  const svc = getServiceClient();
  const body = await parseBody(c, MetadataBatchSchema);
  if (body.scanId !== id) throw new ApiError("validation_failed", "scanId mismatch");
  // sourceAccountId can no longer be looked up from a session; expect callers
  // to set it inside record.source.sourceAccountId (already in canonical record).
  const summary = await ingestBatch(svc, uid, id, null, body);
  return c.json({ summary });
});

app.post("/v1/:id/cancel", (c) => c.json({ ok: true }));
app.post("/v1/:id/resume", (c) => c.json({ ok: true, checkpoint: null }));
app.post("/v1/:id/finalize", (c) => c.json({ ok: true }));
app.post("/v1/:id/checkpoint", (c) => c.json({ checkpoint: { id: crypto.randomUUID(), created_at: new Date().toISOString() } }));
app.get("/v1/:id/errors", (c) => c.json({ errors: [] }));

app.get("/v1/:id/results", async (c) => {
  const uid = c.get("userId");
  const supa = c.get("supabase");
  const { data, error } = await supa.from("asset_source_refs")
    .select("asset_id, source_asset_id, last_seen_at")
    .eq("user_id", uid).order("last_seen_at", { ascending: false }).limit(200);
  if (error) throw new ApiError("internal", error.message);
  return c.json({ results: data ?? [] });
});

app.get("/v1/assets/:assetId/metadata", async (c) => {
  const uid = c.get("userId");
  const { assetId } = parseParams(c, AssetIdParam);
  const supa = c.get("supabase");
  // Single canonical view post-B-NUKE: assets carries filename/paths/hashes/
  // search content; asset_media_metadata carries thumbnails + derivatives.
  const [asset, media, exif, gps, video, doc, audio, ai, refs] = await Promise.all([
    supa.from("assets").select("*").eq("id", assetId).maybeSingle(),
    supa.from("asset_media_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_exif").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_gps").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_video_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_document_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_audio_metadata").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_ai_enrichment").select("*").eq("asset_id", assetId).maybeSingle(),
    supa.from("asset_source_refs").select("*").eq("asset_id", assetId),
  ]);
  if (!asset.data || asset.data.user_id !== uid) throw new ApiError("not_found", "Asset not found");
  return c.json({
    asset: asset.data,
    fileSystem: {
      filename: asset.data.filename, relative_path: asset.data.relative_path,
      parent_folder_path: asset.data.parent_folder_path, file_size_bytes: asset.data.file_size_bytes,
    },
    media: media.data, exif: exif.data, gps: gps.data,
    video: video.data, document: doc.data, audio: audio.data,
    hashes: { checksum_hash: asset.data.checksum_hash, perceptual_hash: asset.data.perceptual_hash,
              video_fingerprint: asset.data.video_fingerprint },
    preview: media.data ? {
      blurhash: media.data.blurhash, dominant_color: media.data.dominant_color,
      thumbnail_url: media.data.thumbnail_url, preview_url: media.data.preview_url,
    } : null,
    aiEnrichment: ai.data,
    organization: {
      folder_tokens: asset.data.folder_tokens, filename_tokens: asset.data.filename_tokens,
      duplicate_group_id: asset.data.duplicate_group_id, place_id: asset.data.place_id,
    },
    sources: refs.data ?? [],
  });
});

Deno.serve(app.fetch);