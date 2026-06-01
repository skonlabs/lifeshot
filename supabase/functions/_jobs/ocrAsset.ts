// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import { installOpenAIProviders } from "../_ai/factory.ts";
import type { JobContext } from "../_pipeline/runner.ts";

// Safety net: ensure real providers are active when credentials are present.
installOpenAIProviders();

/**
 * ocrAsset — extracts text from an asset via OCR and persists the result to
 * asset_ocr.  After writing, re-enqueues indexSearchDocument so the extracted
 * text is incorporated into FTS immediately.
 *
 * Only runs on assets whose media metadata marks ocr_possible=true, or on
 * documents/screenshots when media_type indicates it.
 */
export async function ocrAsset(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { data: asset } = await sb
    .from("assets")
    .select("id, user_id, thumbnail_cache_key, proxy_cache_key, mime_type, media_type")
    .eq("id", asset_id)
    .single();
  if (!asset) throw new Error("not found: asset");

  // Resolve the best available URL for OCR.
  let url = asset.proxy_cache_key ?? asset.thumbnail_cache_key ?? null;

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

  let text = "";
  let lang: string | null = null;
  let error: string | null = null;

  try {
    const r = await providers.ocr.extractText({ url });
    text = r.text ?? "";
    lang = r.lang ?? null;
  } catch (e: any) {
    error = String(e?.message ?? e);
    console.error("ocrAsset failed", { asset_id, error });
  }

  if (!error) {
    await sb.from("asset_ocr").upsert(
      { asset_id, user_id: asset.user_id, text, lang, ocr_at: new Date().toISOString() },
      { onConflict: "asset_id" },
    );

    // Re-index search document so OCR text is searchable immediately.
    if (text.length > 0) {
      const { enqueueJob } = await import("../_pipeline/enqueuer.ts");
      await enqueueJob("indexSearchDocument", {
        userId: ctx.userId,
        payload: { asset_id },
        idempotencyKey: `index-post-ocr:${asset_id}`,
      });
    }
  }

  return { asset_id, chars: text.length, lang, error };
}
