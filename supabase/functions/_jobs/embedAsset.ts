// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function embedAsset(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  const { data: asset } = await sb.from("assets").select("id, user_id, thumbnail_url, preview_url, mime_type").eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");

  const vec = await providers.embedder.embedImage({
    url: asset.preview_url ?? asset.thumbnail_url, mime: asset.mime_type,
  });

  await sb.from("asset_embeddings").upsert({
    asset_id, user_id: asset.user_id, model: "mock-clip-384", dim: vec.length, embedding: vec,
  }, { onConflict: "asset_id,model" });

  return { asset_id, dim: vec.length };
}