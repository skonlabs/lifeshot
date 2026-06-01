import { z } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody, parseQuery, parseParams } from "../_shared/validation.ts";
import { ApiError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { jobEnqueuer } from "../_shared/interfaces.ts";
import { findIdempotent, storeIdempotent } from "../_shared/idempotency.ts";
import { hashJson } from "../_shared/cache.ts";
import { emitEvent } from "../_shared/observability.ts";
import { resolveThumbUrl } from "../_shared/signed-url.ts";

const ListPage = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const app = authed(createApi("/organization/v1"));

app.get("/events", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { limit } = parseQuery(c, ListPage);
  await enforceRateLimit(uid, "general");
  const { data, error } = await supa.from("events")
    .select("id, title, start_time, end_time, confidence")
    .order("start_time", { ascending: false }).limit(limit);
  if (error) throw new ApiError("internal", error.message);
  const events = data ?? [];
  const ids = events.map((e: any) => e.id);
  const coverMap: Record<string, string> = {};
  const countMap: Record<string, number> = {};
  if (ids.length) {
    const { data: ea } = await supa.from("event_assets")
      .select("event_id, asset_id").in("event_id", ids);
    for (const row of ea ?? []) {
      if (!coverMap[row.event_id]) coverMap[row.event_id] = row.asset_id;
      countMap[row.event_id] = (countMap[row.event_id] ?? 0) + 1;
    }
  }
  const coverAssetIds = Array.from(new Set(Object.values(coverMap)));
  const covers: Record<string, any> = {};
  if (coverAssetIds.length) {
    const { data: cs } = await supa.from("assets")
      .select("id, thumbnail_cache_key, blurhash, dominant_color, media_type")
      .in("id", coverAssetIds);
    for (const c2 of cs ?? []) covers[c2.id] = c2;
  }
  const enriched = await Promise.all(events.map(async (e: any) => {
    const cid = coverMap[e.id];
    const cov = cid && covers[cid] ? covers[cid] : null;
    return {
      ...e,
      asset_count: countMap[e.id] ?? 0,
      cover: cov ? {
        asset_id: cid,
        thumbnail_url: await resolveThumbUrl(c, supa, uid, cid, cov.thumbnail_cache_key ?? null),
        blurhash: cov.blurhash ?? null,
        dominant_color: cov.dominant_color ?? null,
        media_type: cov.media_type ?? "photo",
      } : null,
    };
  }));
  return c.json({ events: enriched });
});

app.get("/events/:id", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const [{ data: event }, { data: eAssets }, { data: ePeople }, { data: ePlaces }] = await Promise.all([
    supa.from("events").select("*").eq("id", id).maybeSingle(),
    supa.from("event_assets").select("asset_id, assets(id, thumbnail_cache_key, blurhash, dominant_color, media_type, width, height)").eq("event_id", id).limit(200),
    supa.from("event_people").select("person_id, people(*)").eq("event_id", id),
    supa.from("event_places").select("place_id, places(*)").eq("event_id", id),
  ]);
  if (!event) throw new ApiError("not_found", "Event not found");
  const assets = await Promise.all((eAssets ?? []).map(async (row: any) => {
    const a = row.assets ?? {};
    return {
      asset_id: row.asset_id,
      thumbnail_url: await resolveThumbUrl(c, supa, uid, row.asset_id, a.thumbnail_cache_key ?? null),
      blurhash: a.blurhash ?? null,
      dominant_color: a.dominant_color ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
      media_type: a.media_type ?? "photo",
      source_badge: null,
      hydration_status: "ready" as const,
    };
  }));
  return c.json({
    ...event,
    asset_count: assets.length,
    assets,
    people: ePeople,
    places: ePlaces,
  });
});

