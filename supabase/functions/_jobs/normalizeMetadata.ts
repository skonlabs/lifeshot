// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function normalizeMetadata(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { data: asset, error } = await sb.from("assets")
    .select("id, user_id, capture_time, timezone, location_lat, location_lng, location_city, location_country")
    .eq("id", asset_id).single();
  if (error || !asset) throw new Error("not found: asset");

  // Resolve timezone from location (mock: keep existing, or 'UTC').
  const tz = asset.timezone ?? "UTC";
  const local_time = asset.capture_time ? new Date(asset.capture_time).toISOString() : null;
  let place: any = null;
  if (asset.location_lat != null && asset.location_lng != null) {
    place = await providers.geocoder.reverse(asset.location_lat, asset.location_lng);
  }
  await sb.from("assets").update({
    timezone: tz, local_time,
    place_id_text: place?.place_id ?? null,
    place_name: place?.name ?? null,
    location_city: asset.location_city ?? place?.name ?? null,
    location_country: asset.location_country ?? place?.country ?? null,
    status: "normalized",
  }).eq("id", asset_id);

  // Fan-out next stages
  await enqueueJob("hashAsset", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `hash:${asset_id}` });
  await enqueueJob("generateDerived", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `derived:${asset_id}` });
  await enqueueJob("embedAsset", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `embed:${asset_id}` });
  await enqueueJob("indexSearchDocument", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `index:${asset_id}` });
  return { asset_id, normalized: true };
}