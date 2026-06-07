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

  const parsed = await queryParser.parse(body.query);
  const vec = await embedder.embed(body.query);
  const filters = { ...(parsed.filterPlan ?? {}), ...(body.filters ?? {}) };

  // log query
  const { data: qlog } = await supa.from("search_queries").insert({
    user_id: uid, raw_query: body.query, parsed,
  }).select("id").single();

  const { data: rows, error } = await supa.rpc("hybrid_search", {
    _query_text: body.query, _query_vector: vec, _filters: filters, _k: body.k,
  });
  if (error) throw new ApiError("internal", error.message);

  const ids = (rows ?? []).map((r: any) => r.asset_id);
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
  const results = await Promise.all((rows ?? []).map(async (r: any) => {
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
