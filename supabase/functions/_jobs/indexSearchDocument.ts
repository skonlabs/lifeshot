// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function indexSearchDocument(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  const { data: asset } = await sb.from("assets")
    .select("id, user_id, capture_time, place_name, device_make, device_model").eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");
  const { data: ai } = await sb.from("asset_ai_enrichment").select("caption, tags").eq("asset_id", asset_id).maybeSingle();
  const { data: ocr } = await sb.from("asset_ocr").select("text").eq("asset_id", asset_id).maybeSingle();

  const text = [
    ai?.caption, (ai?.tags ?? []).join(" "), ocr?.text,
    asset.place_name, asset.device_make, asset.device_model,
  ].filter(Boolean).join(" ");

  await sb.from("asset_search_index").upsert({
    asset_id, user_id: asset.user_id, document: text, captured_at: asset.capture_time,
  }, { onConflict: "asset_id" });
  return { asset_id, chars: text.length };
}