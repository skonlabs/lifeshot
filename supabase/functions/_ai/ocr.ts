// deno-lint-ignore-file no-explicit-any
/** Cheap OCR via vision-capable chat with structured output. */
import { visionStructured, type CallContext } from "./client.ts";
import { aiConfig } from "./config.ts";
import { OCR_PROMPT } from "./prompts.ts";
import { OcrResultZ, OCR_JSON_SCHEMA, type OcrResult } from "./schemas.ts";

export async function ocrImage(opts: { imageUrl: string; ctx?: CallContext }): Promise<OcrResult> {
  const { data } = await visionStructured<OcrResult>({
    imageUrl: opts.imageUrl,
    model: aiConfig.visionModel,
    prompt: OCR_PROMPT,
    schema: OCR_JSON_SCHEMA,
    parse: (raw) => OcrResultZ.parse(raw),
    ctx: opts.ctx,
    maxTokens: 800,
  });
  return data;
}