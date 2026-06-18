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

const VALID_MEDIA_TYPES = new Set(["photo", "video", "live_photo", "animation", "document", "audio", "unknown"]);

function normalizeSearchFilters(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  const rawMedia = Array.isArray(out.media_type) ? out.media_type[0] : out.media_type;
  const mediaType = typeof rawMedia === "string" ? rawMedia.trim().toLowerCase() : "";
  if (!mediaType || mediaType === "any" || mediaType === "all") {
    delete out.media_type;
  } else if (VALID_MEDIA_TYPES.has(mediaType)) {
    out.media_type = mediaType;
  } else {
    delete out.media_type;
  }
  return out;
}

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
  const filters = normalizeSearchFilters({ ...(parsed.filterPlan ?? {}), ...(body.filters ?? {}) });

  // log query
  const { data: qlog } = await supa.from("search_queries").insert({
    user_id: uid, raw_query: body.query, parsed,
  }).select("id").single();

  // ── Person-name resolution ──────────────────────────────────────────────
  // If the parsed query mentions a person (or the raw text contains a known
  // person's display_name), resolve those to person_ids and short-circuit to
  // an asset_faces lookup. Full-text search on "Bittu" returns nothing —
  // names live in `people.display_name`, not in `assets.search_content`.
  const personNames: string[] = Array.isArray((parsed as any)?.entities?.people)
    ? (parsed as any).entities.people.filter((s: unknown) => typeof s === "string" && s.trim().length > 0)
    : [];

  // Also harvest capitalized tokens from the raw query as fallback name hints
  // (parser sometimes misses single-word names).
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

  // Look up matching people by display_name (case-insensitive).
  let personIds: string[] = [];
  let matchedPeople: Array<{ id: string; display_name: string | null }> = [];
  if (nameHints.length) {
    const orFilter = nameHints
      .map((n) => `display_name.ilike.%${n.replace(/[,()]/g, "")}%`)
      .join(",");
    const { data: peopleRows } = await supa
      .from("people")
      .select("id, display_name")
      .eq("user_id", uid)
      .not("display_name", "is", null)
      .or(orFilter);
    matchedPeople = peopleRows ?? [];
    personIds = matchedPeople.map((p) => p.id);
  }

  // Detect "last/latest/recent/when did/most recent" → sort by capture_time desc.
  const recencyRe = /\b(last|latest|recent|most recent|when (did|was)|when i|the last time)\b/i;
  const sortByRecent = recencyRe.test(body.query) || personIds.length > 0;

  let rows: Array<{ asset_id: string; score: number; explanation: any }> = [];

  if (personIds.length > 0) {
    // Person-scoped lookup: every asset that contains at least one face linked
    // to one of the matched people, with all date/media filters applied.
    const { data: faceRows, error: fErr } = await supa
      .from("asset_faces")
      .select("asset_id, person_id")
      .eq("user_id", uid)
      .in("person_id", personIds)
      .limit(2000);
    if (fErr) throw new ApiError("internal", fErr.message);

    const uniqueAssetIds = Array.from(new Set((faceRows ?? []).map((r: any) => r.asset_id as string)));
    if (uniqueAssetIds.length) {
      const _from = (filters as any).from ? new Date((filters as any).from).toISOString() : null;
      const _to = (filters as any).to ? new Date((filters as any).to).toISOString() : null;
      const _media = typeof filters.media_type === "string" ? filters.media_type : undefined;

      let q = supa
        .from("assets")
        .select("id, capture_time")
        .eq("user_id", uid)
        .eq("deleted_state", "active")
        .in("id", uniqueAssetIds)
        .order("capture_time", { ascending: false, nullsFirst: false })
        .limit(body.k);
      if (_from) q = q.gte("capture_time", _from);
      if (_to) q = q.lte("capture_time", _to);
      if (_media) q = q.eq("media_type", _media);

      const { data: matched, error: aErr } = await q;
      if (aErr) throw new ApiError("internal", aErr.message);
      rows = (matched ?? []).map((a: any, idx: number) => ({
        asset_id: a.id,
        score: 1.0 / (60 + idx),
        explanation: {
          mode: "person",
          people: matchedPeople.map((p) => p.display_name),
          capture_time: a.capture_time,
        },
      }));
    }
  } else {
    // Fallback: original FTS-based hybrid search.
    const { data: rpcRows, error } = await supa.rpc("hybrid_search", {
      _query_text: body.query, _query_vector: vec, _filters: filters, _k: body.k,
    });
    if (error) throw new ApiError("internal", error.message);
    rows = (rpcRows ?? []) as any;

    // If asked for recency, re-sort by capture_time desc.
    if (sortByRecent && rows.length) {
      const idList = rows.map((r) => r.asset_id);
      const { data: dated } = await supa
        .from("assets")
        .select("id, capture_time")
        .in("id", idList);
      const tMap = new Map((dated ?? []).map((a: any) => [a.id, a.capture_time as string | null]));
      rows.sort((a, b) => {
        const ta = tMap.get(a.asset_id) ?? "";
        const tb = tMap.get(b.asset_id) ?? "";
        return tb.localeCompare(ta);
      });
    }
  }

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
  const f = normalizeSearchFilters(filters ? JSON.parse(filters) : {});
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
