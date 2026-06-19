import { z } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody, parseQuery, parseParams } from "../_shared/validation.ts";
import { ApiError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { cache, keys, hashJson } from "../_shared/cache.ts";
import { queryParser, embedder } from "../_shared/interfaces.ts";
import { resolveThumbUrl } from "../_shared/signed-url.ts";
import { emitEvent } from "../_shared/observability.ts";

const SearchIn = z.object({
  query: z.string().min(1).max(500),
  filters: z.record(z.unknown()).optional(),
  k: z.number().int().min(1).max(200).default(50),
  mode: z.enum(["hybrid","vector","fts"]).default("hybrid"),
}).strict();

const app = authed(createApi("/search/v1"));

app.post("/search", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "search");
  const body = await parseBody(c, SearchIn);
  const start = Date.now();
  const qhash = await hashJson(body);
  const ck = keys.search(uid, qhash);
  const hit = await cache.get<any>(c, ck);
  if (hit) return c.json({ ...hit, cached: true });

  // ── Build LLM context string (query-type-aware, compact pipe-delimited) ──
  const needsPeople = /\b(me|myself|i\b|my |with |and [A-Z]|photos? of)\b/i.test(body.query)
    || /[A-Z][a-z]{1,20}/.test(body.query);
  const needsEvents = /\b(wedding|diwali|birthday|anniversary|trip|vacation|holiday|camping|festival|party|graduation|christmas|eid|holi|navratri|thanksgiving)\b/i.test(body.query)
    || /\b(our|my|the)\s+\w+\s+(of|in|at)\b/i.test(body.query);
  const needsPlaces = /\b(in|at|near|from|where|went|visited|traveled)\b/i.test(body.query);

  const [peopleCtxRows, eventCtxRows, placeCtxRows] = await Promise.all([
    needsPeople
      ? supa.from("people").select("id, display_name").eq("user_id", uid)
          .not("display_name", "is", null).limit(150)
      : Promise.resolve({ data: [] as Array<{ id: string; display_name: string }> }),
    needsEvents
      ? supa.from("events").select("id, title, start_time, end_time").eq("user_id", uid)
          .order("start_time", { ascending: false }).limit(100)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string | null; start_time: string | null; end_time: string | null }> }),
    needsPlaces
      ? supa.from("places").select("id, name").eq("user_id", uid).limit(80)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string | null }> }),
  ]);

  const ctxLines: string[] = [`today:${new Date().toISOString().slice(0, 10)}`];
  if ((peopleCtxRows.data ?? []).length) {
    ctxLines.push(`people:\n${(peopleCtxRows.data ?? []).map((p) => `${p.id}|${p.display_name}`).join("\n")}`);
  }
  if ((eventCtxRows.data ?? []).length) {
    ctxLines.push(`events:\n${(eventCtxRows.data ?? []).map((e) =>
      `${e.id}|${e.title ?? ""}|${e.start_time?.slice(0, 10) ?? ""}|${e.end_time?.slice(0, 10) ?? ""}`
    ).join("\n")}`);
  }
  if ((placeCtxRows.data ?? []).length) {
    ctxLines.push(`places:\n${(placeCtxRows.data ?? []).map((p) => `${p.id}|${p.name ?? ""}`).join("\n")}`);
  }
  const queryWithCtx = ctxLines.length > 1
    ? `${body.query}\n\n---\n${ctxLines.join("\n")}`
    : body.query;

  const parsed = await queryParser.parse(queryWithCtx);
  const vec = await embedder.embed(body.query);
  const filters = { ...(parsed.filterPlan ?? {}), ...(body.filters ?? {}) };

  // log query
  const { data: qlog } = await supa.from("search_queries").insert({
    user_id: uid, raw_query: body.query, parsed,
  }).select("id").single();

  // ── Person resolution (LLM-resolved UUIDs preferred, name-hint fallback) ──
  const resolvedAll: string[] = (parsed as any).people_ids_all_of ?? [];
  const resolvedAny: string[] = (parsed as any).people_ids_any_of ?? [];
  const isTemporalQuery = !!(parsed as any).is_temporal_query;

  let fallbackPersonIds: string[] = [];
  if (!resolvedAll.length && !resolvedAny.length) {
    const personNames: string[] = Array.isArray((parsed as any)?.entities?.people)
      ? (parsed as any).entities.people.filter((s: unknown) => typeof s === "string" && s.trim().length > 0)
      : [];
    const rawTokens = body.query.match(/\b[A-Z][a-zA-Z'\-]{1,30}\b/g) ?? [];
    const STOPWORDS = new Set([
      "I","Me","My","Mine","You","Your","We","Our","He","She","It","They","Them",
      "The","A","An","On","In","At","Of","For","With","And","Or","But","Last",
      "First","Time","Met","Meet","When","Where","What","Who","Why","How","Was",
      "Were","Is","Are","Did","Do","Does","Have","Has","Had","Show","Find","Photo",
      "Photos","Video","Videos","Picture","Pictures","Pic","Pics","Yesterday",
      "Today","Tomorrow","Summer","Winter","Spring","Fall","Autumn","Monday",
      "Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday","January",
      "February","March","April","May","June","July","August","September",
      "October","November","December",
    ]);
    const nameHints = Array.from(new Set([
      ...personNames,
      ...rawTokens.filter((t) => !STOPWORDS.has(t)),
    ]));
    if (nameHints.length) {
      const orFilter = nameHints.map((n) => `display_name.ilike.%${n.replace(/[,()]/g, "")}%`).join(",");
      const { data: peopleRows } = await supa.from("people").select("id, display_name")
        .eq("user_id", uid).not("display_name", "is", null).or(orFilter);
      fallbackPersonIds = (peopleRows ?? []).map((p) => p.id);
    }
  }

  const recencyRe = /\b(last|latest|recent|most recent|when (did|was)|when i|the last time)\b/i;
  const sortByRecent = recencyRe.test(body.query) || isTemporalQuery
    || resolvedAll.length > 0 || resolvedAny.length > 0 || fallbackPersonIds.length > 0;

  let rows: Array<{ asset_id: string; score: number; explanation: any }> = [];

  // ── Multi-person AND intersection ──────────────────────────────────────
  if (resolvedAll.length >= 2) {
    const _from = (filters as any).from ? new Date((filters as any).from).toISOString() : null;
    const _to   = (filters as any).to   ? new Date((filters as any).to).toISOString()   : null;
    const { data: intersectRows, error: iErr } = await supa.rpc("people_intersection_assets", {
      p_user_id: uid, p_person_ids: resolvedAll, p_from: _from, p_to: _to, p_k: body.k,
    });
    if (iErr) throw new ApiError("internal", iErr.message);
    rows = (intersectRows ?? []).map((r: any, idx: number) => ({
      asset_id: r.asset_id, score: 1.0 / (60 + idx),
      explanation: { mode: "person_intersection", people: resolvedAll, capture_time: r.capture_time },
    }));

  // ── Single person or OR (LLM-resolved or fallback) ─────────────────────
  } else {
    const activeIds = resolvedAll.length === 1 ? resolvedAll
      : resolvedAny.length > 0 ? resolvedAny
      : fallbackPersonIds;

    if (activeIds.length > 0) {
      const { data: faceRows, error: fErr } = await supa
        .from("asset_faces").select("asset_id, person_id")
        .eq("user_id", uid).in("person_id", activeIds).limit(2000);
      if (fErr) throw new ApiError("internal", fErr.message);

      const uniqueAssetIds = Array.from(new Set((faceRows ?? []).map((r: any) => r.asset_id as string)));
      if (uniqueAssetIds.length) {
        const _from = (filters as any).from ? new Date((filters as any).from).toISOString() : null;
        const _to   = (filters as any).to   ? new Date((filters as any).to).toISOString()   : null;
        const _media = typeof (filters as any).media_type === "string" ? (filters as any).media_type : undefined;
        let q = supa.from("assets").select("id, capture_time").eq("user_id", uid)
          .eq("deleted_state", "active").in("id", uniqueAssetIds)
          .order("capture_time", { ascending: false, nullsFirst: false }).limit(body.k);
        if (_from) q = q.gte("capture_time", _from);
        if (_to)   q = q.lte("capture_time", _to);
        if (_media && _media !== "any") q = q.eq("media_type", _media);
        const { data: matched, error: aErr } = await q;
        if (aErr) throw new ApiError("internal", aErr.message);
        rows = (matched ?? []).map((a: any, idx: number) => ({
          asset_id: a.id, score: 1.0 / (60 + idx),
          explanation: { mode: "person", people: activeIds, capture_time: a.capture_time },
        }));
      }
    }
  }

  // ── Event filter ──────────────────────────────────────────────────────
  const resolvedEventIds: string[] = (parsed as any).event_ids ?? [];
  if (!rows.length && resolvedEventIds.length) {
    const { data: evAssets } = await supa.from("event_assets")
      .select("asset_id").in("event_id", resolvedEventIds).limit(body.k * 2);
    const evAssetIds = (evAssets ?? []).map((r: any) => r.asset_id as string);
    if (evAssetIds.length) {
      const { data: matched } = await supa.from("assets").select("id, capture_time")
        .eq("user_id", uid).eq("deleted_state", "active").in("id", evAssetIds)
        .order("capture_time", { ascending: false, nullsFirst: false }).limit(body.k);
      rows = (matched ?? []).map((a: any, idx: number) => ({
        asset_id: a.id, score: 1.0 / (60 + idx),
        explanation: { mode: "event", event_ids: resolvedEventIds, capture_time: a.capture_time },
      }));
    }
  }

  // ── Place/GPS filter ──────────────────────────────────────────────────
  const resolvedPlaceIds: string[] = (parsed as any).place_ids ?? [];
  if (!rows.length && resolvedPlaceIds.length) {
    const { data: placeRows } = await supa.from("places").select("id, lat, lng").in("id", resolvedPlaceIds);
    const RADIUS_DEG = 0.5;
    let gpsAssetIds: string[] = [];
    for (const place of placeRows ?? []) {
      if (place.lat == null || place.lng == null) continue;
      const { data: gpsRows } = await supa.from("asset_gps").select("asset_id")
        .eq("user_id", uid)
        .gte("gps_latitude",  place.lat - RADIUS_DEG).lte("gps_latitude",  place.lat + RADIUS_DEG)
        .gte("gps_longitude", place.lng - RADIUS_DEG).lte("gps_longitude", place.lng + RADIUS_DEG)
        .limit(body.k);
      gpsAssetIds.push(...(gpsRows ?? []).map((r: any) => r.asset_id as string));
    }
    gpsAssetIds = Array.from(new Set(gpsAssetIds));
    if (gpsAssetIds.length) {
      const _from = (filters as any).from ? new Date((filters as any).from).toISOString() : null;
      const _to   = (filters as any).to   ? new Date((filters as any).to).toISOString()   : null;
      let q = supa.from("assets").select("id, capture_time").eq("user_id", uid)
        .eq("deleted_state", "active").in("id", gpsAssetIds)
        .order("capture_time", { ascending: false, nullsFirst: false }).limit(body.k);
      if (_from) q = q.gte("capture_time", _from);
      if (_to)   q = q.lte("capture_time", _to);
      const { data: matched } = await q;
      rows = (matched ?? []).map((a: any, idx: number) => ({
        asset_id: a.id, score: 1.0 / (60 + idx),
        explanation: { mode: "gps", place_ids: resolvedPlaceIds, capture_time: a.capture_time },
      }));
    }
  }

  // ── Fallback: FTS hybrid search ───────────────────────────────────────
  if (!rows.length) {
    const { data: rpcRows, error } = await supa.rpc("hybrid_search", {
      _query_text: body.query, _query_vector: vec, _filters: filters, _k: body.k,
    });
    if (error) throw new ApiError("internal", error.message);
    rows = (rpcRows ?? []) as any;
    if (sortByRecent && rows.length) {
      const idList = rows.map((r) => r.asset_id);
      const { data: dated } = await supa.from("assets").select("id, capture_time").in("id", idList);
      const tMap = new Map((dated ?? []).map((a: any) => [a.id, a.capture_time as string | null]));
      rows.sort((a, b) => (tMap.get(b.asset_id) ?? "").localeCompare(tMap.get(a.asset_id) ?? ""));
    }
  }

  // ── Temporal query: keep only the single most recent result ───────────
  if (isTemporalQuery && rows.length > 1) rows = rows.slice(0, 1);

  const ids = rows.map((r) => r.asset_id);
  let assetMap: Record<string, any> = {};
  if (ids.length) {
    const { data: assets } = await supa.from("assets")
      .select("id, capture_time, media_type, thumbnail_cache_key, blurhash, dominant_color, width, height")
      .in("id", ids);
    for (const a of assets ?? []) assetMap[a.id] = a;
    const { data: mm } = await supa.from("asset_media_metadata")
      .select("asset_id, blurhash, dominant_color, thumbnail_url, thumbnail_storage_path")
      .in("asset_id", ids);
    for (const row of mm ?? []) {
      const preview = {
        asset_id: row.asset_id, blurhash: row.blurhash, dominant_color: row.dominant_color,
        thumbnail_cache_key: row.thumbnail_url ?? row.thumbnail_storage_path,
      };
      assetMap[preview.asset_id] = {
        ...assetMap[preview.asset_id],
        ...preview,
        thumbnail_cache_key: preview.thumbnail_cache_key ?? assetMap[preview.asset_id]?.thumbnail_cache_key ?? null,
      };
    }
  }
  const results = await Promise.all(rows.map(async (r: any) => {
    const a = assetMap[r.asset_id];
    if (!a) return null;
    const thumbnail_url = await resolveThumbUrl(c, supa, uid, a.id, a.thumbnail_cache_key);
    return {
      asset_id: a.id,
      thumbnail_url, blurhash: a.blurhash, dominant_color: a.dominant_color,
      width: a.width, height: a.height, capture_time: a.capture_time,
      media_type: a.media_type, source_badge: null,
      hydration_status: a.thumbnail_cache_key ? "ready" : "pending",
      next_quality_url: null, original_fetch_policy: "on_demand",
      cache_status: "warm", prefetch_hint: false,
      score: Number(r.score), explanation: r.explanation,
    };
  }));
  const filtered = results.filter(Boolean);

  const { data: facets } = await supa.rpc("get_facets", { _filters: filters });

  const out = {
    query_id: qlog?.id ?? null, results: filtered, facets: facets ?? {}, parsed,
    friendly_response: (parsed as any).friendly_response ?? null,
    zero_result_suggestions: filtered.length === 0
      ? ["Try removing filters", "Use simpler keywords", "Search by year (e.g. 2023)"]
      : undefined,
  };
  await cache.set(c, ck, out, 300, uid);

  const ms = Date.now() - start;
  await supa.from("search_queries").update({
    result_count: filtered.length, latency_ms: ms,
  }).eq("id", qlog?.id);

  emitEvent(c, "search.run", { ms, results: filtered.length });
  return c.json({ ...out, cached: false });
});

app.get("/facets", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const { filters } = parseQuery(c, z.object({ filters: z.string().optional() }));
  const f = filters ? JSON.parse(filters) : {};
  const fh = await hashJson(f);
  const hit = await cache.get<any>(c, keys.facets(uid, fh));
  if (hit) return c.json({ facets: hit, cache: { hit: true } });
  const { data, error } = await supa.rpc("get_facets", { _filters: f });
  if (error) throw new ApiError("internal", error.message);
  await cache.set(c, keys.facets(uid, fh), data, 120, uid);
  return c.json({ facets: data, cache: { hit: false } });
});

app.get("/:query_id", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { query_id } = parseParams(c, z.object({ query_id: z.string().uuid() }));
  const { data, error } = await supa.from("search_queries").select("*").eq("id", query_id).maybeSingle();
  if (error || !data) throw new ApiError("not_found", "Query not found");
  // Replay via cache key derived from parsed object (best-effort)
  return c.json({ query: data });
});

Deno.serve(app.fetch);
