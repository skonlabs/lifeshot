import { serviceClient } from "./clients.ts";

/** Returns true if the source account is below per-minute quota. */
export async function takeSourceToken(sourceAccountId: string, perMin: number): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("source_take_token", {
    _source_account_id: sourceAccountId, _per_min: perMin,
  });
  if (error) throw new Error(`source_take_token: ${error.message}`);
  return Boolean(data);
}

/** Compute exponential backoff with jitter (seconds). */
export function backoffSeconds(attempt: number, baseMs = 1000, capMs = 5 * 60 * 1000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exp * (0.5 + Math.random() * 0.5);
  return Math.round(jitter / 1000);
}