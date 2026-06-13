// deno-lint-ignore-file no-explicit-any
import { serviceClient, STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import { installOpenAIProviders } from "../_ai/factory.ts";
import type { JobContext } from "../_pipeline/runner.ts";

// Safety net: ensure real providers are active when credentials are present.
installOpenAIProviders();

/**
 * ocrAsset — extracts text from an asset via OCR and persists the result to
 * asset_ai_enrichment. After writing, re-enqueues indexSearchDocument so the
 * extracted text is incorporated into FTS immediately.
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

  // Skip non-OCRable media types early to avoid wasting signed URL calls.
  const isOcrMedia = (asset.media_type === "photo" || asset.media_type === "image" ||
    asset.media_type === "document" || (asset.mime_type ?? "").startsWith("image/") ||
    asset.mime_type === "application/pdf");
  if (!isOcrMedia) return { skipped: "not_ocr_media" };

  // Resolve URL — proxy_cache_key / thumbnail_cache_key can be either an
  // https:// URL (provider-served) or a storage path (after generateDerived).
  let url: string | null = null;

  const rawKey = asset.proxy_cache_key ?? asset.thumbnail_cache_key ?? null;
  if (rawKey && /^https?:\/\//.test(rawKey)) {
    url = rawKey;
  }

  if (!url) {
    // asset_derivatives was dropped in B-NUKE; lookup paths/URLs from
    // asset_media_metadata instead.
    const { data: mm } = await sb.from("asset_media_metadata")
      .select("preview_url, preview_storage_path, thumbnail_url, thumbnail_storage_path")
      .eq("asset_id", asset_id).maybeSingle();
    if (mm?.preview_url) url = mm.preview_url;
    else if (mm?.thumbnail_url) url = mm.thumbnail_url;
    else {
      const path = mm?.preview_storage_path ?? mm?.thumbnail_storage_path ?? null;
      if (path) {
        const { data: signed } = await sb.storage.from(STORAGE_BUCKETS.derived).createSignedUrl(path, 600);
        if (signed?.signedUrl) url = signed.signedUrl;
      }
    }
  }

  if (!url && rawKey && !/^https?:\/\//.test(rawKey)) {
    const { data: signed } = await sb.storage
      .from(STORAGE_BUCKETS.derived)
      .createSignedUrl(rawKey, 600);
    url = signed?.signedUrl ?? null;
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
    // asset_ocr was merged into asset_ai_enrichment.
    await sb.from("asset_ai_enrichment").upsert(
      { asset_id, user_id: asset.user_id,
        ocr_text: text, ocr_lang: lang, ocr_at: new Date().toISOString() },
      { onConflict: "asset_id" },
    );

    // Ensure the asset gets indexed. Shares the canonical `index:${asset_id}`
    // key with enrichAI — whichever job finishes first wins and the other
    // is deduplicated by the job ledger. No extra jobs are created.
    if (text.length > 0) {
      const { enqueueJob } = await import("../_pipeline/enqueuer.ts");
      await enqueueJob("indexSearchDocument", {
        userId: ctx.userId,
        payload: { asset_id },
        idempotencyKey: `index:${asset_id}`,
      });
    }
  }

  return { asset_id, chars: text.length, lang, error };
}
