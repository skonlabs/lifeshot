// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/**
 * clusterPlaces — turns raw GPS coordinates into named places and per-asset
 * location rows.
 *
 * Sources GPS from BOTH assets.location_lat/lng (source of truth, set by the
 * connector or phase-1/2 of normalizeMetadata) AND from asset_gps. Processes
 * any asset that has coords but no asset_locations row yet (or has a row
 * missing place_id). Idempotent.
 */

// Round coords to ~1km so nearby assets share a single geocode lookup.
function geoKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)}:${lng.toFixed(2)}`;
}

function isMissingColumnError(message?: string | null, column?: string) {
  if (!message || !column) return false;
  const m = message.toLowerCase();
  const t = column.toLowerCase();
  return m.includes(t) && (m.includes("schema cache") || m.includes("does not exist") || m.includes("could not find"));
}

/** Upsert into asset_locations with defensive fallbacks for legacy schemas. */
async function upsertAssetLocation(
  sb: ReturnType<typeof serviceClient>,
  uid: string,
  row: { asset_id: string; lat: number; lng: number; city: string | null; country: string | null; place_id: string | null },
): Promise<string | null> {
  // Try richest payload first.
  const variants: Array<Record<string, unknown>> = [
    { asset_id: row.asset_id, user_id: uid, lat: row.lat, lng: row.lng, city: row.city, country: row.country, place_id: row.place_id, geocoded_at: new Date().toISOString() },
    { asset_id: row.asset_id,                 lat: row.lat, lng: row.lng, city: row.city, country: row.country, place_id: row.place_id, geocoded_at: new Date().toISOString() },
    { asset_id: row.asset_id,                 lat: row.lat, lng: row.lng, city: row.city, country: row.country,                          geocoded_at: new Date().toISOString() },
  ];
  let lastErr: string | null = null;
  for (const v of variants) {
    const { error } = await (sb.from("asset_locations") as any).upsert(v, { onConflict: "asset_id" });
    if (!error) return null;
    lastErr = error.message;
    // Only retry with simpler payload if it's a missing-column issue.
    if (!isMissingColumnError(error.message, "user_id") && !isMissingColumnError(error.message, "place_id")) {
      return error.message;
    }
  }
  return lastErr;
}

export async function clusterPlaces(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, asset_id } = ctx.payload as { user_id?: string; asset_id?: string };
  const uid = user_id ?? ctx.userId;
  if (!uid) throw new Error("invalid: user_id");

  const { enqueueJob } = await import("../_pipeline/enqueuer.ts");

  // ── 1. Collect every asset for this user that has GPS coords ──────────────
  // Source of truth is `assets.location_lat/lng`. We also look at `asset_gps`
  // in case some rows have GPS there but not on the asset row.
  const coordsByAsset = new Map<string, { lat: number; lng: number }>();

  const assetsQ = sb.from("assets")
    .select("id, location_lat, location_lng")
    .eq("user_id", uid)
    .not("location_lat", "is", null)
    .not("location_lng", "is", null);
  const { data: assetRows, error: aErr } = asset_id ? await assetsQ.eq("id", asset_id) : await assetsQ;
  if (aErr) throw new Error(`clusterPlaces assets fetch: ${aErr.message}`);
  for (const r of (assetRows ?? []) as any[]) {
    const lat = Number(r.location_lat), lng = Number(r.location_lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) coordsByAsset.set(r.id, { lat, lng });
  }

  const gpsQ = sb.from("asset_gps")
    .select("asset_id, gps_latitude, gps_longitude")
    .eq("user_id", uid)
    .not("gps_latitude", "is", null)
    .not("gps_longitude", "is", null);
  const { data: gpsRows, error: gErr } = asset_id ? await gpsQ.eq("asset_id", asset_id) : await gpsQ;
  if (gErr) throw new Error(`clusterPlaces asset_gps fetch: ${gErr.message}`);
  for (const r of (gpsRows ?? []) as any[]) {
    if (coordsByAsset.has(r.asset_id)) continue;
    const lat = Number(r.gps_latitude), lng = Number(r.gps_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) coordsByAsset.set(r.asset_id, { lat, lng });
  }

  if (coordsByAsset.size === 0) {
    console.log("clusterPlaces: no assets with GPS for user", uid);
    return { user_id: uid, places: 0, located: 0, reason: "no_gps" };
  }

  // ── 2. Skip assets that are already geocoded with a place_id ──────────────
  const allIds = Array.from(coordsByAsset.keys());
  const { data: existingLoc } = await sb.from("asset_locations")
    .select("asset_id, place_id")
    .in("asset_id", allIds);
  const alreadyDone = new Set<string>();
  if (!asset_id) {
    for (const r of (existingLoc ?? []) as any[]) {
      if (r.place_id) alreadyDone.add(r.asset_id);
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

    // Back-fill reverse-geocode fields on asset_gps if a row exists.
    await sb.from("asset_gps").update({
      place_name: placeName,
      reverse_geocoded_city: geo.admin ?? null,
      reverse_geocoded_country: geo.country ?? null,
    }).eq("asset_id", assetId);

    const lErr = await upsertAssetLocation(sb, uid, {
      asset_id: assetId, lat, lng,
      city: geo.admin ?? null, country: geo.country ?? null, place_id: placeId,
    });
    if (lErr) {
      console.error("clusterPlaces asset_locations upsert failed", { assetId, err: lErr });
      if (!firstError) firstError = `asset_locations upsert: ${lErr}`;
      continue;
    }

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
