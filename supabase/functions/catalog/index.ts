import { z } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody, parseQuery, parseParams } from "../_shared/validation.ts";
import { ApiError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { cache, keys, hashJson } from "../_shared/cache.ts";
import { encodeCursor, decodeCursor } from "../_shared/pagination.ts";
import { resolveThumbUrl } from "../_shared/signed-url.ts";
import { emitEvent } from "../_shared/observability.ts";

const ViewportIn = z.object({
  cursor: z.string().optional(),
  viewport_size: z.number().int().min(1).max(200).default(60),
  timeline_filter: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
  people_filter: z.array(z.string().uuid()).optional(),
  event_filter: z.array(z.string().uuid()).optional(),
  source_filter: z.array(z.string().uuid()).optional(),
  quality_preference: z.enum(["best","balanced","fast"]).default("balanced"),
  device_context: z.object({
    dpr: z.number().min(0.5).max(4).optional(),
    network: z.enum(["wifi","cellular","slow"]).optional(),
  }).optional(),
}).strict();

const TimelineIn = z.object({
  granularity: z.enum(["year","month","day","event"]).default("month"),
  filters: z.string().optional(),
});

const app = authed(createApi("/catalog/v1"));

async function descriptorFromRow(c: any, supa: any, uid: string, row: any) {
  return {
    asset_id: row.asset_id ?? row.id,
    thumbnail_url: await resolveThumbUrl(c, supa, uid, row.asset_id ?? row.id, row.thumbnail_cache_key ?? null),
    blurhash: row.blurhash ?? null,
    dominant_color: row.dominant_color ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    capture_time: row.capture_time ?? null,
    media_type: row.media_type ?? "photo",
    source_badge: row.source_badge ?? null,
    hydration_status: (row.thumbnail_cache_key ? "ready" : "pending") as "ready" | "pending",
    next_quality_url: null,
    original_fetch_policy: "on_demand" as const,
    cache_status: "warm" as const,
    prefetch_hint: false,
  };
}

app.get("/assets/:id", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data: a } = await supa.from("assets").select("*").eq("id", id).maybeSingle();
  if (!a) throw new ApiError("not_found", "Asset not found");
  const { data: bh } = await supa.from("asset_blurhashes").select("*").eq("asset_id", id).maybeSingle();
  const descriptor = await descriptorFromRow(c, supa, uid, { ...a, ...(bh ?? {}), asset_id: id });
  return c.json({ asset: a, descriptor });
});

app.get("/assets/:id/sources", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data } = await supa.from("asset_source_refs").select(`
    id, asset_id, source_account_id, source_asset_id, provider_url,
    match_confidence, is_primary, first_seen_at, last_seen_at,
    account:source_accounts(display_label, provider:source_providers(kind, name))
  `).eq("asset_id", id);
  return c.json({
    refs: (data ?? []).map((r: any) => ({
      id: r.id, source_account_id: r.source_account_id,
      provider_kind: r.account?.provider?.kind ?? null,
      provider_name: r.account?.provider?.name ?? null,
      label: r.account?.display_label ?? null,
      is_primary: r.is_primary, match_confidence: r.match_confidence,
      first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at,
    })),
  });
});

app.get("/timeline", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { granularity } = parseQuery(c, TimelineIn);
  await enforceRateLimit(uid, "general");
  const { data, error } = await supa.from("timeline_windows")
    .select("bucket, asset_count, start_time, end_time, asset_ids")
    .eq("granularity", granularity).order("bucket", { ascending: false }).limit(120);
  if (error) throw new ApiError("internal", error.message);
  // hydrate first asset of each bucket as cover
  const coverIds = (data ?? []).map(b => b.asset_ids?.[0]).filter(Boolean);
  const covers: Record<string, any> = {};
  if (coverIds.length) {
    const { data: cs } = await supa.from("assets")
      .select("id, capture_time, media_type, thumbnail_cache_key, blurhash, dominant_color, width, height")
      .in("id", coverIds);
    for (const c2 of cs ?? []) covers[c2.id] = c2;
  }
  const buckets = await Promise.all((data ?? []).map(async b => ({
    bucket: b.bucket, asset_count: b.asset_count,
    start_time: b.start_time, end_time: b.end_time,
    cover: b.asset_ids?.[0] && covers[b.asset_ids[0]]
      ? await descriptorFromRow(c, supa, uid, { ...covers[b.asset_ids[0]], asset_id: b.asset_ids[0] })
      : null,
  })));
  return c.json({ granularity, buckets });
});

app.post("/memory/viewport", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const body = await parseBody(c, ViewportIn);
  await enforceRateLimit(uid, "viewport");
  const filterHash = await hashJson({ ...body, cursor: undefined });
  const cacheKey = keys.viewport(uid, filterHash, body.cursor ?? null);
  const hit = await cache.get<any>(c, cacheKey);
  if (hit) return c.json({ ...hit, cache: { hit: true, ttl_seconds: 30 } });

  const cur = decodeCursor<{ before: string }>(body.cursor);
  let q = supa.from("assets")
    .select("id, capture_time, media_type, thumbnail_cache_key, blurhash, dominant_color, width, height")
    .eq("deleted_state", "active")
    .order("capture_time", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(body.viewport_size);
  if (cur?.before) q = q.lt("capture_time", cur.before);
  if (body.timeline_filter?.from) q = q.gte("capture_time", body.timeline_filter.from);
  if (body.timeline_filter?.to)   q = q.lte("capture_time", body.timeline_filter.to);
  if (body.event_filter?.length)  q = q.in("event_id", body.event_filter);

  const { data, error } = await q;
  if (error) throw new ApiError("internal", error.message);
  const items = await Promise.all((data ?? []).map(r =>
    descriptorFromRow(c, supa, uid, { ...r, asset_id: r.id })));
  const last = data?.[data.length - 1];
  const next_cursor = last?.capture_time ? encodeCursor({ before: last.capture_time }) : null;
  const out = { items, next_cursor };
  await cache.set(c, cacheKey, out, 30, uid);
  emitEvent(c, "catalog.viewport", { size: items.length, cursor: !!body.cursor });
  return c.json({ ...out, cache: { hit: false, ttl_seconds: 30 } });
});

app.get("/dashboard", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const hit = await cache.get<any>(c, keys.dashboard(uid));
  if (hit) return c.json({ ...hit, cache: { hit: true } });
  const { data, error } = await supa.rpc("get_dashboard_counts");
  if (error) throw new ApiError("internal", error.message);
  await cache.set(c, keys.dashboard(uid), data, 60, uid);
  return c.json({ ...(data as any), cache: { hit: false } });
});

Deno.serve(app.fetch);
