// deno-lint-ignore-file no-explicit-any
import { serviceClient, STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import { installOpenAIProviders } from "../_ai/factory.ts";
import type { JobContext } from "../_pipeline/runner.ts";

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
  let detectedFaces: Array<{ bbox: { x: number; y: number; w: number; h: number } | null; description: string; confidence: number; embedding: number[] | null }> = [];

  try {
    const [capResult, objResult, faceResult] = await Promise.all([
      providers.ai.caption({ url }),
      providers.ai.detectObjects({ url }),
      providers.faceDetector.detectFaces({ url }),
    ]);
    caption = capResult.caption;
    tags = capResult.tags ?? [];
    objects = objResult ?? [];
    detectedFaces = faceResult ?? [];
  } catch (e: any) {
    error = String(e?.message ?? e);
    console.error("enrichAI vision failed", { asset_id, error });
    // Record the failure but do not throw — enrichment is best-effort.
  }

  // Map detected faces to the storage format. Each face has a real bbox
  // (from GPT-4o Vision) and a 512-dim embedding of its description text.
  const faces = detectedFaces.map((f) => ({
    bbox: f.bbox ?? null,
    score: f.confidence ?? null,
    description: f.description ?? null,
    embedding: f.embedding ?? null,
  }));

  await sb.from("asset_ai_enrichment").upsert({
    asset_id,
    user_id: asset.user_id,
    caption,
    tags,
    objects,
    faces,
    enriched_at: !error ? new Date().toISOString() : null,
  }, { onConflict: "asset_id" });

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
