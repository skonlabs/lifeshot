// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/**
 * clusterPlaces — turns raw GPS coordinates into named places.
 *
 * Source of truth: `asset_gps` (preferred) + `assets.location_lat/lng`
 * (fallback). On success it back-fills the reverse-geocoded city / country /
 * place_name onto `asset_gps`, ensures a `places` row exists, and mirrors
 * the resolved place onto `assets.place_id / place_name / location_city /
 * location_country` so callers can query in a single join.
 * We no longer write to `asset_locations` — that table is deprecated.
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

  const { enqueueJob } = await import("../_pipeline/enqueuer.ts");

  // ── 1. Collect every asset for this user that has GPS coords ──────────────
  // Canonical store is `asset_gps` (assets.location_* columns were dropped).
  const coordsByAsset = new Map<string, { lat: number; lng: number }>();

  const gpsQ = sb.from("asset_gps")
    .select("asset_id, gps_latitude, gps_longitude")
    .eq("user_id", uid)
    .not("gps_latitude", "is", null)
    .not("gps_longitude", "is", null);
  const { data: gpsRows, error: gErr } = asset_id ? await gpsQ.eq("asset_id", asset_id) : await gpsQ;
  if (gErr) throw new Error(`clusterPlaces asset_gps fetch: ${gErr.message}`);
  for (const r of (gpsRows ?? []) as any[]) {
    const lat = Number(r.gps_latitude), lng = Number(r.gps_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) coordsByAsset.set(r.asset_id, { lat, lng });
  }

  if (coordsByAsset.size === 0) {
    console.log("clusterPlaces: no assets with GPS for user", uid);
    return { user_id: uid, places: 0, located: 0, reason: "no_gps" };
  }

  // ── 2. Skip assets that already have a reverse-geocoded place_name ────────
  const allIds = Array.from(coordsByAsset.keys());
  const alreadyDone = new Set<string>();
  if (!asset_id) {
    const { data: existingGps } = await sb.from("asset_gps")
      .select("asset_id, place_name")
      .in("asset_id", allIds);
    for (const r of (existingGps ?? []) as any[]) {
      if (r.place_name) alreadyDone.add(r.asset_id);
    }
  }
  const todo = allIds.filter((id) => !alreadyDone.has(id));
  console.log("clusterPlaces: scan", { user_id: uid, total_with_gps: coordsByAsset.size, already_done: alreadyDone.size, to_process: todo.length });
  if (!todo.length) return { user_id: uid, places: 0, located: 0, reason: "all_done" };

  // Cache geocode results per coarse cell to limit provider calls.
  const geocodeCache = new Map<string, { name: string; country?: string; admin?: string }>();
  // Cache resolved place_id per place name to avoid repeat upserts.
  const placeIdByName = new Map<string, string>();
  const affectedAssets: string[] = [];
  let located = 0;
  let firstError: string | null = null;

  for (const assetId of todo) {
    const c = coordsByAsset.get(assetId)!;
    const lat = c.lat, lng = c.lng;

    const key = geoKey(lat, lng);
    let geo = geocodeCache.get(key);
    if (!geo) {
      try {
        const r = await providers.geocoder.reverse(lat, lng);
        geo = { name: r.name ?? "Unknown Place", country: r.country, admin: r.admin };
      } catch (e) {
        console.warn("clusterPlaces: geocode failed", { assetId, lat, lng, err: String((e as Error)?.message ?? e) });
        geo = { name: "Unknown Place", country: undefined, admin: undefined };
      }
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
      if (pErr || !place) {
        console.error("clusterPlaces place upsert failed", { placeName, err: pErr?.message });
        if (!firstError) firstError = `place upsert: ${pErr?.message ?? "no row"}`;
        continue;
      }
      placeId = place.id;
      placeIdByName.set(placeName, placeId);
    }

    // Upsert asset_gps with the reverse-geocode (creates the row if EXIF
    // wasn't the GPS source, so coords pulled from assets.location_lat/lng
    // still get a row here).
    const { error: gErr } = await sb.from("asset_gps").upsert({
      asset_id: assetId, user_id: uid,
      gps_latitude: lat, gps_longitude: lng,
      place_name: placeName,
      reverse_geocoded_city: geo.admin ?? null,
      reverse_geocoded_country: geo.country ?? null,
    }, { onConflict: "asset_id" });
    if (gErr) {
      console.error("clusterPlaces asset_gps upsert failed", { assetId, err: gErr.message });
      if (!firstError) firstError = `asset_gps upsert: ${gErr.message}`;
      continue;
    }

    // Mirror place pointer onto assets (places API joins via assets.place_id).
    // City/country live in asset_gps now (updated in the upsert above).
    await sb.from("assets").update({
      place_id: placeId,
      place_name: placeName,
    }).eq("id", assetId);

    affectedAssets.push(assetId);
    located++;
  }

  // Re-index affected assets so location names become searchable.
  if (affectedAssets.length) {
    for (const aid of affectedAssets) {
      await enqueueJob("indexSearchDocument", {
        userId: uid,
        payload: { asset_id: aid },
        idempotencyKey: `index:${aid}`,
      });
    }
  }

  console.log("clusterPlaces: done", { user_id: uid, places: placeIdByName.size, located, errors: firstError });
  return { user_id: uid, places: placeIdByName.size, located, ...(firstError ? { firstError } : {}) };
}
