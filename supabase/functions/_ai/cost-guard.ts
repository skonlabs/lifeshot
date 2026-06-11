// deno-lint-ignore-file no-explicit-any
/**
 * Cost guard + usage accounting. Blocks calls when per-tier daily/monthly
 * caps are reached, downgrades vision model when getting close, and logs
 * every call (incl. cache hits and consent skips) to ai_usage_log.
 */
import { serviceClient } from "../_pipeline/clients.ts";
import { aiConfig, type Tier } from "./config.ts";
import { logger } from "../_pipeline/logger.ts";

export class CostCapError extends Error {
  constructor(public scope: "daily" | "monthly" | "per_call", public tier: Tier, public limit: number) {
    super(`AI cost cap reached: ${scope}=${limit} USD (tier=${tier})`);
  }
}

async function tierForUser(userId?: string | null): Promise<Tier> {
  if (!userId) return "pro";
  try {
    const sb = serviceClient();
    const { data } = await sb.from("user_profiles").select("tier").eq("user_id", userId).maybeSingle();
    const t = (data?.tier as string | undefined) ?? "free";
    return (["free","pro","premium"].includes(t) ? t : "free") as Tier;
  } catch { return "free"; }
}

async function userSpend(userId: string): Promise<{ today: number; month: number }> {
  const sb = serviceClient();
  const [{ data: t }, { data: m }] = await Promise.all([
    sb.rpc("ai_user_cost_today", { _user_id: userId }),
    sb.rpc("ai_user_cost_month", { _user_id: userId }),
  ]);
  return { today: Number(t ?? 0), month: Number(m ?? 0) };
}

export interface GuardArgs {
  ctx?: { userId?: string | null; tier?: Tier };
  model: string;
  kind: "embed" | "chat" | "vision";
}

/** Throws CostCapError if the call must be blocked. */
export async function costGuard(args: GuardArgs): Promise<void> {
  const tier = args.ctx?.tier ?? (await tierForUser(args.ctx?.userId));
  if (!args.ctx?.userId) return; // anonymous/system calls are uncapped (worker maintenance)
  const spend = await userSpend(args.ctx.userId);
  const day = aiConfig.caps.dailyUsd[tier];
  const month = aiConfig.caps.monthlyUsd[tier];
  if (spend.today >= day) {
    logger.warn("ai_cost_cap_hit", { tier, scope: "daily", spent: spend.today, limit: day, userId: args.ctx.userId });
    throw new CostCapError("daily", tier, day);
  }
  if (spend.month >= month) {
    logger.warn("ai_cost_cap_hit", { tier, scope: "monthly", spent: spend.month, limit: month, userId: args.ctx.userId });
    throw new CostCapError("monthly", tier, month);
  }
}

export interface UsageRecord {
  ctx?: { userId?: string | null; assetId?: string | null };
  model: string;
  kind: "embed" | "chat" | "vision";
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  latencyMs?: number;
  cacheHit?: boolean;
  consentSkipped?: boolean;
  skipReason?: string;
  meta?: Record<string, unknown>;
}

export async function logUsage(rec: UsageRecord): Promise<void> {
  try {
    const sb = serviceClient();
    await sb.from("ai_usage_log").insert({
      user_id: rec.ctx?.userId ?? null,
      asset_id: rec.ctx?.assetId ?? null,
      model: rec.model,
      kind: rec.kind,
      prompt_tokens: rec.prompt_tokens,
      completion_tokens: rec.completion_tokens,
      estimated_cost_usd: rec.cost.toFixed(6),
      latency_ms: rec.latencyMs ?? null,
      cache_hit: rec.cacheHit ?? false,
      consent_skipped: rec.consentSkipped ?? false,
      skip_reason: rec.skipReason ?? null,
      meta: rec.meta ?? {},
    });
  } catch (e) {
    logger.warn("ai_usage_log_failed", { error: String(e), model: rec.model });
  }
}

/** Vision model — single tier (gpt-4o-mini). */
export async function pickVisionModel(_userId?: string | null, _tier?: Tier): Promise<string> {
  return aiConfig.visionModel;
}