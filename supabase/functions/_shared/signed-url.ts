import type { Context } from "./deps.ts";
import { cache, keys } from "./cache.ts";
import { getServiceClient } from "./clients.ts";

const BUCKETS = ["thumbnails", "lifeshot-derived"] as const;

// Edge functions do not own a Storage bucket of originals; thumbnails live in
// `thumbnails` bucket if configured. We resolve a cache_key to a renderable
// URL: if it already looks like a URL, return as-is; otherwise build a
// signed URL from the user-scoped client.
export async function resolveThumbUrl(
  c: Context, supa: import("./deps.ts").SupabaseClient,
  userId: string, assetId: string, cacheKey: string | null, size = "medium",
): Promise<string | null> {
  if (!cacheKey) return null;
  if (/^https?:\/\//.test(cacheKey)) return cacheKey;
  const ck = keys.signedUrl(userId, assetId, size);
  const cached = await cache.get<string>(c, ck);
  if (cached) return cached;
  let url: string | null = null;
  const clients = [supa, getServiceClient()];
  for (const client of clients) {
    for (const bucket of BUCKETS) {
      const { data } = await client.storage.from(bucket).createSignedUrl(cacheKey, 60 * 60);
      if (data?.signedUrl) {
        url = data.signedUrl;
        break;
      }
    }
    if (url) break;
  }
  if (url) await cache.set(c, ck, url, 55 * 60, userId);
  return url;
}
