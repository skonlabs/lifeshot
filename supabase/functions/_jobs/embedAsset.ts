// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function embedAsset(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  const { data: asset } = await sb.from("assets")
    .select("id, user_id, thumbnail_cache_key, proxy_cache_key, mime_type").eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");
  const raw = await providers.embedder.embedImage({
    url: asset.proxy_cache_key ?? asset.thumbnail_cache_key, mime: asset.mime_type,
  });
  // Schema column is vector(1536); pad mock 384-dim output to 1536.
  const vec = new Array(1536).fill(0);
  for (let i = 0; i < raw.length && i < 1536; i++) vec[i] = raw[i];
  await sb.from("asset_embeddings").upsert({
    asset_id, model: "mock-clip-1536", dim: 1536, embedding: vec,
  }, { onConflict: "asset_id,model" });

  return { asset_id, dim: vec.length };
}