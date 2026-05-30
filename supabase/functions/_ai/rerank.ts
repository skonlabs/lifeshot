// deno-lint-ignore-file no-explicit-any
import { chatStructured, type CallContext } from "./client.ts";
import { aiConfig } from "./config.ts";
import { RERANK_SYSTEM } from "./prompts.ts";
import { RerankResultZ, RERANK_JSON_SCHEMA, type RerankResult } from "./schemas.ts";

export interface RerankCandidate { asset_id: string; signal: string; }

export async function rerank(opts: {
  query: string;
  candidates: RerankCandidate[];
  ctx?: CallContext;
}): Promise<RerankResult> {
  const cands = opts.candidates.slice(0, aiConfig.reranker.topK);
  const messages = [
    { role: "system", content: RERANK_SYSTEM },
    { role: "user", content: JSON.stringify({ query: opts.query, candidates: cands }) },
  ];
  const { data } = await chatStructured<RerankResult>({
    model: aiConfig.rerankerModel,
    messages, schema: RERANK_JSON_SCHEMA,
    parse: (raw) => {
      const r = RerankResultZ.parse(raw);
      const allow = new Set(cands.map((c) => c.asset_id));
      r.ordered = r.ordered.filter((x) => allow.has(x.asset_id));
      return r;
    },
    temperature: 0,
    maxTokens: 400,
    ctx: opts.ctx,
  });
  return data;
}