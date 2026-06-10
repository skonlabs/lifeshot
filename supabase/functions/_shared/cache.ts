import type { Context } from "./deps.ts";

// In-process cache (per worker instance). api_cache_entries was dropped in
// the B-NUKE consolidation; cache lifetime is now bound to the worker's
// process. Acceptable because every entry has a short TTL (30–300s) and is
// always safe to miss.
interface Entry { payload: unknown; expiresAt: number; userId: string | null }
const STORE = new Map<string, Entry>();

function gc() {
  if (STORE.size < 2048) return;
  const now = Date.now();
  for (const [k, v] of STORE.entries()) if (v.expiresAt < now) STORE.delete(k);
}

export const cache = {
  async get<T>(_c: Context, key: string): Promise<T | null> {
    const e = STORE.get(key);
    if (!e) return null;
    if (e.expiresAt < Date.now()) { STORE.delete(key); return null; }
    return e.payload as T;
  },
  async set(_c: Context, key: string, payload: unknown, ttlSeconds = 60, userId?: string) {
    STORE.set(key, { payload, expiresAt: Date.now() + ttlSeconds * 1000, userId: userId ?? null });
    gc();
  },
  async del(_c: Context, key: string) { STORE.delete(key); },
  async invalidateUser(userId: string, prefix = "") {
    for (const [k, v] of STORE.entries()) {
      if (v.userId === userId && (!prefix || k.startsWith(prefix))) STORE.delete(k);
    }
  },
};

function fingerprint(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export const keys = {
  viewport: (uid: string, filterHash: string, cursor?: string | null) =>
    `v2:viewport:${uid}:${filterHash}:${cursor ?? "_"}`,
  dashboard: (uid: string) => `v1:dashboard:${uid}`,
  facets:    (uid: string, filterHash: string) => `v1:facets:${uid}:${filterHash}`,
  search:    (uid: string, qhash: string) => `v1:search:${uid}:${qhash}`,
  providers: () => `v1:providers`,
  signedUrl: (uid: string, assetId: string, size: string, cacheKey: string | null) =>
    `v2:signed:${uid}:${assetId}:${size}:${fingerprint(cacheKey ?? "_")}`,
};

export async function hashJson(o: unknown): Promise<string> {
  const buf = new TextEncoder().encode(JSON.stringify(o ?? {}));
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).slice(0, 8)
    .map(b => b.toString(16).padStart(2, "0")).join("");
}
