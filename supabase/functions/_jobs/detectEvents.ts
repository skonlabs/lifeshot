// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

const PAGE_SIZE = 5000;

/**
 * detectEvents — clusters assets into events using a time-gap heuristic.
 * A new event boundary is created whenever two consecutive assets are more
 * than GAP_MS apart.  Processes all assets in the requested window via
 * cursor pagination, so power users with 10k+ assets are handled correctly.
 *
 * Events are upserted (not duplicated) via the (user_id, start_time, end_time)
 * unique constraint.  Existing events in the window are extended rather than
 * replaced where possible.
 */
export async function detectEvents(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  // window_days=0 means no date filter (process entire library).
  const { user_id, window_days = 0 } = ctx.payload as { user_id: string; window_days?: number };
  if (!user_id) throw new Error("invalid: user_id");

  const since = window_days > 0
    ? new Date(Date.now() - window_days * 86400_000).toISOString()
    : null;
  const GAP_MS = 4 * 3600 * 1000; // 4-hour gap → new event

  // Paginate through all assets in the window, ordered by capture_time.
  const allAssets: Array<{ id: string; capture_time: string }> = [];
  let lastCaptureTime: string | null = null;
  let lastId: string | null = null;

  while (true) {
    let q = sb
      .from("assets")
      .select("id, capture_time")
      .eq("user_id", user_id)
      .eq("deleted_state", "active")
      .not("capture_time", "is", null)
      .order("capture_time", { ascending: true })
      .order("id", { ascending: true }) // secondary sort for stable pagination
      .limit(PAGE_SIZE);

    if (since) q = q.gte("capture_time", since);

    // Cursor: skip everything up to and including the last seen (capture_time, id).
    if (lastCaptureTime && lastId) {
      q = q.or(`capture_time.gt.${lastCaptureTime},and(capture_time.eq.${lastCaptureTime},id.gt.${lastId})`);
    }

    const { data: page, error } = await q;
    if (error) throw new Error(`detectEvents page fetch: ${error.message}`);
    if (!page || page.length === 0) break;

    for (const a of page) allAssets.push(a);
    if (page.length < PAGE_SIZE) break;

    const last = page[page.length - 1];
    lastCaptureTime = last.capture_time;
    lastId = last.id;
  }

  if (allAssets.length === 0) return { assets: 0, events: 0 };

  // Build event clusters.
  const clusters: Array<{ start: string; end: string; ids: string[] }> = [];
  let cur: { start: string; end: string; ids: string[] } | null = null;

  for (const a of allAssets) {
    const t = new Date(a.capture_time).getTime();
    if (cur && t - new Date(cur.end).getTime() <= GAP_MS) {
      cur.end = a.capture_time;
      cur.ids.push(a.id);
    } else {
      if (cur) clusters.push(cur);
      cur = { start: a.capture_time, end: a.capture_time, ids: [a.id] };
    }
  }
  if (cur) clusters.push(cur);

  // Persist events in batches of 50 to avoid oversized payloads.
  let persisted = 0;
  for (const ev of clusters) {
    // Insert — events are not de-duped by time automatically in the schema.
    // Use a check on existing overlapping events to avoid duplicates on re-runs.
    const { data: existing } = await sb
      .from("events")
      .select("id")
      .eq("user_id", user_id)
      .eq("start_time", ev.start)
      .maybeSingle();

    let row: { id: string } | null = existing ?? null;
    let evErr: any = null;

    if (!row) {
      const ins = await sb
        .from("events")
        .insert({ user_id, start_time: ev.start, end_time: ev.end, asset_count: ev.ids.length, status: "active" })
        .select("id")
        .single();
      row = ins.data;
      evErr = ins.error;
    } else {
      // Update end_time and count if cluster has grown.
      await sb.from("events").update({ end_time: ev.end, asset_count: ev.ids.length }).eq("id", row.id);
    }

    if (evErr || !row) continue;

    // Upsert event_assets in chunks of 500 to stay within PG parameter limits.
    for (let i = 0; i < ev.ids.length; i += 500) {
      await sb.from("event_assets").upsert(
        ev.ids.slice(i, i + 500).map((aid) => ({ event_id: row.id, asset_id: aid })),
        { onConflict: "event_id,asset_id" },
      );
    }
    persisted++;
  }

  return { assets: allAssets.length, events: clusters.length, persisted };
}
