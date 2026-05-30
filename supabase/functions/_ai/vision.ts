// deno-lint-ignore-file no-explicit-any
/** Vision enrichment: caption, labels, scene, quality, sensitive flags. */
import { visionStructured, type CallContext } from "./client.ts";
import { aiConfig } from "./config.ts";
import { VISION_PROMPT } from "./prompts.ts";
import { VisionResultZ, VISION_JSON_SCHEMA, type VisionResult } from "./schemas.ts";
import { getVisionCached, setVisionCached } from "./cache.ts";
import { pickVisionModel } from "./cost-guard.ts";

export async function enrichVision(opts: {
  assetId: string;
  imageUrl: string;
  ctx?: CallContext;
  force?: boolean;
}): Promise<VisionResult> {
  const model = await pickVisionModel(opts.ctx?.userId, opts.ctx?.tier);
  if (!opts.force) {
    const hit = await getVisionCached<VisionResult>(opts.assetId, model, aiConfig.promptVersion);
    if (hit) return hit;
  }
  const { data } = await visionStructured<VisionResult>({
    imageUrl: opts.imageUrl,
    model,
    prompt: VISION_PROMPT,
    schema: VISION_JSON_SCHEMA,
    parse: (raw) => VisionResultZ.parse(raw),
    ctx: { ...(opts.ctx ?? {}), assetId: opts.assetId },
    maxTokens: aiConfig.maxTokens.vision,
  });
  await setVisionCached(opts.assetId, model, aiConfig.promptVersion, data);
  return data;
}