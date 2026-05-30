import { getServiceClient } from "./clients.ts";
import type { Context } from "./deps.ts";

// Cache backed by api_cache_entries via service role (so anonymous keys work
// uniformly). Keys MUST include userId for per-user data to prevent leaks.
export const cache = {
  async get<T>(_c: Context, key: string): Promise<T | null> {
    const s = getServiceClient();
    const { data } = await s.from("api_cache_entries").select("payload, expires_at")
      .eq("cache_key", key).maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.payload as T;
  },
  async set(_c: Context, key: string, payload: unknown, ttlSeconds = 60, userId?: string) {
    const s = getServiceClient();
    await s.from("api_cache_entries").upsert({
      cache_key: key, user_id: userId ?? null, payload,
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    }, { onConflict: "cache_key" });
  },
  async del(_c: Context, key: string) {
    const s = getServiceClient();
    await s.from("api_cache_entries").delete().eq("cache_key", key);
  },
  async invalidateUser(userId: string, prefix = "") {
    const s = getServiceClient();
    let q = s.from("api_cache_entries").delete().eq("user_id", userId);
    if (prefix) q = q.like("cache_key", `${prefix}%`);
    await q;
  },
};

export const keys = {
  viewport: (uid: string, filterHash: string, cursor?: string | null) =>
    `v1:viewport:${uid}:${filterHash}:${cursor ?? "_"}`,
  dashboard: (uid: string) => `v1:dashboard:${uid}`,
  facets:    (uid: string, filterHash: string) => `v1:facets:${uid}:${filterHash}`,
  search:    (uid: string, qhash: string) => `v1:search:${uid}:${qhash}`,
  providers: () => `v1:providers`,
  signedUrl: (uid: string, assetId: string, size: string) =>
    `v1:signed:${uid}:${assetId}:${size}`,
};

export async function hashJson(o: unknown): Promise<string> {
  const buf = new TextEncoder().encode(JSON.stringify(o ?? {}));
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).slice(0, 8)
    .map(b => b.toString(16).padStart(2, "0")).join("");
}
