// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
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

  // Prefer the higher-resolution preview derivative over thumbnail.
  let url = asset.proxy_cache_key ?? asset.thumbnail_cache_key ?? null;

  // Look up stored derivatives for a better URL.
  if (!url) {
    const { data: deriv } = await sb
      .from("asset_derivatives")
      .select("storage_path, storage_bucket")
      .eq("asset_id", asset_id)
      .eq("kind", "preview")
      .maybeSingle();
    if (deriv?.storage_path) {
      const { data: signed } = await sb.storage
        .from(deriv.storage_bucket)
        .createSignedUrl(deriv.storage_path, 600);
      url = signed?.signedUrl ?? null;
    }
  }

  if (!url) return { skipped: "no_url" };

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

  if (!error) {
    await sb.from("asset_ai_enrichment").upsert({
      asset_id,
      user_id: asset.user_id,
      caption,
      tags,
      objects,
      enriched_at: new Date().toISOString(),
    }, { onConflict: "asset_id" });

    // Re-index search document now that caption/tags are available.
    const { enqueueJob } = await import("../_pipeline/enqueuer.ts");
    await enqueueJob("indexSearchDocument", {
      userId: ctx.userId,
      payload: { asset_id },
      idempotencyKey: `index-post-ai:${asset_id}`,
    });
  }

  return { asset_id, caption_len: caption.length, tags: tags.length, objects: objects.length, error };
}
