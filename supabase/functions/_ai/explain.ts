// deno-lint-ignore-file no-explicit-any
/** Search-result explanation grounded only in provided rows. */
import { chatStructured, type CallContext } from "./client.ts";
import { aiConfig } from "./config.ts";
import { EXPLAIN_SYSTEM } from "./prompts.ts";
import { ExplanationZ, EXPLAIN_JSON_SCHEMA, type Explanation } from "./schemas.ts";

export interface ExplainRow {
  asset_id: string;
  capture_time?: string | null;
  place?: string | null;
  source?: string | null;
  semantic_score?: number | null;
  text_snippet?: string | null;
}

export async function explainResults(opts: {
  query: string;
  rows: ExplainRow[];
  ctx?: CallContext;
}): Promise<Explanation> {
  const messages = [
    { role: "system", content: EXPLAIN_SYSTEM },
    { role: "user", content: JSON.stringify({ query: opts.query, rows: opts.rows.slice(0, 20) }) },
  ];
  const { data } = await chatStructured<Explanation>({
    model: aiConfig.explainModel,
    messages,
    schema: EXPLAIN_JSON_SCHEMA,
    parse: (raw) => ExplanationZ.parse(raw),
    temperature: aiConfig.temperatures.explain,
    maxTokens: aiConfig.maxTokens.explain,
    ctx: opts.ctx,
  });
  return data;
}