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
  const preferredImageKey = row.media_type === "photo"
    ? (row.preview_cache_key ?? row.thumbnail_cache_key ?? null)
    : (row.thumbnail_cache_key ?? row.preview_cache_key ?? null);
  return {
    asset_id: row.asset_id ?? row.id,
    thumbnail_url: await resolveThumbUrl(c, supa, uid, row.asset_id ?? row.id, preferredImageKey),
    blurhash: row.blurhash ?? null,
    dominant_color: row.dominant_color ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    capture_time: row.capture_time ?? null,
    media_type: row.media_type ?? "photo",
    source_badge: row.source_badge ?? null,
    hydration_status: (preferredImageKey ? "ready" : "pending") as "ready" | "pending",
    next_quality_url: null,
    original_fetch_policy: "on_demand" as const,
    cache_status: "warm" as const,
    prefetch_hint: false,
  };
}

function applyViewportFilters(q: any, body: z.infer<typeof ViewportIn>, restrictIds: string[] | null) {
  let next = q.eq("deleted_state", "active");
  if (body.timeline_filter?.from) next = next.gte("capture_time", body.timeline_filter.from);
  if (body.timeline_filter?.to)   next = next.lte("capture_time", body.timeline_filter.to);
  if (body.event_filter?.length)  next = next.in("event_id", body.event_filter);
  if (restrictIds)                next = next.in("id", restrictIds);
  return next;
}

app.get("/assets/:id", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data: a } = await supa.from("assets").select("*").eq("id", id).maybeSingle();
  if (!a) throw new ApiError("not_found", "Asset not found");
  // asset_preview_metadata dropped → cache keys live on asset_media_metadata.
  const { data: mm } = await supa.from("asset_media_metadata")
    .select("blurhash, dominant_color, thumbnail_url, thumbnail_storage_path, preview_url, preview_storage_path")
    .eq("asset_id", id).maybeSingle();
  const preview = mm ? {
    blurhash: mm.blurhash,
    dominant_color: mm.dominant_color,
    thumbnail_cache_key: mm.thumbnail_url ?? mm.thumbnail_storage_path,
    preview_cache_key: mm.preview_url ?? mm.preview_storage_path,
  } : null;
  const descriptor = await descriptorFromRow(c, supa, uid, {
    ...a,
    ...(preview ?? {}),
    thumbnail_cache_key: preview?.thumbnail_cache_key ?? a.thumbnail_cache_key,
    asset_id: id,
  });
  if (preview?.preview_cache_key) descriptor.next_quality_url = await resolveThumbUrl(c, supa, uid, id, preview.preview_cache_key, "preview");
  return c.json({ asset: a, descriptor });
});

app.get("/assets/:id/sources", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  await enforceRateLimit(uid, "general");
  const { data } = await supa.from("asset_source_refs").select(`
    id, asset_id, source_account_id, source_asset_id, provider_url, provider_web_url, provider_download_url, source_relative_path,
    match_confidence, is_primary, first_seen_at, last_seen_at,
    account:source_accounts(display_label, provider:source_providers(kind, name))
  `).eq("asset_id", id);
  return c.json({
    sources: (data ?? []).map((r: any) => ({
      id: r.id, source_account_id: r.source_account_id,
      provider_kind: r.account?.provider?.kind ?? null,
      provider_name: r.account?.provider?.name ?? null,
      label: r.account?.display_label ?? null,
      provider_url: r.provider_web_url ?? r.provider_download_url ?? r.provider_url ?? null,
      relative_path: r.source_relative_path ?? null,
      is_primary: r.is_primary, match_confidence: r.match_confidence,
      first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at,
    })),
  });
});

