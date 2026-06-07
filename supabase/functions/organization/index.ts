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
import { faceQualityScore, faceVisualSignature, sanitizeFaceBox } from "../_shared/face-box.ts";

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
  const mediaMap: Record<string, any> = {};
  if (coverAssetIds.length) {
    const { data: cs } = await supa.from("assets")
      .select("id, thumbnail_cache_key, blurhash, dominant_color, media_type")
      .in("id", coverAssetIds);
    for (const c2 of cs ?? []) covers[c2.id] = c2;
    // asset_preview_metadata dropped → blurhash/dominant_color/thumbnail come
    // from asset_media_metadata.
    const { data: mm } = await supa.from("asset_media_metadata")
      .select("asset_id, blurhash, dominant_color, thumbnail_url, thumbnail_storage_path")
      .in("asset_id", coverAssetIds);
    for (const row of mm ?? []) mediaMap[row.asset_id] = row;
  }
  const enriched = await Promise.all(events.map(async (e: any) => {
    const cid = coverMap[e.id];
    const cov = cid && covers[cid] ? covers[cid] : null;
    const mm = cid ? mediaMap[cid] ?? null : null;
    return {
      ...e,
      asset_count: countMap[e.id] ?? 0,
      cover: cov ? {
        asset_id: cid,
        thumbnail_url: await resolveThumbUrl(c, supa, uid, cid,
          mm?.thumbnail_url ?? mm?.thumbnail_storage_path ?? cov.thumbnail_cache_key ?? null),
        blurhash: mm?.blurhash ?? cov.blurhash ?? null,
        dominant_color: mm?.dominant_color ?? cov.dominant_color ?? null,
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
  const assetIds = (eAssets ?? []).map((r: any) => r.asset_id);
  const mediaMap: Record<string, any> = {};
  if (assetIds.length) {
    const { data: mm } = await supa.from("asset_media_metadata")
      .select("asset_id, blurhash, dominant_color, thumbnail_url, thumbnail_storage_path")
      .in("asset_id", assetIds);
    for (const row of mm ?? []) mediaMap[row.asset_id] = row;
  }
  const assets = await Promise.all((eAssets ?? []).map(async (row: any) => {
    const a = row.assets ?? {};
    const mm = mediaMap[row.asset_id] ?? null;
    return {
      asset_id: row.asset_id,
      thumbnail_url: await resolveThumbUrl(c, supa, uid, row.asset_id,
        mm?.thumbnail_url ?? mm?.thumbnail_storage_path ?? a.thumbnail_cache_key ?? null),
      blurhash: mm?.blurhash ?? a.blurhash ?? null,
      dominant_color: mm?.dominant_color ?? a.dominant_color ?? null,
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
    .select("id, display_name, is_child, is_elder, consent_required, auto_label");
  if (error) throw new ApiError("internal", error.message);
  const peopleRows = data ?? [];
  const ids = peopleRows.map((p: any) => p.id);
  const counts: Record<string, number> = {};
  const coverMap: Record<string, string> = {};
  const coverBboxMap: Record<string, any> = {};
  const faceCountMap: Record<string, number> = {};
  const signatureMap: Record<string, string> = {};
  if (ids.length) {
    const { data: faces } = await supa.from("person_faces")
      .select("person_id, asset_id, bbox, confidence, created_at, face_vector, face_crop").in("person_id", ids)
      .order("confidence", { ascending: false, nullsFirst: false });
    const seen: Record<string, Set<string>> = {};
    const perAssetFaceCount = new Map<string, number>();
    const signatureOwner = new Map<string, { person_id: string; confidence: number }>();
    const bestCoverScore = new Map<string, number>();
    const coverFaceCropMap: Record<string, string | null> = {};

    const signatureFor = (assetId: string, bbox: { x?: number; y?: number; w?: number; h?: number } | null | undefined, vector: number[] | null | undefined) => {
      const safeBox = sanitizeFaceBox(bbox);
      const bboxPart = safeBox
        ? faceVisualSignature(assetId, safeBox)
        : "no-bbox";
      const vectorPart = Array.isArray(vector) && vector.length
        ? vector.slice(0, 12).map((n) => Number(n).toFixed(4)).join(":")
        : "no-vector";
      return `${bboxPart}:${vectorPart}`;
    };

    for (const f of faces ?? []) perAssetFaceCount.set(f.asset_id, (perAssetFaceCount.get(f.asset_id) ?? 0) + 1);
    for (const f of faces ?? []) {
      const safeBox = sanitizeFaceBox(f.bbox ?? null);
      if (!safeBox) continue;
      const signature = signatureFor(f.asset_id, safeBox, Array.isArray(f.face_vector) ? f.face_vector as number[] : null);
      const owner = signatureOwner.get(signature);
      if (owner && owner.person_id !== f.person_id) continue;
      signatureOwner.set(signature, {
        person_id: f.person_id,
        confidence: Math.max(Number(f.confidence ?? 0), owner?.confidence ?? 0),
      });
      signatureMap[f.person_id] = signature;
      const score = faceQualityScore(safeBox, Number(f.confidence ?? 0), perAssetFaceCount.get(f.asset_id) ?? 1);
      const previousScore = bestCoverScore.get(f.person_id) ?? Number.NEGATIVE_INFINITY;
      if (score > previousScore) {
        coverMap[f.person_id] = f.asset_id;
        coverBboxMap[f.person_id] = safeBox;
        faceCountMap[f.person_id] = perAssetFaceCount.get(f.asset_id) ?? 1;
        coverFaceCropMap[f.person_id] = typeof f.face_crop === "string" ? f.face_crop : null;
        bestCoverScore.set(f.person_id, score);
      }
      (seen[f.person_id] ??= new Set()).add(f.asset_id);
    }
    for (const f of faces ?? []) {
      const safeBox = sanitizeFaceBox(f.bbox ?? null);
      if (!safeBox) continue;
      if (!coverMap[f.person_id]) {
        coverMap[f.person_id] = f.asset_id;
        coverBboxMap[f.person_id] = safeBox;
        faceCountMap[f.person_id] = perAssetFaceCount.get(f.asset_id) ?? 1;
        coverFaceCropMap[f.person_id] = typeof f.face_crop === "string" ? f.face_crop : null;
      }
    }
    for (const [pid, s] of Object.entries(seen)) counts[pid] = s.size;
    // Stash cover crop map in outer closure scope via Object so it's readable below.
    (peopleRows as any).__coverFaceCropMap = coverFaceCropMap;
  }

  const coverIds = Array.from(new Set(Object.values(coverMap)));
  const coverAssets: Record<string, any> = {};
  const previewMap: Record<string, any> = {};
  if (coverIds.length) {
    const { data: assets } = await supa.from("assets")
      .select("id, thumbnail_cache_key, proxy_cache_key, blurhash, dominant_color, media_type, width, height, capture_time")
      .in("id", coverIds);
    for (const asset of assets ?? []) coverAssets[asset.id] = asset;

    const { data: previews } = await supa.from("asset_preview_metadata")
      .select("asset_id, thumbnail_cache_key, preview_cache_key, blurhash, dominant_color")
      .in("asset_id", coverIds);
    for (const preview of previews ?? []) previewMap[preview.asset_id] = preview;
  }

  const people = (await Promise.all(peopleRows.map(async (p: any) => {
    const coverAssetId = coverMap[p.id] ?? null;
    const asset = coverAssetId ? coverAssets[coverAssetId] ?? null : null;
    const preview = coverAssetId ? previewMap[coverAssetId] ?? null : null;
    const faceCropDataUrl = (peopleRows as any).__coverFaceCropMap?.[p.id] ?? null;
    const cover = coverAssetId && asset ? {
      asset_id: coverAssetId,
      // Prefer the pre-aligned 48x48 face_crop produced by face-api.js in the browser.
      // Fall back to the asset thumbnail if for some reason a crop wasn't stored.
      thumbnail_url: faceCropDataUrl ?? await resolveThumbUrl(
        c,
        supa,
        uid,
        coverAssetId,
        preview?.thumbnail_cache_key ?? asset.thumbnail_cache_key ?? preview?.preview_cache_key ?? asset.proxy_cache_key ?? null,
        "thumb",
      ),
      blurhash: preview?.blurhash ?? asset.blurhash ?? null,
      dominant_color: preview?.dominant_color ?? asset.dominant_color ?? null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      capture_time: asset.capture_time ?? null,
      media_type: asset.media_type ?? "photo",
      source_badge: null,
      // When face_crop is used, the image IS the face — no further cropping needed.
      face_bbox: faceCropDataUrl ? null : (coverBboxMap[p.id] ?? null),
      face_count: faceCountMap[p.id] ?? 1,
      hydration_status: (faceCropDataUrl || preview?.thumbnail_cache_key || asset.thumbnail_cache_key ? "ready" : "pending") as const,
    } : null;

    return { ...p, asset_count: counts[p.id] ?? 0, cover };
  }))).filter((person: any) => {
    if (person.auto_label === "auto:unclustered-faces") return false;
    if (!(person.asset_count > 0)) return false;
    if (!person.cover?.thumbnail_url) return false;
    return true;
  }).filter((person: any, index: number, arr: any[]) => {
    const signature = signatureMap[person.id] ?? null;
    if (!signature) return true;
    return arr.findIndex((candidate: any) => signatureMap[candidate.id] === signature) === index;
  });
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
  const { data, error } = await supa.from("places").select("*").eq("user_id", uid).limit(500);
  if (error) throw new ApiError("internal", error.message);
  const placeRows = data ?? [];
  const ids = placeRows.map((p: any) => p.id);
  const counts: Record<string, number> = {};
  const latestAssetByPlace: Record<string, { asset_id: string; capture_time: string | null }> = {};
  if (ids.length) {
    // Count assets directly off `assets.place_id` (set by clusterPlaces).
    // This replaces the deprecated `asset_locations` join.
    const { data: assetRows, error: aErr } = await supa.from("assets")
      .select("id, place_id, capture_time")
      .eq("user_id", uid)
      .in("place_id", ids);
    if (aErr) throw new ApiError("internal", aErr.message);
    for (const row of assetRows ?? []) {
      counts[row.place_id] = (counts[row.place_id] ?? 0) + 1;
      const prev = latestAssetByPlace[row.place_id];
      const ct = row.capture_time ?? null;
      if (!prev || (ct && (!prev.capture_time || ct > prev.capture_time))) {
        latestAssetByPlace[row.place_id] = { asset_id: row.id, capture_time: ct };
      }
    }
  }
  const places = placeRows
    .map((p: any) => ({
      ...p,
      asset_count: counts[p.id] ?? 0,
      latest_asset_id: latestAssetByPlace[p.id]?.asset_id ?? null,
      latest_capture_time: latestAssetByPlace[p.id]?.capture_time ?? null,
      city: p.name ?? null,
      country: p.country ?? null,
      label: [p.name, p.country].filter(Boolean).join(", "),
    }))
    .filter((p: any) => p.asset_count > 0)
    .sort((a: any, b: any) => b.asset_count - a.asset_count || String(b.latest_capture_time ?? "").localeCompare(String(a.latest_capture_time ?? "")));
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
    update.canonical_asset_id = body.primary_asset_id;
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
