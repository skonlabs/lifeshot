import type { Context } from "./deps.ts";
import { getServiceClient } from "./clients.ts";

// Returns previously-stored response if the same (user, route, key, hash) was seen.
// Otherwise returns null; caller runs the handler and calls storeIdempotent().
export async function findIdempotent(c: Context, route: string, requestHash: string) {
  const key = c.req.header("Idempotency-Key");
  if (!key) return null;
  const uid = c.get("userId");
  if (!uid) return null;
  const s = getServiceClient();
  const { data } = await s.from("api_idempotency_keys")
    .select("response, status, request_hash, expires_at")
    .eq("user_id", uid).eq("route", route).eq("key", key).maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  if (data.request_hash !== requestHash) {
    return { conflict: true as const };
  }
  return { response: data.response, status: data.status };
}

export async function storeIdempotent(
  c: Context, route: string, requestHash: string, response: unknown, status: number,
) {
  const key = c.req.header("Idempotency-Key");
  if (!key) return;
  const uid = c.get("userId");
  if (!uid) return;
  const s = getServiceClient();
  await s.from("api_idempotency_keys").upsert({
    user_id: uid, route, key, request_hash: requestHash, response, status,
  }, { onConflict: "user_id,route,key" });
}
