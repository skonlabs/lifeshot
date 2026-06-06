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

function isMissingColumnError(message?: string | null, column?: string) {
  if (!message || !column) return false;
  const normalized = message.toLowerCase();
  const target = column.toLowerCase();
  return normalized.includes(target) && (normalized.includes("schema cache") || normalized.includes("does not exist") || normalized.includes("could not find"));
}

export async function clusterPlaces(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, asset_id } = ctx.payload as { user_id?: string; asset_id?: string };
  const uid = user_id ?? ctx.userId;
  if (!uid) throw new Error("invalid: user_id");

  const { enqueueJob } = await import("../_pipeline/enqueuer.ts");

  // Fetch GPS rows that still need a place name resolved.
  // Skip rows that are already geocoded unless a specific asset is requested
  // (e.g. force re-geocode on explicit per-asset call).
  let q = sb
    .from("asset_gps")
    .select("asset_id, gps_latitude, gps_longitude, place_name, reverse_geocoded_city, reverse_geocoded_country")
    .eq("user_id", uid)
    .not("gps_latitude", "is", null)
    .not("gps_longitude", "is", null);
  if (asset_id) {
    q = q.eq("asset_id", asset_id); // per-asset: always re-geocode
  } else {
    q = q.is("place_name", null); // bulk run: only process not-yet-geocoded rows
  }

  const { data: gpsRows, error } = await q;
  if (error) throw new Error(`clusterPlaces fetch: ${error.message}`);
  if (!gpsRows || gpsRows.length === 0) {
    if (asset_id) {
      const { data: assetGps } = await sb
        .from("assets")
        .select("location_lat, location_lng")
        .eq("id", asset_id)
        .maybeSingle();
      if (assetGps?.location_lat != null && assetGps?.location_lng != null) {
        await sb.from("asset_gps").upsert({
          asset_id,
          user_id: uid,
          gps_latitude: assetGps.location_lat,
          gps_longitude: assetGps.location_lng,
          location_source: "asset_row",
          location_confidence: 0.85,
        }, { onConflict: "asset_id" });
        await sb.from("asset_locations").upsert({
          asset_id,
          lat: Number(assetGps.location_lat),
          lng: Number(assetGps.location_lng),
          confidence: 0.85,
          geocoded_at: new Date().toISOString(),
        }, { onConflict: "asset_id" });
      } else {
        return { user_id: uid, places: 0, located: 0, skipped: "no_gps" };
      }

      const retry = await sb
        .from("asset_gps")
        .select("asset_id, gps_latitude, gps_longitude, place_name, reverse_geocoded_city, reverse_geocoded_country")
        .eq("user_id", uid)
        .eq("asset_id", asset_id)
        .not("gps_latitude", "is", null)
        .not("gps_longitude", "is", null);
      if (retry.error) throw new Error(`clusterPlaces retry fetch: ${retry.error.message}`);
      if (!retry.data || retry.data.length === 0) return { user_id: uid, places: 0, located: 0, skipped: "no_gps" };
      gpsRows.splice(0, gpsRows.length, ...retry.data);
    } else {
      return { user_id: uid, places: 0, located: 0 };
    }
  }

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
    const locationRow = {
      asset_id: row.asset_id,
      user_id: uid,
      lat,
      lng,
      city: geo.admin ?? null,
      country: geo.country ?? null,
      place_id: placeId,
      geocoded_at: new Date().toISOString(),
    };
    let { error: lErr } = await sb.from("asset_locations").upsert(locationRow, { onConflict: "asset_id" });
    if (lErr && isMissingColumnError(lErr.message, "user_id")) {
      lErr = (await sb.from("asset_locations").upsert({
        asset_id: row.asset_id,
        lat,
        lng,
        city: geo.admin ?? null,
        country: geo.country ?? null,
        place_id: placeId,
        geocoded_at: new Date().toISOString(),
      }, { onConflict: "asset_id" })).error;
    }
    if (lErr) throw new Error(`clusterPlaces asset_locations upsert: ${lErr.message}`);

    affectedAssets.push(row.asset_id);
    located++;
  }

  // Re-index affected assets so location names become searchable.
  if (affectedAssets.length) {
    for (const aid of affectedAssets) {
      await enqueueJob("indexSearchDocument", {
        userId: uid,
        payload: { asset_id: aid },
        // Share the canonical per-asset index key. If a previous index job
        // already ran for this asset, the ledger dedupes — at-most-once.
        idempotencyKey: `index:${aid}`,
      });
    }
  }

  return { user_id: uid, places: placeIdByName.size, located };
}
