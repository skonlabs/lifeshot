// deno-lint-ignore-file no-explicit-any
/**
 * Central AI config. All model IDs, dimensions, caps, and feature flags live
 * here so callers never hardcode. DIM MUST match the backend asset_embeddings
 * vector column (1536 for text-embedding-3-small).
 */
export type Tier = "free" | "pro" | "premium";

export interface AIConfig {
  // Models (pinned IDs; verify availability at deploy time).
  embeddingModel: string;
  embeddingDim: number;
  visionModel: string;
  parserModel: string;
  explainModel: string;
  summaryModel: string;
  rerankerModel: string;

  // Behavior.
  reranker: { enabled: boolean; topK: number; tiers: Tier[] };

  // Limits.
  temperatures: { parser: number; explain: number; caption: number; summary: number };
  maxTokens: { parser: number; explain: number; caption: number; summary: number; vision: number };
  timeoutMs: number;
  retries: { max: number; baseMs: number; capMs: number };

  // Cost (USD).
  costPerKToken: Record<string, { input: number; output: number }>;
  costPerKTokenEmbed: Record<string, number>;
  caps: { dailyUsd: Record<Tier, number>; monthlyUsd: Record<Tier, number>; perCallUsd: number };

  // Caches.
  ttl: { searchSec: number; explainSec: number };

  // Batching.
  embedBatchSize: number;

  // Privacy/ZDR.
  zdr: boolean;

  // Prompt versioning (bumping invalidates vision cache).
  promptVersion: string;
}

const env = (k: string, d?: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : process.env?.[k]) ?? d;

export const aiConfig: AIConfig = {
  embeddingModel: env("AI_EMBED_MODEL", "text-embedding-3-small")!,
  embeddingDim:   Number(env("AI_EMBED_DIM", "1536")),
  visionModel:    env("AI_VISION_MODEL", "gpt-4o-mini")!,
  parserModel:    env("AI_PARSER_MODEL", "gpt-4o-mini")!,
  explainModel:   env("AI_EXPLAIN_MODEL", "gpt-4o-mini")!,
  summaryModel:   env("AI_SUMMARY_MODEL", "gpt-4o-mini")!,
  rerankerModel:  env("AI_RERANK_MODEL", "gpt-4o-mini")!,

  reranker: {
    enabled: env("AI_RERANK_ENABLED", "false") === "true",
    topK: Number(env("AI_RERANK_TOPK", "20")),
    tiers: ["premium"],
  },

  temperatures: { parser: 0, explain: 0.2, caption: 0.4, summary: 0.4 },
  maxTokens:    { parser: 700, explain: 400, caption: 500, summary: 350, vision: 700 },
  timeoutMs:    Number(env("AI_TIMEOUT_MS", "30000")),
  retries:      { max: 4, baseMs: 400, capMs: 8000 },

  // Public pricing snapshot (USD/1K tokens). Update via env override as prices change.
  costPerKToken: {
    "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  },
  costPerKTokenEmbed: {
    "text-embedding-3-small": 0.00002,
    "text-embedding-3-large": 0.00013,
  },
  caps: {
    dailyUsd:   { free: 0.10, pro: 1.00, premium: 5.00 },
    monthlyUsd: { free: 1.00, pro: 20.00, premium: 100.00 },
    perCallUsd: 0.25,
  },

  ttl: { searchSec: 300, explainSec: 3600 },
  embedBatchSize: 64,
  zdr: env("AI_ZDR", "true") === "true",
  promptVersion: env("AI_PROMPT_VERSION", "v1"),
};

export function priceFor(model: string, kind: "embed" | "chat", tokensIn = 0, tokensOut = 0): number {
  if (kind === "embed") {
    const r = aiConfig.costPerKTokenEmbed[model] ?? 0;
    return (tokensIn / 1000) * r;
  }
  const p = aiConfig.costPerKToken[model];
  if (!p) return 0;
  return (tokensIn / 1000) * p.input + (tokensOut / 1000) * p.output;
}

/** Hard assertion at module load — fail fast if backend column was migrated. */
export function assertDim(actualDim: number) {
  if (actualDim !== aiConfig.embeddingDim) {
    throw new Error(
      `EMBED_DIM_MISMATCH: model ${aiConfig.embeddingModel} returned dim=${actualDim} ` +
      `but backend asset_embeddings.vector(${aiConfig.embeddingDim}). ` +
      `Run migration to alter column to vector(${actualDim}) AND re-embed all assets.`
    );
  }
}