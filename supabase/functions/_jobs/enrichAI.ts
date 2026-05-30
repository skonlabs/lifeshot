// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function enrichAI(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  // Consent gate
  const { data: prof } = await sb.from("user_profiles").select("ai_processing_enabled").eq("user_id", ctx.userId!).maybeSingle();
  if (prof && prof.ai_processing_enabled === false) return { skipped: "consent" };

  const { data: asset } = await sb.from("assets").select("id, thumbnail_url, preview_url").eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");

  const cap = await providers.ai.caption({ url: asset.preview_url ?? asset.thumbnail_url });
  const obj = await providers.ai.detectObjects({ url: asset.preview_url ?? asset.thumbnail_url });

  await sb.from("asset_ai_enrichment").upsert({
    asset_id, caption: cap.caption, tags: cap.tags, objects: obj,
  }, { onConflict: "asset_id" });
  return { asset_id, tags: cap.tags.length, objects: obj.length };
}