app.get("/people", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const { data: privacy } = await supa.from("privacy_settings")
    .select("face_processing_enabled").eq("user_id", uid).maybeSingle();
  if (!privacy?.face_processing_enabled) {
    return c.json({ people: [], face_processing_disabled: true });
  }
  const { data, error } = await supa.from("people")
    .select("id, display_name, is_child, is_elder, consent_required");
  if (error) throw new ApiError("internal", error.message);
  const peopleRows = data ?? [];
  const ids = peopleRows.map((p: any) => p.id);
  const counts: Record<string, number> = {};
  if (ids.length) {
    const { data: faces } = await supa.from("person_faces")
      .select("person_id, asset_id").in("person_id", ids);
    const seen: Record<string, Set<string>> = {};
    for (const f of faces ?? []) {
      (seen[f.person_id] ??= new Set()).add(f.asset_id);
    }
    for (const [pid, s] of Object.entries(seen)) counts[pid] = s.size;
  }
  const people = peopleRows.map((p: any) => ({ ...p, asset_count: counts[p.id] ?? 0 }));
  return c.json({ people, face_processing_disabled: false });
});

app.get("/people/:id", async (c) => {
  const supa = c.get("supabase");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const [{ data: person }, { data: faces }] = await Promise.all([
    supa.from("people").select("*").eq("id", id).maybeSingle(),
    supa.from("person_faces").select("asset_id, confidence").eq("person_id", id).limit(50),
  ]);
  if (!person) throw new ApiError("not_found", "Person not found");
  const asset_count = new Set((faces ?? []).map((f: any) => f.asset_id)).size;
  return c.json({ ...person, person, asset_count, faces });
});

app.get("/places", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { data, error } = await supa.from("places").select("*").limit(500);
  if (error) throw new ApiError("internal", error.message);
  const placeRows = data ?? [];
  const ids = placeRows.map((p: any) => p.id);
  const counts: Record<string, number> = {};
  if (ids.length) {
    const { data: ep } = await supa.from("event_places")
      .select("place_id, event_id").in("place_id", ids);
    const byPlace: Record<string, string[]> = {};
    for (const r of ep ?? []) (byPlace[r.place_id] ??= []).push(r.event_id);
    const allEventIds = Array.from(new Set((ep ?? []).map((r: any) => r.event_id)));
    const evCount: Record<string, number> = {};
    if (allEventIds.length) {
      const { data: ea } = await supa.from("event_assets")
        .select("event_id, asset_id").in("event_id", allEventIds);
      for (const r of ea ?? []) evCount[r.event_id] = (evCount[r.event_id] ?? 0) + 1;
    }
    for (const [pid, evIds] of Object.entries(byPlace)) {
      counts[pid] = evIds.reduce((acc, eid) => acc + (evCount[eid] ?? 0), 0);
    }
  }
  const places = placeRows.map((p: any) => ({ ...p, asset_count: counts[p.id] ?? 0 }));
  return c.json({ places });
});

app.get("/duplicates", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const { data: groups, error } = await supa.from("duplicate_groups")
    .select("*").eq("status", "open").order("storage_risk", { ascending: false }).limit(100);
  if (error) throw new ApiError("internal", error.message);
  const ids = (groups ?? []).map(g => g.id);
  const members: Record<string, any[]> = {};
  if (ids.length) {
    const { data: ms } = await supa.from("duplicate_group_members")
      .select("group_id, asset_id, match_type, score").in("group_id", ids);
    for (const m of ms ?? []) (members[m.group_id] ??= []).push(m);
  }
  return c.json({
    groups: (groups ?? []).map(g => ({ ...g, members: members[g.id] ?? [] })),
  });
});

const ConfirmIn = z.object({
  action: z.enum(["keep_primary","keep_all","mark_reviewed"]),
  primary_asset_id: z.string().uuid().optional(),
}).strict();

