// deno-lint-ignore-file no-explicit-any
import { serviceClient, STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

import { detectFaces } from "../_ai/face-detector.ts";
import { rekognitionConfigured } from "../_ai/rekognition.ts";

/**
 * enrichAI — runs vision analysis + face detection on an asset's derived
 * preview/thumbnail and persists the result to:
 *
 *   asset_ai_enrichment  — caption, tags, objects, faces (summary), rekognition_response
 *   asset_faces          — one row per detected face, with full FaceDetail attributes
 *
 * Face pipeline:
 *   All detected faces are written to asset_faces regardless of quality.
 *   clusterPeople then reads asset_faces and applies its own quality gate
 *   (FaceOccluded=false AND confidence≥90%) before writing to people.
 *
 * Requires:
 *  - User ai_processing_enabled consent (skips gracefully when false)
 *  - A signed preview/thumb URL (from asset_derivatives or cache key)
 *  - OPENAI_API_KEY + LIFESHOT_AI_PROVIDER=openai for real inference;
 *    falls back to mock providers otherwise.
 */
export async function enrichAI(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { enqueueJob } = await import("../_pipeline/enqueuer.ts");

  // Consent gate — respect user's AI processing preference.
  const { data: prof } = await sb
    .from("user_profiles")
    .select("ai_processing_enabled")
    .eq("user_id", ctx.userId!)
    .maybeSingle();
  if (prof && prof.ai_processing_enabled === false) return { skipped: "consent" };

  const { data: asset } = await sb
    .from("assets")
    .select("id, user_id, thumbnail_cache_key, proxy_cache_key, mime_type, media_type")
    .eq("id", asset_id)
    .single();
  if (!asset) throw new Error("not found: asset");

  // Resolve a publicly-accessible URL for the asset image.
  let url: string | null = null;

  const rawKey = asset.proxy_cache_key ?? asset.thumbnail_cache_key ?? null;
  if (rawKey && /^https?:\/\//.test(rawKey)) {
    url = rawKey;
  }

  if (!url) {
    for (const kind of ["preview", "thumb"]) {
      const { data: deriv } = await sb
        .from("asset_derivatives")
        .select("storage_path, storage_bucket")
        .eq("asset_id", asset_id)
        .eq("kind", kind)
        .maybeSingle();
      if (deriv?.storage_path) {
        const { data: signed } = await sb.storage
          .from(deriv.storage_bucket)
          .createSignedUrl(deriv.storage_path, 600);
        if (signed?.signedUrl) { url = signed.signedUrl; break; }
      }
    }
  }

  if (!url && rawKey && !/^https?:\/\//.test(rawKey)) {
    const { data: signed } = await sb.storage
      .from(STORAGE_BUCKETS.derived)
      .createSignedUrl(rawKey, 600);
    url = signed?.signedUrl ?? null;
  }

  if (!url) {
    await enqueueJob("generateDerived", {
      userId: ctx.userId,
      payload: { asset_id },
      idempotencyKey: `derived-retry:${asset_id}`,
    });
    throw new Error("retryable: no preview url available for AI enrichment");
  }

  let caption = "";
  let tags: string[] = [];
  let objects: Array<{ label: string; score: number }> = [];
  let error: string | null = null;

  try {
    const [capResult, objResult] = await Promise.all([
      providers.ai.caption({ url }),
      providers.ai.detectObjects({ url }),
    ]);
    caption = capResult.caption;
    tags = capResult.tags ?? [];
    objects = objResult ?? [];
  } catch (e: any) {
    error = String(e?.message ?? e);
    console.error("enrichAI vision failed", { asset_id, error });
  }

  // ── Face detection ─────────────────────────────────────────────────────────
  // All detected faces are stored in asset_faces (no quality filter here).
  // clusterPeople applies the quality gate (FaceOccluded=false, confidence≥90%)
  // before writing to the people table.
  let faces: Array<Record<string, unknown>> = [];
  let faceDetectionAttempted = false;
  const { data: privacy } = await sb.from("privacy_settings")
    .select("face_processing_enabled").eq("user_id", asset.user_id).maybeSingle();

  if (privacy?.face_processing_enabled && rekognitionConfigured()) {
    faceDetectionAttempted = true;
    try {
      const detected = await detectFaces({ imageUrl: url, userId: asset.user_id, assetId: asset_id });
      faces = detected.map((f) => ({
        bbox:       f.bbox,
        score:      f.confidence,   // 0-1
        face_id:    f.face_id,
        face_crop:  f.face_crop,
        attributes: f.attributes,   // full FaceDetail (Pose, Quality, Landmarks, Emotions, etc.)
      }));

      // Write ALL detected faces to asset_faces with no quality filter.
      // Delete stale rows from a prior scan first so re-scans are idempotent.
      await sb.from("asset_faces").delete().eq("asset_id", asset_id);
      if (detected.length > 0) {
        await sb.from("asset_faces").insert(
          detected.map((f) => ({
            asset_id,
            user_id:    asset.user_id,
            face_id:    f.face_id ?? null,
            bbox:       f.bbox ?? null,
            confidence: f.confidence ?? null,   // 0-1
            face_crop:  f.face_crop ?? null,
            attributes: f.attributes ?? null,   // full Rekognition FaceDetail JSON
          })),
        );
      }
    } catch (e: any) {
      console.warn("enrichAI face detection failed", { asset_id, error: String(e?.message ?? e) });
      faceDetectionAttempted = false;
    }
  }

  // Persist AI enrichment. rekognition_response stores the full face attributes
  // array so the raw Rekognition data is always available from this table.
  await sb.from("asset_ai_enrichment").upsert({
    asset_id,
    user_id: asset.user_id,
    caption,
    tags,
    objects,
    faces,
    rekognition_response: faceDetectionAttempted && faces.length > 0 ? faces : null,
    enriched_at: !error ? new Date().toISOString() : null,
  }, { onConflict: "asset_id" });

  // Mark face scan complete only when detection was actually attempted.
  if (faceDetectionAttempted) {
    await sb.from("assets").update({ face_scanned_at: new Date().toISOString() })
      .eq("id", asset_id);

    if (faces.length > 0) {
      await enqueueJob("clusterPeople", {
        userId: ctx.userId,
        payload: { user_id: asset.user_id, asset_id },
        idempotencyKey: `people-cluster:${asset_id}`,
      });
    }
  }

  if (error) {
    throw new Error(`retryable: AI enrichment failed for ${asset_id}: ${error}`);
  }

  await enqueueJob("indexSearchDocument", {
    userId: ctx.userId,
    payload: { asset_id },
    idempotencyKey: `index:${asset_id}`,
  });

  return {
    asset_id,
    caption_len: caption.length,
    tags: tags.length,
    objects: objects.length,
    faces: faces.length,
    error,
  };
}
