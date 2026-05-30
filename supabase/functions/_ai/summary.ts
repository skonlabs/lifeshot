// deno-lint-ignore-file no-explicit-any
import { chatStructured, type CallContext } from "./client.ts";
import { aiConfig } from "./config.ts";
import { SUMMARY_SYSTEM } from "./prompts.ts";
import { SummaryZ, SUMMARY_JSON_SCHEMA, type Summary } from "./schemas.ts";

export async function summarizeEvent(opts: {
  facts: Record<string, unknown>;
  ctx?: CallContext;
}): Promise<Summary> {
  const { data } = await chatStructured<Summary>({
    model: aiConfig.summaryModel,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: JSON.stringify(opts.facts) },
    ],
    schema: SUMMARY_JSON_SCHEMA,
    parse: (raw) => SummaryZ.parse(raw),
    temperature: aiConfig.temperatures.summary,
    maxTokens: aiConfig.maxTokens.summary,
    ctx: opts.ctx,
  });
  return data;
}