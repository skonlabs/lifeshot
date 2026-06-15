// deno-lint-ignore-file no-explicit-any
import { serviceClient, STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

import { rekognitionConfigured } from "../_ai/rekognition.ts";
import { checkFaceResetGuard } from "./faceResetGuard.ts";
import {
  analyzeAssetFaces,
  parseDetectedFaces,
  storeFaceResults,
} from "../_ai/face-pipeline.ts";

export async function enrichAI(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id, sync_run_id, force_sync_run_id } = ctx.payload as {
    asset_id: string;
    sync_run_id?: string;
    force_sync_run_id?: string;
  };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { enqueueJob } = await import("../_pipeline/enqueuer.ts");

  const { data: asset, error: assetErr } = await sb
    .from("assets")
    .select("id, user_id, thumbnail_cache_key, proxy_cache_key, mime_type, media_type")
    .eq("id", asset_id)
    .maybeSingle();
  // Use a retryable error so the runner doesn't dead-letter on transient DB issues.
  // Legitimate "asset deleted" cases will exhaust max_attempts naturally.
  if (assetErr) throw new Error(`retryable: asset lookup failed: ${assetErr.message}`);
  if (!asset) throw new Error("retryable: asset not ready yet");

  // Videos cannot be processed by Rekognition IndexFaces (image-only API).
  // Store a minimal enrichment record and exit — face detection is skipped entirely.
  const isVideo = asset.media_type === "video" || (asset.mime_type ?? "").startsWith("video/");
  if (isVideo) {
    await sb.from("asset_ai_enrichment").upsert(
      { asset_id, user_id: asset.user_id, face_count: 0 },
      { onConflict: "asset_id", ignoreDuplicates: true },
    );
    return { asset_id, skipped: "video" };
  }

  const { data: privacy } = await sb
    .from("privacy_settings")
    .select("face_pipeline_reset_at")
    .eq("user_id", asset.user_id)
    .maybeSingle();
  const resetGuard = await checkFaceResetGuard(sb, {
    userId: asset.user_id,
    jobId: ctx.jobId,
    resetAt: privacy?.face_pipeline_reset_at ?? null,
  });
  if (!resetGuard.valid) {
    return { asset_id, skipped: resetGuard.reason };
  }

  // ── Resolve image URLs (original / preview / thumbnail) ────────────────────
  async function signDerivative(kind: "preview" | "thumb"): Promise<string | null> {
    const { data: mm } = await sb
      .from("asset_media_metadata")
      .select("preview_url, preview_storage_path, thumbnail_url, thumbnail_storage_path")
      .eq("asset_id", asset_id)
      .maybeSingle();
    const directUrl = kind === "preview" ? mm?.preview_url : mm?.thumbnail_url;
    if (directUrl && /^https?:\/\//.test(directUrl)) return directUrl;
    const storagePath = kind === "preview" ? mm?.preview_storage_path : mm?.thumbnail_storage_path;
    if (!storagePath) return null;
    const { data: signed } = await sb.storage
      .from(STORAGE_BUCKETS.derived)
      .createSignedUrl(storagePath, 600);
    return signed?.signedUrl ?? null;
  }

  async function resolveKey(key: string | null): Promise<string | null> {
    if (!key) return null;
    if (/^https?:\/\//.test(key)) return key;
    const { data: signed } = await sb.storage
      .from(STORAGE_BUCKETS.derived)
      .createSignedUrl(key, 600);
    return signed?.signedUrl ?? null;
  }

  const originalImageUrl  = await resolveKey(asset.proxy_cache_key);
  const previewImageUrl   = await signDerivative("preview");
  const thumbnailImageUrl = (await resolveKey(asset.thumbnail_cache_key)) ?? (await signDerivative("thumb"));

  const url = previewImageUrl ?? thumbnailImageUrl ?? originalImageUrl;
  if (!url) {
    await enqueueJob("generateDerived", {
      userId: ctx.userId,
      payload: { asset_id },
      idempotencyKey: `derived-retry:${asset_id}`,
    });
    throw new Error("retryable: no preview url available for AI enrichment");
  }

  // ── Ensure asset_ai_enrichment row exists before any processing ───────────
  // This upsert is intentionally minimal and runs unconditionally so that
  // every active asset always has a record — even if vision or face detection
  // fails. Subsequent upserts below fill in caption/tags/faces as they succeed.
  await sb.from("asset_ai_enrichment").upsert(
    { asset_id, user_id: asset.user_id },
    { onConflict: "asset_id", ignoreDuplicates: true },
  );

  // ── Vision analysis (caption + tags + objects) ─────────────────────────────
  let caption = "";
  let tags: string[] = [];
  let visionError: string | null = null;

  try {
    const capResult = await providers.ai.caption({ url });
    caption = capResult.caption;
    tags = capResult.tags ?? [];
  } catch (e: any) {
    visionError = String(e?.message ?? e);
    console.error("enrichAI: vision failed", { asset_id, error: visionError });
  }

  // ── Face detection & storage (face-pipeline.ts) ────────────────────────────
  //   1. analyzeAssetFaces   — Rekognition IndexFaces, raw face JSON
  //   2. parseDetectedFaces  — one parsed JSON object per face (with crop)
  //   5. storeFaceResults    — asset_ai_enrichment + asset_faces + people
  //      (applies qualifyFaceForPerson and findBestPersonMatch per face)
  if (!rekognitionConfigured()) {
    console.warn("enrichAI: Rekognition not configured — face detection skipped", { asset_id });
    // Write face_count=0 so NULL always means "not yet processed / needs re-run".
    // A future force sync will re-run this job with Rekognition configured and
    // overwrite with the real count.
    await sb.from("asset_ai_enrichment").upsert(
      { asset_id, user_id: asset.user_id, face_count: 0 },
      { onConflict: "asset_id" },
    );
  } else {
    const analysis = await analyzeAssetFaces({
      originalImageUrl,
      previewImageUrl,
      thumbnailImageUrl,
      assetId: asset_id,
      userId: asset.user_id,
    });

    if (analysis) {
      const rawFaces = analysis.faceRecords;
      console.log(`enrichAI: Rekognition returned ${rawFaces.length} face(s) for asset ${asset_id}`);

      const parsed = await parseDetectedFaces(analysis);
      const postParseResetGuard = await checkFaceResetGuard(sb, {
        userId: asset.user_id,
        jobId: ctx.jobId,
        resetAt: privacy?.face_pipeline_reset_at ?? null,
      });
      if (!postParseResetGuard.valid) {
        return { asset_id, skipped: postParseResetGuard.reason };
      }
      const stored = await storeFaceResults({
        analysis,
        faces: parsed,
        beforeWrite: async () => {
          const guard = await checkFaceResetGuard(sb, {
            userId: asset.user_id,
            jobId: ctx.jobId,
            resetAt: privacy?.face_pipeline_reset_at ?? null,
          });
          if (!guard.valid) throw new Error(`invalid: ${guard.reason}`);
        },
      });
      console.log(`enrichAI: stored ${stored.asset_faces} face row(s) to asset_faces for asset ${asset_id}`);

      const preFaceWriteResetGuard = await checkFaceResetGuard(sb, {
        userId: asset.user_id,
        jobId: ctx.jobId,
        resetAt: privacy?.face_pipeline_reset_at ?? null,
      });
      if (!preFaceWriteResetGuard.valid) {
        return { asset_id, skipped: preFaceWriteResetGuard.reason };
      }

      // Write faces/face_count ONLY when face detection actually ran successfully
      // this invocation. Otherwise we'd wipe previously-good face data on a re-run
      // where Rekognition was momentarily unconfigured or unreachable.
      const { error: facesUpsertErr } = await sb.from("asset_ai_enrichment").upsert({
        asset_id,
        user_id:    asset.user_id,
        faces:      rawFaces,
        face_count: rawFaces.length,
      }, { onConflict: "asset_id" });
      if (facesUpsertErr) {
        console.error("enrichAI: asset_ai_enrichment faces upsert failed", { asset_id, error: facesUpsertErr.message });
      }
    }

    const preFinalizeResetGuard = await checkFaceResetGuard(sb, {
      userId: asset.user_id,
      jobId: ctx.jobId,
      resetAt: privacy?.face_pipeline_reset_at ?? null,
    });
    if (!preFinalizeResetGuard.valid) {
      return { asset_id, skipped: preFinalizeResetGuard.reason };
    }

    await sb.from("assets").update({ face_scanned_at: new Date().toISOString() }).eq("id", asset_id);

    // Enqueue clusterPeople so the People page is updated promptly.
    // Use a 5-minute time-window key so clusterPeople re-enqueues throughout a
    // long force sync. A per-run key caused a race: the first enrichAI to
    // complete would enqueue clusterPeople, it would run and write a ledger
    // entry, then ALL remaining enrichAI completions found the ledger entry and
    // skipped re-enqueueing — so faces from later assets were never clustered.
    const fiveMinuteBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const reclusterScope = `${fiveMinuteBucket}`;

    await enqueueJob("clusterPeople", {
      userId: asset.user_id,
      payload: { user_id: asset.user_id, asset_id },
      idempotencyKey: `people:${asset.user_id}:${reclusterScope}`,
    });
  }

  const preEnrichmentWriteResetGuard = await checkFaceResetGuard(sb, {
    userId: asset.user_id,
    jobId: ctx.jobId,
    resetAt: privacy?.face_pipeline_reset_at ?? null,
  });
  if (!preEnrichmentWriteResetGuard.valid) {
    return { asset_id, skipped: preEnrichmentWriteResetGuard.reason };
  }

  // ── Retryable vision failure: throw before writing partial data ───────────
  // The asset_ai_enrichment row already exists (written above). Throw here so
  // the runner retries and the row is updated with real data on success.
  if (visionError) {
    const permanent = /invalid_image_format|unsupported image|image_parse_error|invalid image|circuit breaker open/i.test(visionError);
    if (permanent) {
      console.warn("enrichAI: permanent vision failure — not retrying", { asset_id, visionError });
      // Still write empty caption/tags so the row is complete.
      await sb.from("asset_ai_enrichment").upsert({
        asset_id, user_id: asset.user_id, caption: "", tags: [] as unknown as string,
      }, { onConflict: "asset_id" });
      return { asset_id, caption_len: 0, tags: 0, vision_skipped: visionError.slice(0, 200) };
    }
    throw new Error(`retryable: AI enrichment failed for ${asset_id}: ${visionError}`);
  }

  // ── Persist caption/tags to asset_ai_enrichment ───────────────────────────
  // faces/face_count are written separately above inside the face detection
  // block so a run where Rekognition is skipped does not overwrite previously
  // detected faces with an empty array.
  const { error: upsertErr } = await sb.from("asset_ai_enrichment").upsert({
    asset_id,
    user_id: asset.user_id,
    caption,
    tags:    tags as unknown as string,
  }, { onConflict: "asset_id" });
  if (upsertErr) {
    console.error("enrichAI: asset_ai_enrichment upsert failed", { asset_id, error: upsertErr.message });
  }

  await enqueueJob("indexSearchDocument", {
    userId: ctx.userId,
    payload: { asset_id },
    idempotencyKey: `index:${asset_id}`,
  });

  return {
    asset_id,
    caption_len: caption.length,
    tags:        tags.length,
  };
}
