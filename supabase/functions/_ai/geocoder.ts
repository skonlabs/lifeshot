// deno-lint-ignore-file no-explicit-any
/**
 * Real reverse geocoder using OpenStreetMap Nominatim.
 * Free, no API key required. Nominatim ToS: max 1 request/second, must set User-Agent.
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "Lifeshot/1.0 (personal photo library; contact@lifeshot.app)";

/** Nominatim rate limiter — enforces ≤1 req/sec globally. */
let lastCallMs = 0;
async function rateLimit() {
  const now = Date.now();
  const wait = 1050 - (now - lastCallMs);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallMs = Date.now();
}

export interface GeoResult {
  name: string;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  admin: string | null;
}

/**
 * Reverse geocode lat/lng → place name using Nominatim.
 * Returns a structured result with city, country, and a short human-readable name.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<GeoResult> {
  await rateLimit();

  const url = `${NOMINATIM_URL}?format=jsonv2&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&zoom=14&addressdetails=1&accept-language=en`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
    });
  } catch (e: any) {
    console.warn("geocoder: network error", String(e?.message ?? e));
    return { name: "Unknown Place", city: null, country: null, countryCode: null, admin: null };
  }

  if (!res.ok) {
    console.warn("geocoder: Nominatim error", res.status);
    return { name: "Unknown Place", city: null, country: null, countryCode: null, admin: null };
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    return { name: "Unknown Place", city: null, country: null, countryCode: null, admin: null };
  }

  const addr = data?.address ?? {};

  // Build a human-readable name from the most specific available field.
  // Priority: town/village/city > suburb > county > state > country
  const city =
    addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? addr.suburb ?? addr.district ?? null;
  const admin =
    addr.county ?? addr.state_district ?? addr.state ?? null;
  const country = addr.country ?? null;
  const countryCode = (addr.country_code ?? "").toUpperCase() || null;

  // Short display name: "City, Country" or just "Country" if no city
  const name = city
    ? `${city}${country ? ", " + country : ""}`
    : admin
    ? `${admin}${country ? ", " + country : ""}`
    : country ?? data?.display_name?.split(",").slice(0, 2).join(",").trim() ?? "Unknown Place";

  return { name, city, country, countryCode, admin: city ?? admin };
}
