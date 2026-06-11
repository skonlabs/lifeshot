// deno-lint-ignore-file no-explicit-any
import { serviceClient, STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

import { detectFaces } from "../_ai/face-detector.ts";
import { rekognitionConfigured } from "../_ai/rekognition.ts";

/**
 * enrichAI — runs vision analysis + object detection on an asset's derived
 * preview/thumbnail and persists the result to asset_ai_enrichment.
 *
 * Requires:
 *  - User ai_processing_enabled consent (skips gracefully when false)
 *  - A signed preview/thumb URL (from asset_derivatives or cache key)
 *  - OPENAI_API_KEY + LIFESHOT_AI_PROVIDER=openai for real inference;
 *    falls back to mock providers otherwise.
 *
 * After writing AI enrichment, re-enqueues indexSearchDocument so the
 * new caption/tags are incorporated into the FTS index immediately.
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
  // proxy_cache_key / thumbnail_cache_key may be either an https:// URL (from
  // the source provider, before generateDerived uploads to storage) or a
  // storage path (after generateDerived runs). We must create a signed URL for
  // the latter — passing a bare storage path to the AI provider will fail.
  let url: string | null = null;

  const rawKey = asset.proxy_cache_key ?? asset.thumbnail_cache_key ?? null;
  if (rawKey && /^https?:\/\//.test(rawKey)) {
    url = rawKey;
  }

  if (!url) {
    // Try stored derivatives (preview first, then thumb).
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

  // If keys exist but aren't http URLs, try signing the storage path directly.
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

  // Caption and object detection via configured AI provider.
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

  // Face detection via Rekognition IndexFaces (consent + configuration gated).
  // All detected faces are returned (qualityFilter: NONE) — attributes include
  // Pose, Quality, FaceOccluded which clusterPeople uses to pick cover photos.
  let faces: Array<Record<string, unknown>> = [];
  let faceDetectionAttempted = false;
  const { data: privacy } = await sb.from("privacy_settings")
    .select("face_processing_enabled").eq("user_id", asset.user_id).maybeSingle();
  if (privacy?.face_processing_enabled && rekognitionConfigured()) {
    faceDetectionAttempted = true;
    try {
      const detected = await detectFaces({ imageUrl: url, userId: asset.user_id, assetId: asset_id });
      faces = detected.map((f) => ({
        bbox: f.bbox,
        score: f.confidence,
        face_id: f.face_id,
        face_crop: f.face_crop,
        attributes: f.attributes, // full Rekognition FaceDetail (Pose, Quality, etc.)
      }));
    } catch (e: any) {
      console.warn("enrichAI face detection failed", { asset_id, error: String(e?.message ?? e) });
      faceDetectionAttempted = false;
    }
  }

  await sb.from("asset_ai_enrichment").upsert({
    asset_id,
    user_id: asset.user_id,
    caption,
    tags,
    objects,
    faces,
    enriched_at: !error ? new Date().toISOString() : null,
  }, { onConflict: "asset_id" });

  // Mirror the raw Rekognition face payload onto asset_media_metadata so the
  // UI can read everything off one row per asset.
  if (faceDetectionAttempted && faces.length > 0) {
    const recognition = faces.map((f: any) => f.attributes).filter(Boolean);
    await sb.from("asset_media_metadata").upsert({
      asset_id, user_id: asset.user_id,
      recognition: recognition.length ? recognition : [],
    }, { onConflict: "asset_id" });
  }

  // Mark face scan complete only when detection was actually attempted.
  // If Rekognition was not configured or consent was denied, leave face_scanned_at
  // null so the asset remains eligible for face scanning later.
  if (faceDetectionAttempted) {
    await sb.from("assets").update({ face_scanned_at: new Date().toISOString() })
      .eq("id", asset_id);

    if (faces.length > 0) {
      // Enqueue per-asset so every asset's faces get clustered immediately after
      // detection. SearchFaces handles identity matching against the collection,
      // so concurrent per-asset jobs are safe — each one looks up existing people
      // by face_id match rather than relying on a shared in-memory counter.
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

  // Index the search document exactly once per asset, AFTER enrichment data
  // is available. Idempotency key matches ocrAsset's fallback so whichever
  // job finishes first wins and the other is deduplicated by the ledger.
  await enqueueJob("indexSearchDocument", {
    userId: ctx.userId,
    payload: { asset_id },
    idempotencyKey: `index:${asset_id}`,
  });

  return { asset_id, caption_len: caption.length, tags: tags.length, objects: objects.length, faces: faces.length, error };
}
