// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/** Cluster assets into events by time-gap heuristic (>4h gap = new event). */
export async function detectEvents(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, window_days = 30 } = ctx.payload as { user_id: string; window_days?: number };
  if (!user_id) throw new Error("invalid: user_id");
  const since = new Date(Date.now() - window_days * 86400_000).toISOString();
  const { data: assets } = await sb.from("assets")
    .select("id, capture_time").eq("user_id", user_id)
    .gte("capture_time", since).order("capture_time").limit(5000);
  if (!assets || assets.length === 0) return { events: 0 };

  const GAP = 4 * 3600 * 1000;
  const events: Array<{ start: string; end: string; ids: string[] }> = [];
  let cur: { start: string; end: string; ids: string[] } | null = null;
  for (const a of assets) {
    if (!a.capture_time) continue;
    const t = new Date(a.capture_time).getTime();
    if (cur && t - new Date(cur.end).getTime() <= GAP) {
      cur.end = a.capture_time; cur.ids.push(a.id);
    } else {
      if (cur) events.push(cur);
      cur = { start: a.capture_time, end: a.capture_time, ids: [a.id] };
    }
  }
  if (cur) events.push(cur);

  for (const ev of events) {
    const { data: row } = await sb.from("events").upsert({
      user_id, started_at: ev.start, ended_at: ev.end, asset_count: ev.ids.length,
    }, { onConflict: "user_id,started_at" }).select("id").single();
    if (row) {
      await sb.from("event_assets").upsert(ev.ids.map((aid) => ({ event_id: row.id, asset_id: aid })), { onConflict: "event_id,asset_id" });
    }
  }
  return { events: events.length };
}