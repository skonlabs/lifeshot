import { getServiceClient } from "./clients.ts";
import { ApiError } from "./errors.ts";

export const RATE_BUCKETS = {
  general:  { limit: 60,  windowSec: 60 },
  viewport: { limit: 300, windowSec: 60 },
  search:   { limit: 30,  windowSec: 60 },
  connect:  { limit: 5,   windowSec: 60 },
  export:   { limit: 5,   windowSec: 60 },
  delete:   { limit: 5,   windowSec: 60 },
} as const;
export type Bucket = keyof typeof RATE_BUCKETS;

export async function enforceRateLimit(userId: string, bucket: Bucket) {
  const { limit, windowSec } = RATE_BUCKETS[bucket];
  const s = getServiceClient();
  const windowStart = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  // upsert + increment
  const { data: existing } = await s.from("api_rate_limits")
    .select("count").eq("user_id", userId).eq("bucket", bucket)
    .eq("window_start", windowStart).maybeSingle();
  const next = (existing?.count ?? 0) + 1;
  await s.from("api_rate_limits").upsert({
    user_id: userId, bucket, window_start: windowStart, count: next,
  }, { onConflict: "user_id,bucket,window_start" });
  if (next > limit) {
    throw new ApiError("rate_limited", `Rate limit exceeded for ${bucket}`, {
      bucket, limit, window_seconds: windowSec,
    });
  }
}
