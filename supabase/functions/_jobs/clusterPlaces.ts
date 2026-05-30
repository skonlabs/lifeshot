// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function clusterPlaces(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id } = ctx.payload as { user_id: string };
  if (!user_id) throw new Error("invalid: user_id");
  // Coarse grouping by place_id (already reverse-geocoded). DBSCAN deferred to v2.
  const { data, error } = await sb.from("assets")
    .select("place_id_text").eq("user_id", user_id).not("place_id_text", "is", null);
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const k = (row as any).place_id_text as string;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const places = Array.from(counts.entries()).map(([place_id, count]) => ({ user_id, place_id, asset_count: count }));
  if (places.length) await sb.from("places_summary").upsert(places, { onConflict: "user_id,place_id" });
  return { places: places.length };
}