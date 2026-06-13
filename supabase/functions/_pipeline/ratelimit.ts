/**
 * Per-worker in-memory token bucket.
 * Good enough since each source account is normally pinned to one
 * concurrent sync job at a time.
 */
const buckets = new Map<string, { tokens: number; updatedAt: number }>();

export async function takeSourceToken(sourceAccountId: string, perMin: number): Promise<boolean> {
  const cap = Math.max(1, perMin || 60);
  const refillPerMs = cap / 60_000;
  const now = Date.now();
  const cur = buckets.get(sourceAccountId) ?? { tokens: cap, updatedAt: now };
  const elapsed = Math.max(0, now - cur.updatedAt);
  const tokens = Math.min(cap, cur.tokens + elapsed * refillPerMs);
  if (tokens < 1) {
    buckets.set(sourceAccountId, { tokens, updatedAt: now });
    return false;
  }
  buckets.set(sourceAccountId, { tokens: tokens - 1, updatedAt: now });
  return true;
}

/** Compute exponential backoff with jitter (seconds). */
export function backoffSeconds(attempt: number, baseMs = 1000, capMs = 5 * 60 * 1000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exp * (0.5 + Math.random() * 0.5);
  return Math.round(jitter / 1000);
}