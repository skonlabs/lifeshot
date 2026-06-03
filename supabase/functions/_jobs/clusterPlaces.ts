// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/**
 * clusterPlaces — turns raw GPS coordinates (asset_gps) into named places and
 * per-asset location rows.
 *
 *  1. Reads assets with GPS that have not yet been reverse-geocoded.
 *  2. Reverse-geocodes each via the geocoder provider (mock by default).
 *  3. Back-fills asset_gps reverse_geocoded_* fields so the search indexer can
 *     include location text.
 *  4. Creates/links a `places` row per distinct place name and writes an
 *     `asset_locations` row per asset (used by the /events place anchoring and
 *     the timeline location facet).
 *  5. Re-enqueues indexSearchDocument so newly resolved location names become
 *     searchable.
 *
 * Idempotent: places are deduped on (user_id, name); asset_locations on asset_id.
 */

// Round coords to ~1km so nearby assets share a single geocode lookup.
function geoKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)}:${lng.toFixed(2)}`;
}

export async function clusterPlaces(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, asset_id } = ctx.payload as { user_id?: string; asset_id?: string };
  const uid = user_id ?? ctx.userId;
  if (!uid) throw new Error("invalid: user_id");

  // Fetch GPS rows that still need a place name resolved.
  let q = sb
    .from("asset_gps")
    .select("asset_id, gps_latitude, gps_longitude, place_name, reverse_geocoded_city, reverse_geocoded_country")
    .eq("user_id", uid)
    .not("gps_latitude", "is", null)
    .not("gps_longitude", "is", null);
  if (asset_id) q = q.eq("asset_id", asset_id);

  const { data: gpsRows, error } = await q;
  if (error) throw new Error(`clusterPlaces fetch: ${error.message}`);
  if (!gpsRows || gpsRows.length === 0) return { user_id: uid, places: 0, located: 0 };

  // Cache geocode results per coarse cell to limit provider calls.
  const geocodeCache = new Map<string, { name: string; country?: string; admin?: string }>();
  // Cache resolved place_id per place name to avoid repeat upserts.
  const placeIdByName = new Map<string, string>();
  const affectedAssets: string[] = [];
  let located = 0;

  for (const row of gpsRows) {
    const lat = Number(row.gps_latitude);
    const lng = Number(row.gps_longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const key = geoKey(lat, lng);
    let geo = geocodeCache.get(key);
    if (!geo) {
      const r = await providers.geocoder.reverse(lat, lng);
      geo = { name: r.name ?? "Unknown Place", country: r.country, admin: r.admin };
      geocodeCache.set(key, geo);
    }

    const placeName = geo.name || "Unknown Place";

    // Ensure a places row (deduped on user_id,name).
    let placeId = placeIdByName.get(placeName);
    if (!placeId) {
      const { data: place, error: pErr } = await sb
        .from("places")
        .upsert(
          { user_id: uid, name: placeName, lat, lng, kind: "geocoded" },
          { onConflict: "user_id,name" },
        )
        .select("id")
        .single();
      if (pErr || !place) throw new Error(`clusterPlaces place upsert: ${pErr?.message ?? "no row"}`);
      placeId = place.id;
      placeIdByName.set(placeName, placeId);
    }

    // Back-fill reverse-geocode fields on asset_gps (feeds search indexer).
    await sb.from("asset_gps").update({
      place_name: placeName,
      reverse_geocoded_city: geo.admin ?? row.reverse_geocoded_city ?? null,
      reverse_geocoded_country: geo.country ?? row.reverse_geocoded_country ?? null,
    }).eq("asset_id", row.asset_id);

    // Write the per-asset location row.
    const { error: lErr } = await sb.from("asset_locations").upsert({
      asset_id: row.asset_id,
      lat,
      lng,
      city: geo.admin ?? null,
      country: geo.country ?? null,
      place_id: placeId,
      geocoded_at: new Date().toISOString(),
    }, { onConflict: "asset_id" });
    if (lErr) throw new Error(`clusterPlaces asset_locations upsert: ${lErr.message}`);

    affectedAssets.push(row.asset_id);
    located++;
  }

  // Re-index affected assets so location names become searchable.
  if (affectedAssets.length) {
    const { enqueueJob } = await import("../_pipeline/enqueuer.ts");
    for (const aid of affectedAssets) {
      await enqueueJob("indexSearchDocument", {
        userId: uid,
        payload: { asset_id: aid },
        idempotencyKey: `index-post-place:${aid}`,
      });
    }
  }

  return { user_id: uid, places: placeIdByName.size, located };
}
