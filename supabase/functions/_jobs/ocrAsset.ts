// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function ocrAsset(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  const { data: asset } = await sb.from("assets")
    .select("id, thumbnail_cache_key, proxy_cache_key").eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");
  const r = await providers.ocr.extractText({ url: asset.proxy_cache_key ?? asset.thumbnail_cache_key });
  await sb.from("asset_ocr").upsert({ asset_id, text: r.text, lang: r.lang ?? null }, { onConflict: "asset_id" });
  return { asset_id, chars: r.text.length };
}