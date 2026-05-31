import { z } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody, parseQuery, parseParams } from "../_shared/validation.ts";
import { ApiError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { jobEnqueuer } from "../_shared/interfaces.ts";
import { findIdempotent, storeIdempotent } from "../_shared/idempotency.ts";
import { hashJson } from "../_shared/cache.ts";
import { emitEvent } from "../_shared/observability.ts";

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
  return c.json({ events: data ?? [] });
});

app.get("/events/:id", async (c) => {
  const supa = c.get("supabase");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const [{ data: event }, { data: eAssets }, { data: ePeople }, { data: ePlaces }] = await Promise.all([
    supa.from("events").select("*").eq("id", id).maybeSingle(),
    supa.from("event_assets").select("asset_id, assets(*)").eq("event_id", id),
    supa.from("event_people").select("person_id, people(*)").eq("event_id", id),
    supa.from("event_places").select("place_id, places(*)").eq("event_id", id),
  ]);
  if (!event) throw new ApiError("not_found", "Event not found");
  return c.json({ event, assets: eAssets, people: ePeople, places: ePlaces });
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
  return c.json({ people: data ?? [], face_processing_disabled: false });
});

app.get("/people/:id", async (c) => {
  const supa = c.get("supabase");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const [{ data: person }, { data: faces }] = await Promise.all([
    supa.from("people").select("*").eq("id", id).maybeSingle(),
    supa.from("person_faces").select("asset_id, confidence").eq("person_id", id).limit(50),
  ]);
  if (!person) throw new ApiError("not_found", "Person not found");
  return c.json({ person, faces });
});

app.get("/places", async (c) => {
  const supa = c.get("supabase");
  const { data, error } = await supa.from("places").select("*").limit(500);
  if (error) throw new ApiError("internal", error.message);
  return c.json({ places: data ?? [] });
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

Deno.serve(app.fetch);
