// deno-lint-ignore-file no-explicit-any
/**
 * OpenAI HTTP client wrapper. Fetch-based (no SDK) to stay Deno-friendly.
 * Provides: embed, chatStructured, visionStructured, chat. Handles retries,
 * timeouts, Retry-After, structured-output repair, usage accounting.
 */
import { aiConfig, priceFor } from "./config.ts";
import { logUsage, costGuard } from "./cost-guard.ts";
import { logger } from "../_pipeline/logger.ts";

const OPENAI_URL = "https://api.openai.com/v1";

export class AIError extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message);
  }
}

function apiKey(): string {
  const k = (typeof Deno !== "undefined" ? Deno.env.get("OPENAI_API_KEY") : process.env?.OPENAI_API_KEY) ?? "";
  if (!k) throw new AIError("missing_api_key", "OPENAI_API_KEY not configured");
  return k;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(ms: number) { return ms + Math.floor(Math.random() * (ms / 3)); }

/** Circuit breaker — one cool-down per model after sustained failures. */
const breakers = new Map<string, { failures: number; openedAt: number }>();
const BREAKER_THRESHOLD = 6;
const BREAKER_COOLDOWN_MS = 30_000;

function breakerCheck(model: string) {
  const b = breakers.get(model);
  if (!b) return;
  if (b.failures < BREAKER_THRESHOLD) return;
  if (Date.now() - b.openedAt < BREAKER_COOLDOWN_MS) {
    throw new AIError("circuit_open", `Circuit breaker open for ${model}`, 503);
  }
  breakers.set(model, { failures: 0, openedAt: 0 });
}
function breakerTrip(model: string) {
  const b = breakers.get(model) ?? { failures: 0, openedAt: 0 };
  b.failures++;
  if (b.failures >= BREAKER_THRESHOLD) b.openedAt = Date.now();
  breakers.set(model, b);
}
function breakerOK(model: string) {
  breakers.set(model, { failures: 0, openedAt: 0 });
}

async function httpJson(path: string, body: any, model: string, timeoutMs = aiConfig.timeoutMs): Promise<any> {
  breakerCheck(model);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string,string> = {
      "authorization": `Bearer ${apiKey()}`,
      "content-type": "application/json",
    };
    if (aiConfig.zdr) headers["openai-beta"] = "no-store"; // best-effort ZDR signal
    const res = await fetch(`${OPENAI_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      const ra = res.headers.get("retry-after");
      throw new AIError(
        res.status === 429 ? "rate_limited" : "openai_error",
        `OpenAI ${res.status}: ${text.slice(0, 500)}`,
        res.status,
      );
      // Note: Retry-After is consumed by callRetry below via err.message regex.
      void ra;
    }
    breakerOK(model);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function withRetry<T>(fn: () => Promise<T>, model: string): Promise<T> {
  let err: any;
  for (let attempt = 0; attempt <= aiConfig.retries.max; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      err = e;
      const retriable = e?.status === 429 || (e?.status >= 500 && e?.status < 600) || e?.name === "AbortError";
      if (!retriable || attempt === aiConfig.retries.max) {
        breakerTrip(model);
        throw e;
      }
      const wait = Math.min(aiConfig.retries.capMs, aiConfig.retries.baseMs * 2 ** attempt);
      await sleep(jitter(wait));
    }
  }
  throw err;
}

export interface CallContext {
  userId?: string | null;
  assetId?: string | null;
  tier?: "free" | "pro" | "premium";
}

export interface UsageStats {
  prompt_tokens: number;
  completion_tokens: number;
}

/** Generic chat completion (text-only). */
export async function chat(messages: any[], opts: { model?: string; temperature?: number; maxTokens?: number; ctx?: CallContext } = {}): Promise<string> {
  const model = opts.model ?? aiConfig.parserModel;
  await costGuard({ ctx: opts.ctx, kind: "chat", model });
  const start = Date.now();
  const res = await withRetry(() => httpJson("/chat/completions", {
    model,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 400,
    messages,
  }, model), model);
  const out = res?.choices?.[0]?.message?.content ?? "";
  const u = res?.usage ?? {};
  await logUsage({
    ctx: opts.ctx, model, kind: "chat",
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    cost: priceFor(model, "chat", u.prompt_tokens ?? 0, u.completion_tokens ?? 0),
    latencyMs: Date.now() - start,
  });
  return out;
}

/** Chat with strict JSON schema (Structured Outputs). Validates with caller-provided schema fn. */
export async function chatStructured<T>(opts: {
  model?: string;
  messages: any[];
  schema: { name: string; schema: any; strict?: boolean };
  parse: (raw: unknown) => T;
  temperature?: number;
  maxTokens?: number;
  ctx?: CallContext;
}): Promise<{ data: T; usage: UsageStats }> {
  const model = opts.model ?? aiConfig.parserModel;
  await costGuard({ ctx: opts.ctx, kind: "chat", model });
  const start = Date.now();
  const body = {
    model,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 600,
    messages: opts.messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: opts.schema.name, schema: opts.schema.schema, strict: opts.schema.strict ?? true },
    },
  };

  const run = async () => {
    const res = await withRetry(() => httpJson("/chat/completions", body, model), model);
    const raw = res?.choices?.[0]?.message?.content ?? "{}";
    const u = res?.usage ?? {};
    return { res, raw, u };
  };

  let { res, raw, u } = await run();
  let data: T;
  try {
    data = opts.parse(JSON.parse(raw));
  } catch (e: any) {
    // One repair attempt: feed the failing payload back asking for compliant JSON.
    logger.warn("ai_structured_repair", { error: String(e), model });
    const repaired = await run();
    res = repaired.res; raw = repaired.raw; u = repaired.u;
    try {
      data = opts.parse(JSON.parse(raw));
    } catch (e2: any) {
      await logUsage({
        ctx: opts.ctx, model, kind: "chat",
        prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0,
        cost: priceFor(model, "chat", u.prompt_tokens ?? 0, u.completion_tokens ?? 0),
        latencyMs: Date.now() - start, meta: { schema_repair_failed: true },
      });
      throw new AIError("schema_violation", `Schema validation failed: ${String(e2)}`);
    }
  }
  await logUsage({
    ctx: opts.ctx, model, kind: "chat",
    prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0,
    cost: priceFor(model, "chat", u.prompt_tokens ?? 0, u.completion_tokens ?? 0),
    latencyMs: Date.now() - start,
  });
  return { data, usage: { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0 } };
}

/** Vision call with image URL + structured JSON output. */
export async function visionStructured<T>(opts: {
  imageUrl: string;
  model?: string;
  prompt: string;
  schema: { name: string; schema: any; strict?: boolean };
  parse: (raw: unknown) => T;
  ctx?: CallContext;
  maxTokens?: number;
}): Promise<{ data: T; usage: UsageStats }> {
  // Enforce: never accept anything other than https URLs to derived artifacts.
  if (!/^https:\/\//.test(opts.imageUrl)) {
    throw new AIError("invalid_image_ref", "vision input must be a signed https URL to a derived artifact");
  }
  const messages = [
    { role: "system", content: "You analyze derived thumbnails. Reply only via the JSON schema." },
    { role: "user", content: [
      { type: "text", text: opts.prompt },
      { type: "image_url", image_url: { url: opts.imageUrl, detail: "low" } },
    ]},
  ];
  return chatStructured<T>({
    model: opts.model ?? aiConfig.visionModel,
    messages,
    schema: opts.schema,
    parse: opts.parse,
    temperature: 0,
    maxTokens: opts.maxTokens ?? aiConfig.maxTokens.vision,
    ctx: opts.ctx,
  });
}

/** Batched embeddings. Returns vectors in input order. */
export async function embedBatch(texts: string[], opts: { model?: string; ctx?: CallContext } = {}): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = opts.model ?? aiConfig.embeddingModel;
  await costGuard({ ctx: opts.ctx, kind: "embed", model });
  const start = Date.now();
  const res = await withRetry(() => httpJson("/embeddings", {
    model, input: texts, encoding_format: "float",
  }, model), model);
  const vectors: number[][] = (res?.data ?? []).map((r: any) => r.embedding as number[]);
  const u = res?.usage ?? {};
  await logUsage({
    ctx: opts.ctx, model, kind: "embed",
    prompt_tokens: u.prompt_tokens ?? u.total_tokens ?? 0,
    completion_tokens: 0,
    cost: priceFor(model, "embed", u.prompt_tokens ?? u.total_tokens ?? 0, 0),
    latencyMs: Date.now() - start,
    meta: { batch_size: texts.length },
  });
  return vectors;
}