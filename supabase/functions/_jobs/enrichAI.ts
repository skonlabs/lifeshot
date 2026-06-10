// deno-lint-ignore-file no-explicit-any
import { serviceClient, STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import { installOpenAIProviders } from "../_ai/factory.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { rekognitionConfigured } from "../_ai/rekognition.ts";
import { isUsableFace } from "../_ai/face-quality.ts";

// Safety net: ensure real providers are active when credentials are present.
installOpenAIProviders();

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
  let faceDetectionUrl: string | null = null;

  // For vision captioning a small thumb is fine. For face detection we MUST
  // prefer the larger preview — Rekognition needs faces to be at least ~40px
  // wide to detect, and provider-supplied thumbnails (often 256-512px) are
  // too small. Earlier we used thumbnail_cache_key for faces, which silently
  // caused 0 face detections across the entire library.
  const rawKey = asset.proxy_cache_key ?? asset.thumbnail_cache_key ?? null;
  const rawFaceKey = asset.proxy_cache_key ?? asset.thumbnail_cache_key ?? null;
  if (rawKey && /^https?:\/\//.test(rawKey)) {
    url = rawKey;
  }
  if (rawFaceKey && /^https?:\/\//.test(rawFaceKey)) {
    faceDetectionUrl = rawFaceKey;
  }

  if (!url) {
    // Pull URLs/paths from asset_media_metadata (asset_derivatives dropped).
    const { data: mm } = await sb.from("asset_media_metadata")
      .select("preview_url, preview_storage_path, thumbnail_url, thumbnail_storage_path")
      .eq("asset_id", asset_id).maybeSingle();
    url = mm?.preview_url ?? mm?.thumbnail_url ?? null;
    if (!url) {
      const path = mm?.preview_storage_path ?? mm?.thumbnail_storage_path ?? null;
      if (path) {
        const { data: signed } = await sb.storage.from(STORAGE_BUCKETS.derived).createSignedUrl(path, 600);
        url = signed?.signedUrl ?? null;
      }
    }
  }

  if (!faceDetectionUrl) {
    const { data: mm } = await sb.from("asset_media_metadata")
      .select("preview_url, preview_storage_path, thumbnail_url, thumbnail_storage_path")
      .eq("asset_id", asset_id).maybeSingle();
    // Prefer preview (larger) for face detection; fall back to thumbnail.
    faceDetectionUrl = mm?.preview_url ?? mm?.thumbnail_url ?? null;
    if (!faceDetectionUrl) {
      const path = mm?.preview_storage_path ?? mm?.thumbnail_storage_path ?? null;
      if (path) {
        const { data: signed } = await sb.storage.from(STORAGE_BUCKETS.derived).createSignedUrl(path, 600);
        faceDetectionUrl = signed?.signedUrl ?? null;
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
  if (!faceDetectionUrl && rawFaceKey && !/^https?:\/\//.test(rawFaceKey)) {
    const { data: signed } = await sb.storage
      .from(STORAGE_BUCKETS.derived)
      .createSignedUrl(rawFaceKey, 600);
    faceDetectionUrl = signed?.signedUrl ?? null;
  }

  if (!faceDetectionUrl) faceDetectionUrl = url;

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
    // Record the failure but do not throw — enrichment is best-effort.
  }

  // Face detection — runs server-side via AWS Rekognition when:
  //  (a) the user has opted in to biometric processing, and
  //  (b) the faceDetector provider is installed (AWS keys configured).
  // Gracefully skipped (faces=[]) when either condition is false.
  let faces: Array<Record<string, unknown>> = [];
  let faceScanned = false;
  let faceDetectionAttempted = false;
  try {
    const { data: privacy } = await sb
      .from("privacy_settings")
      .select("face_processing_enabled")
      .eq("user_id", asset.user_id)
      .maybeSingle();
    // Only attempt face detection when we actually have a working backend.
    // Previously we attempted even when Rekognition wasn't configured, the
    // provider silently returned [] (no throw), faceScanned was set to true,
    // and the asset got marked face_scanned_at — permanently skipping it
    // once credentials were added. Gate on rekognitionConfigured() so the
    // asset stays eligible for re-scan until faces are really attempted.
    if (privacy?.face_processing_enabled && faceDetectionUrl && rekognitionConfigured()) {
      faceDetectionAttempted = true;
      const detected = await providers.faceDetector.detectFaces({
        url: faceDetectionUrl,
        userId: asset.user_id,
        assetId: asset_id,
      });
      faceScanned = true;
      // Quality gate: reject low-confidence detections, profile/turned faces,
      // and blurry/dark crops. Without these filters every silhouette and
      // back-of-head Rekognition returns ends up as its own "Person" tile.
      //   - confidence >= 0.6 (0..1 scale; Rekognition confidence/100)
      //   - |Yaw| <= 30°, |Pitch| <= 25°   (roughly frontal)
      //   - Quality.Sharpness >= 35, Quality.Brightness >= 25 (0..100)
      faces = detected
        .filter((f) => isUsableFace({
          confidence: Number(f.confidence ?? 0),
          attributes: (f.attributes ?? null) as Record<string, any> | null,
        }))
        .map((f) => ({
        bbox: f.bbox,
        score: f.confidence,
        description: f.description,
        embedding: f.embedding,
        face_id: f.face_id,
        face_crop: f.face_crop ?? null,
        attributes: f.attributes,
      }));
    }
  } catch (e: any) {
    console.warn("enrichAI face detection failed", { asset_id, error: String(e?.message ?? e) });
    faceScanned = false;
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

  // Mirror the raw Rekognition face payload onto asset_media_metadata.recognition
  // so the UI can read everything off one row per asset.
  if (faceScanned) {
    const recognition = faces.map((f: any) => f.attributes).filter(Boolean);
    await sb.from("asset_media_metadata").upsert({
      asset_id, user_id: asset.user_id,
      recognition: recognition.length ? recognition : [],
    }, { onConflict: "asset_id" });
  }

  // Mark the asset as face-scanned so it isn't reprocessed.
  if (faceDetectionAttempted && faceScanned) {
    await sb.from("assets")
      .update({ face_scanned_at: new Date().toISOString() })
      .eq("id", asset_id);

    if (faces.length > 0) {
      await enqueueJob("clusterPeople", {
        userId: ctx.userId,
        payload: { user_id: asset.user_id, asset_id },
        idempotencyKey: `cluster:${asset_id}`,
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

  return { asset_id, caption_len: caption.length, tags: tags.length, objects: objects.length, error };
}