app.post("/duplicates/:id/confirm", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const body = await parseBody(c, ConfirmIn);
  const reqHash = await hashJson({ id, ...body });
  const idem = await findIdempotent(c, "dup.confirm", reqHash);
  if (idem && "conflict" in idem) throw new ApiError("conflict", "Idempotency-Key reused");
  if (idem?.response) return c.json(idem.response, idem.status as 200);

  const update: Record<string, unknown> = { status: "reviewed" };
  if (body.action === "keep_primary" && body.primary_asset_id) {
    update.recommended_primary_asset_id = body.primary_asset_id;
  }
  const { error } = await supa.from("duplicate_groups").update(update).eq("id", id);
  if (error) throw new ApiError("internal", error.message);
  await supa.from("audit_logs").insert({
    user_id: uid, action: "duplicate.confirm", target_type: "duplicate_group",
    target_id: id, meta: body,
  });
  const out = { ok: true, action: body.action };
  await storeIdempotent(c, "dup.confirm", reqHash, out, 200);
  emitEvent(c, "organization.dup_confirm", { id, action: body.action });
  return c.json(out);
});

const CorrectionIn = z.object({
  target_type: z.enum(["asset","person","event","place","duplicate_group"]),
  target_id: z.string().uuid(),
  correction: z.record(z.unknown()),
}).strict();

app.post("/corrections", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  const body = await parseBody(c, CorrectionIn);
  const reqHash = await hashJson(body);
  const idem = await findIdempotent(c, "corrections", reqHash);
  if (idem && "conflict" in idem) throw new ApiError("conflict", "Idempotency-Key reused");
  if (idem?.response) return c.json(idem.response, idem.status as 200);

  const { data, error } = await supa.from("user_corrections").insert({
    user_id: uid, target_type: body.target_type, target_id: body.target_id, correction: body.correction,
  }).select("id").single();
  if (error) throw new ApiError("internal", error.message);
  // Translate the correction into a downstream re-index job. For people we
  // re-run face clustering; for other entities we just record the correction
  // (search reindex picks up the changes on next pipeline pass).
  let job_id: string | null = null;
  if (body.target_type === "person") {
    const job = await jobEnqueuer.enqueue("clusterPeople",
      { user_id: uid, target_person_id: body.target_id, correction: body.correction },
      { userId: uid });
    job_id = job.id;
  }
  const out = { id: data!.id, job_id };
  await storeIdempotent(c, "corrections", reqHash, out, 200);
  emitEvent(c, "organization.correction", { type: body.target_type });
  return c.json(out);
});

const BulkAssetsIn = z.object({
  asset_ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["trash", "restore", "tag"]),
  tag: z.string().min(1).max(60).optional(),
}).strict();

app.post("/assets/bulk", async (c) => {
  const supa = c.get("supabase"); const uid = c.get("userId");
  await enforceRateLimit(uid, "general");
  const body = await parseBody(c, BulkAssetsIn);
  if (body.action === "tag" && !body.tag) {
    throw new ApiError("validation", "tag is required for action=tag");
  }
  let affected = 0;
  if (body.action === "trash" || body.action === "restore") {
    const next = body.action === "trash" ? "soft_deleted" : "active";
    const { data, error } = await supa.from("assets")
      .update({ deleted_state: next })
      .in("id", body.asset_ids)
      .select("id");
    if (error) throw new ApiError("internal", error.message);
    affected = data?.length ?? 0;
  } else if (body.action === "tag") {
    const rows = body.asset_ids.map((asset_id) => ({
      user_id: uid, target_type: "asset", target_id: asset_id,
      correction: { add_tag: body.tag },
    }));
    const { error } = await supa.from("user_corrections").insert(rows);
    if (error) throw new ApiError("internal", error.message);
    affected = rows.length;
  }
  await supa.from("audit_logs").insert({
    user_id: uid, action: `asset.bulk_${body.action}`, target_type: "asset",
    target_id: body.asset_ids[0], meta: { count: body.asset_ids.length, tag: body.tag ?? null },
  });
  emitEvent(c, "organization.bulk_action", { action: body.action, count: body.asset_ids.length });
  return c.json({ affected, action: body.action });
});

Deno.serve(app.fetch);