app.get("/timeline", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { granularity } = parseQuery(c, TimelineIn);
  await enforceRateLimit(uid, "general");
  // Live aggregation — the old timeline_windows materialized table was never
  // populated (its refresh job was never enqueued), so buckets are computed
  // directly from assets here.
  const { data, error } = await supa.rpc("timeline_buckets", { _granularity: granularity });
  if (error) throw new ApiError("internal", error.message);
  // hydrate first asset of each bucket as cover
  const coverIds = (data ?? []).map(b => b.asset_ids?.[0]).filter(Boolean);
  const covers: Record<string, any> = {};
  const previewMap: Record<string, any> = {};
  if (coverIds.length) {
    const { data: cs } = await supa.from("assets")
      .select("id, capture_time, media_type, thumbnail_cache_key, blurhash, dominant_color, width, height")
      .in("id", coverIds);
    for (const c2 of cs ?? []) covers[c2.id] = c2;
    const { data: mm } = await supa.from("asset_media_metadata")
      .select("asset_id, blurhash, dominant_color, thumbnail_url, thumbnail_storage_path")
      .in("asset_id", coverIds);
    for (const item of mm ?? []) previewMap[item.asset_id] = {
      asset_id: item.asset_id, blurhash: item.blurhash, dominant_color: item.dominant_color,
      thumbnail_cache_key: item.thumbnail_url ?? item.thumbnail_storage_path,
    };
  }
  const buckets = await Promise.all((data ?? []).map(async b => ({
    bucket: b.bucket, asset_count: b.asset_count,
    start_time: b.start_time, end_time: b.end_time,
    cover: b.asset_ids?.[0] && covers[b.asset_ids[0]]
      ? await descriptorFromRow(c, supa, uid, {
          ...covers[b.asset_ids[0]],
          ...(previewMap[b.asset_ids[0]] ?? {}),
          thumbnail_cache_key: previewMap[b.asset_ids[0]]?.thumbnail_cache_key ?? covers[b.asset_ids[0]].thumbnail_cache_key,
          asset_id: b.asset_ids[0],
        })
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
  // Optionally narrow asset id set by people/source filters first, since these
  // require joins on other tables. We compute the candidate id set up-front and
  // intersect via .in("id", ...) on the main query.
  let restrictIds: string[] | null = null;
  if (body.people_filter?.length) {
    // person_faces was merged into people.faces (jsonb) in B-NUKE; extract
    // asset_ids from each selected person's faces array.
    const { data: peopleRows } = await supa.from("people")
      .select("faces").in("id", body.people_filter);
    const ids = Array.from(new Set(
      (peopleRows ?? []).flatMap((p: any) =>
        Array.isArray(p.faces) ? p.faces.map((f: any) => f.asset_id).filter(Boolean) : [])
    ));
    restrictIds = ids;
    if (ids.length === 0) {
      return c.json({ items: [], next_cursor: null, cache: { hit: false, ttl_seconds: 30 } });
    }
  }
  if (body.source_filter?.length) {
    const { data: sf } = await supa.from("asset_source_refs")
      .select("asset_id").in("source_account_id", body.source_filter);
    const ids = Array.from(new Set((sf ?? []).map((r: any) => r.asset_id)));
    if (restrictIds) {
      const setB = new Set(ids);
      restrictIds = restrictIds.filter((x) => setB.has(x));
    } else {
      restrictIds = ids;
    }
    if (restrictIds.length === 0) {
      return c.json({ items: [], next_cursor: null, total_count: 0, cache: { hit: false, ttl_seconds: 30 } });
    }
  }
  const countQuery = applyViewportFilters(
    supa.from("assets").select("id", { count: "exact", head: true }),
    body,
    restrictIds,
  );
  const { count: totalCount, error: countError } = await countQuery;
  if (countError) throw new ApiError("internal", countError.message);

  let q = applyViewportFilters(
    supa.from("assets")
    .select("id, capture_time, media_type, thumbnail_cache_key, blurhash, dominant_color, width, height")
    .order("capture_time", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(body.viewport_size),
    body,
    restrictIds,
  );
  if (cur?.before) q = q.lt("capture_time", cur.before);

  const { data, error } = await q;
  if (error) throw new ApiError("internal", error.message);
  const previewIds = (data ?? []).map((row: any) => row.id);
  const previewRows = previewIds.length
    ? await supa.from("asset_media_metadata")
      .select("asset_id, blurhash, dominant_color, thumbnail_url, thumbnail_storage_path, preview_url, preview_storage_path")
      .in("asset_id", previewIds)
    : { data: [] as any[] };
  const previewMap: Record<string, any> = {};
  for (const row of previewRows.data ?? []) previewMap[row.asset_id] = {
    asset_id: row.asset_id, blurhash: row.blurhash, dominant_color: row.dominant_color,
    thumbnail_cache_key: row.thumbnail_url ?? row.thumbnail_storage_path,
    preview_cache_key: row.preview_url ?? row.preview_storage_path,
  };
  const items = await Promise.all((data ?? []).map(r =>
    descriptorFromRow(c, supa, uid, {
      ...r,
      ...(previewMap[r.id] ?? {}),
      thumbnail_cache_key: previewMap[r.id]?.thumbnail_cache_key ?? r.thumbnail_cache_key,
      asset_id: r.id,
    })));
  const last = data?.[data.length - 1];
  const next_cursor = last?.capture_time ? encodeCursor({ before: last.capture_time }) : null;
  const out = { items, next_cursor, total_count: totalCount ?? 0 };
  await cache.set(c, cacheKey, out, 30, uid);
  emitEvent(c, "catalog.viewport", { size: items.length, cursor: !!body.cursor });
  return c.json({ ...out, cache: { hit: false, ttl_seconds: 30 } });
});

app.get("/dashboard", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const hit = await cache.get<any>(c, keys.dashboard(uid));
  if (hit) return c.json({ ...hit, cache: { hit: true } });

  // duplicate_groups dropped → duplicate count is distinct(duplicate_group_id)
  // on assets, computed in-process.
  const [assetsRes, sourceRefsRes] = await Promise.all([
    supa.from("assets")
      .select("id, capture_time, source_count, duplicate_group_id")
      .eq("deleted_state", "active"),
    supa.from("asset_source_refs")
      .select("asset_id, account:source_accounts(provider:source_providers(kind))"),
  ]);
  if (assetsRes.error) throw new ApiError("internal", assetsRes.error.message);
  if (sourceRefsRes.error) throw new ApiError("internal", sourceRefsRes.error.message);

  const assets = assetsRes.data ?? [];
  const total_assets = assets.length;
  const at_risk = assets.filter((asset: any) => (asset.source_count ?? 0) <= 1).length;
  const dupGroups = new Set(
    assets.map((a: any) => a.duplicate_group_id).filter(Boolean) as string[],
  );

  const per_year: Record<string, number> = {};
  for (const asset of assets) {
    if (!asset.capture_time) continue;
    const year = new Date(asset.capture_time).getUTCFullYear();
    if (!Number.isFinite(year)) continue;
    per_year[String(year)] = (per_year[String(year)] ?? 0) + 1;
  }

  const activeIds = new Set(assets.map((asset: any) => asset.id));
  const perSourceSets = new Map<string, Set<string>>();
  for (const row of sourceRefsRes.data ?? []) {
    if (!activeIds.has(row.asset_id)) continue;
    const kind = row.account?.provider?.kind ?? "unknown";
    if (!perSourceSets.has(kind)) perSourceSets.set(kind, new Set());
    perSourceSets.get(kind)!.add(row.asset_id);
  }
  const per_source = Object.fromEntries(Array.from(perSourceSets.entries()).map(([kind, ids]) => [kind, ids.size]));

  const data = {
    total_assets,
    at_risk,
    duplicate_groups: dupGroups.size,
    per_year,
    per_source,
  };
  await cache.set(c, keys.dashboard(uid), data, 60, uid);
  return c.json({ ...data, cache: { hit: false } });
});

Deno.serve(app.fetch);
