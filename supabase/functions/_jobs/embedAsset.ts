// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import { installOpenAIProviders } from "../_ai/factory.ts";
import type { JobContext } from "../_pipeline/runner.ts";

// Ensure real providers are active when credentials are present.
// This is a safety net; worker/index.ts also calls this at startup.
installOpenAIProviders();

const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536-dim, matches schema vector(1536)

/**
 * embedAsset — generates a 1536-dim embedding for an asset and stores it in
 * asset_embeddings for use by hybrid_search (vector similarity path).
 *
 * Embedding strategy (richest text wins):
 *   1. asset_search_documents.content  — most information-dense
 *   2. asset_ai_enrichment caption+tags — if search doc not yet built
 *   3. Fallback to asset proxy/thumb URL string (weak signal, mock-compatible)
 *
 * The schema expects vector(1536) and HNSW index uses cosine ops.
 * When real OpenAI providers are installed, text-embedding-3-small produces
 * exactly 1536-dim unit vectors — no padding or truncation needed.
 */
export async function embedAsset(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { data: asset } = await sb
    .from("assets")
    .select("id, user_id, thumbnail_cache_key, proxy_cache_key, mime_type, media_type, capture_time, device_make")
    .eq("id", asset_id)
    .single();
  if (!asset) throw new Error("not found: asset");

  // Build the richest available text representation for embedding.
  let embedText: string | null = null;

  // 1. Prefer the pre-built search document content.
  const { data: sdoc } = await sb
    .from("asset_search_documents")
    .select("content")
    .eq("asset_id", asset_id)
    .maybeSingle();
  if (sdoc?.content && sdoc.content.length > 20) {
    embedText = sdoc.content;
  }

  // 2. Fall back to AI enrichment data.
  if (!embedText) {
    const { data: ai } = await sb
      .from("asset_ai_enrichment")
      .select("caption, tags")
      .eq("asset_id", asset_id)
      .maybeSingle();
    if (ai?.caption) {
      const tagStr = Array.isArray(ai.tags) ? ai.tags.join(" ") : "";
      embedText = [ai.caption, tagStr].filter(Boolean).join(" ");
    }
  }

  // 3. Fall back to minimal metadata string (works with mock embedder too).
  if (!embedText) {
    embedText = [
      asset.media_type,
      asset.mime_type,
      asset.device_make,
      asset.capture_time ? new Date(asset.capture_time).getFullYear().toString() : null,
      asset.proxy_cache_key ?? asset.thumbnail_cache_key,
    ].filter(Boolean).join(" ");
  }

  const raw = await providers.embedder.embedText(embedText!);

  // Validate vector dimension — must match schema vector(1536).
  if (raw.length !== 1536) {
    // Only pad when using the mock embedder (384-dim seeded vector). Real OpenAI
    // text-embedding-3-small returns exactly 1536. Log a warning so operators notice.
    if (raw.length !== 384) {
      console.warn(`embedAsset: unexpected embedding dim ${raw.length} for ${asset_id}; expected 1536`);
    }
    const vec = new Array(1536).fill(0);
    for (let i = 0; i < raw.length && i < 1536; i++) vec[i] = raw[i];
    await sb.from("asset_embeddings").upsert(
      { asset_id, user_id: asset.user_id, model: "mock-384-padded", dim: 1536, embedding: vec },
      { onConflict: "asset_id,model" },
    );
    return { asset_id, dim: 1536, model: "mock-384-padded", text_chars: embedText!.length };
  }

  await sb.from("asset_embeddings").upsert(
    { asset_id, user_id: asset.user_id, model: EMBEDDING_MODEL, dim: 1536, embedding: raw },
    { onConflict: "asset_id,model" },
  );
  return { asset_id, dim: 1536, model: EMBEDDING_MODEL, text_chars: embedText!.length };
}
