import { z } from "../_shared/deps.ts";
import { createApi, authed } from "../_shared/router.ts";
import { parseBody, parseQuery, parseParams } from "../_shared/validation.ts";
import { ApiError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { getServiceClient } from "../_shared/clients.ts";
import { jobEnqueuer } from "../_shared/interfaces.ts";
import { findIdempotent, storeIdempotent } from "../_shared/idempotency.ts";
import { hashJson } from "../_shared/cache.ts";
import { emitEvent } from "../_shared/observability.ts";
import { resolveThumbUrl } from "../_shared/signed-url.ts";
import { faceQualityScore, sanitizeFaceBox, type FaceBox } from "../_shared/face-box.ts";
import { recreateCollection, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";
import { isUsableIndexedFace } from "../_ai/face-quality.ts";

const ListPage = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const app = authed(createApi("/organization/v1"));
const DB_PAGE_SIZE = 1000;

async function loadAssetFacesForPeople(supa: any, personIds: string[]) {
  const rows: any[] = [];
  for (let from = 0;; from += DB_PAGE_SIZE) {
    const { data, error } = await supa.from("asset_faces")
      .select("person_id, asset_id, face")
      .in("person_id", personIds)
      .range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw new ApiError("internal", error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < DB_PAGE_SIZE) break;
  }
  return rows;
}

async function loadPersonOccurrences(supa: any, personId: string) {
  const rows: any[] = [];
  for (let from = 0;; from += DB_PAGE_SIZE) {
    const { data, error } = await supa.from("asset_faces")
      .select("id, asset_id, face")
      .eq("person_id", personId)
      .range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw new ApiError("internal", error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < DB_PAGE_SIZE) break;
  }
  return rows;
}

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

  // One row per unique person (post one-row-per-person migration).
  const { data: rows, error } = await supa.from("people")
    .select("id, display_name")
    .eq("user_id", uid);
  if (error) throw new ApiError("internal", error.message);

  type PersonCoverCandidate = { asset_id: string; face_bbox: FaceBox | null; score: number; face_crop: string | null };
  type PersonEntry = { id: string; display_name: string | null; asset_count: number; best: PersonCoverCandidate | null };
  const entries: PersonEntry[] = (rows ?? []).map((r: any) => ({
    id: r.id,
    display_name: r.display_name ?? null,
    asset_count: 0,
    best: null,
  }));

  // Count only usable detections per person and pick the best linked face as
  // the cover. Never trust people.face / people.asset_id here because those can
  // still point at legacy seed faces from older clustering runs.
  if (entries.length) {
    const ids = entries.map((e) => e.id);
    const linkRows = await loadAssetFacesForPeople(supa, ids);

    // Count every linked face row so the People page reflects the same total
    // as the `people` table. The quality gate is only used to *prefer* a
    // sharper cover; it must not drop people whose detections all failed it.
    const linkedRows = (linkRows ?? []).filter((row: any) => row.person_id && row.asset_id);
    const usableRows = linkedRows.filter((row: any) => isUsableIndexedFace(row.face));

    const perPerson = new Map<string, Set<string>>();
    const facesPerAsset = new Map<string, number>();
    for (const r of linkedRows) {
      if (!r.person_id || !r.asset_id) continue;
      let s = perPerson.get(r.person_id);
      if (!s) { s = new Set<string>(); perPerson.set(r.person_id, s); }
      s.add(r.asset_id);
      facesPerAsset.set(r.asset_id, (facesPerAsset.get(r.asset_id) ?? 0) + 1);
    }

    const bestByPerson = new Map<string, PersonCoverCandidate>();
    // First pass: pick the best *usable* (sharp, well-posed) face per person.
    for (const row of usableRows) {
      const personId = row.person_id as string;
      const assetId = row.asset_id as string;
      const bbox = sanitizeFaceBox(row.face?.BoundingBox ?? null);
      const score = faceQualityScore(
        bbox,
        Number(row.face?.Confidence ?? 0),
        facesPerAsset.get(assetId) ?? 1,
      );
      const current = bestByPerson.get(personId);
      if (!current || score > current.score) {
        bestByPerson.set(personId, { asset_id: assetId, face_bbox: bbox, score, face_crop: row.face?.FaceCrop ?? null });
      }
    }
    // Fallback pass: for people with no usable face, still pick a cover from
    // any linked face so they appear on the /people grid.
    for (const row of linkedRows) {
      const personId = row.person_id as string;
      if (bestByPerson.has(personId)) continue;
      const assetId = row.asset_id as string;
      const bbox = sanitizeFaceBox(row.face?.BoundingBox ?? null);
      const score = faceQualityScore(
        bbox,
        Number(row.face?.Confidence ?? 0),
        facesPerAsset.get(assetId) ?? 1,
      );
      const current = bestByPerson.get(personId);
      if (!current || score > current.score) {
        bestByPerson.set(personId, { asset_id: assetId, face_bbox: bbox, score, face_crop: row.face?.FaceCrop ?? null });
      }
    }

    for (const e of entries) {
      e.asset_count = perPerson.get(e.id)?.size ?? 0;
      e.best = bestByPerson.get(e.id) ?? null;
    }
  }

  const coverAssetIds = new Set<string>();
  for (const e of entries) if (e.best?.asset_id) coverAssetIds.add(e.best.asset_id);

  // Batch-resolve thumbnail URLs for cover assets.
  const coverAssetArr = Array.from(coverAssetIds);
  const coverAssets: Record<string, any> = {};
  const mediaMap: Record<string, any> = {};
  const CHUNK = 80;
  for (let i = 0; i < coverAssetArr.length; i += CHUNK) {
    const slice = coverAssetArr.slice(i, i + CHUNK);
    const { data: assets } = await supa.from("assets")
      .select("id, thumbnail_cache_key, proxy_cache_key, width, height")
      .in("id", slice);
    for (const a of assets ?? []) coverAssets[a.id] = a;
    const { data: mm } = await supa.from("asset_media_metadata")
      .select("asset_id, thumbnail_url, thumbnail_storage_path, preview_url, preview_storage_path")
      .in("asset_id", slice);
    for (const row of mm ?? []) mediaMap[row.asset_id] = row;
  }

  const people = await Promise.all(entries
    .filter((e) => e.asset_count > 0 && e.best?.asset_id)
    .map(async (e) => {
      const aid = e.best!.asset_id;
      const asset = coverAssets[aid] ?? null;
      const media = mediaMap[aid] ?? null;
      const thumbUrl = await resolveThumbUrl(
        c,
        supa,
        uid,
        aid,
        media?.thumbnail_url
          ?? media?.thumbnail_storage_path
          ?? asset?.thumbnail_cache_key
          ?? media?.preview_url
          ?? media?.preview_storage_path
          ?? asset?.proxy_cache_key
          ?? null,
      );
      // High-res URL for CSS zoom fallback — preview first (full-res), then thumbnail.
      // When face_crop is null the browser zooms this image to isolate the face region;
      // using a small thumbnail causes a 12× upscale → blurry. Preview is the original
      // re-hosted at full resolution and produces a sharp crop even for small faces.
      const zoomUrl = await resolveThumbUrl(
        c,
        supa,
        uid,
        aid,
        media?.preview_storage_path
          ?? media?.preview_url
          ?? asset?.proxy_cache_key
          ?? media?.thumbnail_storage_path
          ?? media?.thumbnail_url
          ?? asset?.thumbnail_cache_key
          ?? null,
      );
      const faceCrop = e.best?.face_crop ?? null;
      const cover = (faceCrop || thumbUrl)
        ? {
            face_crop: faceCrop,
            thumbnail_url: thumbUrl,
            zoom_url: zoomUrl ?? thumbUrl,
            face_bbox: e.best?.face_bbox ?? null,
            width: asset?.width ?? null,
            height: asset?.height ?? null,
          }
        : null;
      return { id: e.id, display_name: e.display_name, asset_count: e.asset_count, cover };
    }));

  return c.json({ people, face_processing_disabled: false });
});

app.get("/people/:id", async (c) => {
  const supa = c.get("supabase");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const { data: person } = await supa.from("people")
    .select("id, user_id, display_name, asset_id, face, face_ids, created_at, updated_at")
    .eq("id", id).maybeSingle();
  if (!person) throw new ApiError("not_found", "Person not found");

  // All occurrences: every asset_faces row linked to this person.
  const occurrences = await loadPersonOccurrences(supa, id);

  const assetIds = [...new Set(occurrences.map((o: any) => o.asset_id).filter(Boolean))];
  return c.json({
    ...(person as any),
    asset_count: assetIds.length,
    occurrences: occurrences.map((o: any) => ({
      id:       o.id,
      asset_id: o.asset_id,
      face_id:  o.face?.FaceId ?? null,
    })),
  });
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
  // duplicate_groups/_members dropped → groups are derived from assets stamped
  // with the same duplicate_group_id (which dedupGroup writes deterministically
  // from sha256/phash).
  const { data: rows, error } = await supa.from("assets")
    .select("id, duplicate_group_id, file_size_bytes, capture_time, checksum_hash, perceptual_hash")
    .eq("user_id", uid).not("duplicate_group_id", "is", null).limit(2000);
  if (error) throw new ApiError("internal", error.message);
  const groupsMap = new Map<string, any[]>();
  for (const r of rows ?? []) {
    const k = r.duplicate_group_id as string;
    const list = groupsMap.get(k) ?? [];
    list.push(r);
    groupsMap.set(k, list);
  }
  const groups = Array.from(groupsMap.entries())
    .filter(([, members]) => members.length >= 2)
    .map(([id, members]) => {
      const totalBytes = members.reduce((acc, m) => acc + (m.file_size_bytes ?? 0), 0);
      const wastedBytes = totalBytes - (members[0].file_size_bytes ?? 0);
      return {
        id,
        signal: members[0].checksum_hash ? "sha256" : "phash",
        confidence: members[0].checksum_hash ? 1.0 : 0.92,
        status: "open",
        canonical_asset_id: members[0].id,
        storage_risk: wastedBytes,
        members: members.map((m) => ({
          group_id: id, asset_id: m.id,
          match_type: members[0].checksum_hash ? "checksum" : "perceptual",
          score: members[0].checksum_hash ? 1.0 : 0.92,
          is_canonical: m.id === members[0].id,
        })),
      };
    })
    .sort((a, b) => (b.storage_risk ?? 0) - (a.storage_risk ?? 0))
    .slice(0, 100);
  return c.json({ groups });
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

  // duplicate_groups dropped. "keep_primary" untags non-primary members from the
  // synthetic group so they no longer surface in /duplicates. "keep_all" /
  // "mark_reviewed" clears the group_id off every member (UI hide).
  if (body.action === "keep_primary" && body.primary_asset_id) {
    const { error } = await supa.from("assets")
      .update({ duplicate_group_id: null })
      .eq("duplicate_group_id", id)
      .neq("id", body.primary_asset_id);
    if (error) throw new ApiError("internal", error.message);
  } else {
    const { error } = await supa.from("assets")
      .update({ duplicate_group_id: null })
      .eq("duplicate_group_id", id);
    if (error) throw new ApiError("internal", error.message);
  }
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
  const uid = c.get("userId");
  const body = await parseBody(c, CorrectionIn);
  const reqHash = await hashJson(body);
  const idem = await findIdempotent(c, "corrections", reqHash);
  if (idem && "conflict" in idem) throw new ApiError("conflict", "Idempotency-Key reused");
  if (idem?.response) return c.json(idem.response, idem.status as 200);

  // user_corrections was dropped in B-NUKE. We still emit an audit log row and
  // trigger the same downstream re-index job for person corrections.
  const id = crypto.randomUUID();
  const supa = c.get("supabase");
  await supa.from("audit_logs").insert({
    user_id: uid, action: "correction.submit", target_type: body.target_type,
    target_id: body.target_id, meta: body.correction,
  });
  // Translate the correction into a downstream re-index job. For people we
  // re-run face clustering; for other entities we just record the correction
  // (search reindex picks up the changes on next pipeline pass).
  let job_id: string | null = null;
  if (body.target_type === "person") {
    // Persist the new display_name directly on the (single) person row.
    const newName = typeof (body.correction as any)?.display_name === "string"
      ? String((body.correction as any).display_name).trim()
      : null;
    if (newName) {
      const { error: renameErr } = await supa.from("people")
        .update({ display_name: newName, updated_at: new Date().toISOString() })
        .eq("id", body.target_id);
      if (renameErr) throw new ApiError("internal", renameErr.message);
    }
    const job = await jobEnqueuer.enqueue("clusterPeople",
      { user_id: uid, target_person_id: body.target_id, correction: body.correction },
      { userId: uid });
    job_id = job.id;
  }
  const out = { id, job_id };
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
    // user_corrections was dropped → tag actions logged via audit_logs only.
    await supa.from("audit_logs").insert(
      body.asset_ids.map((asset_id) => ({
        user_id: uid, action: "asset.tag", target_type: "asset",
        target_id: asset_id, meta: { add_tag: body.tag },
      })),
    );
    affected = body.asset_ids.length;
  }
  await supa.from("audit_logs").insert({
    user_id: uid, action: `asset.bulk_${body.action}`, target_type: "asset",
    target_id: body.asset_ids[0], meta: { count: body.asset_ids.length, tag: body.tag ?? null },
  });
  emitEvent(c, "organization.bulk_action", { action: body.action, count: body.asset_ids.length });
  return c.json({ affected, action: body.action });
});

/**
 * POST /people/reset
 * Full face pipeline reset for the authenticated user:
 *   1. Drop + recreate their Rekognition collection (clean slate).
 *   2. Clear asset_faces, auto-clustered people, enrichment faces.
 *   3. Reset face_scanned_at so all assets are re-queued.
 * The pipeline will re-detect and re-cluster everything from scratch.
 */
/**
 * POST /people/recluster
 * Force-enqueue a clusterPeople job for the authenticated user with a unique
 * idempotency key, bypassing enrichAI's 5-minute bucket dedup. Used to drain
 * the tail of usable asset_faces left unlinked after a previous run finished
 * its snapshot before the rest of the sync wrote their faces.
 */
app.post("/people/recluster", async (c) => {
  const uid = c.get("userId") as string;
  await enforceRateLimit(uid, "general");
  await jobEnqueuer.enqueue("clusterPeople", { user_id: uid }, {
    userId: uid,
    idempotencyKey: `people:${uid}:manual:${Date.now()}`,
  });
  return c.json({ ok: true });
});

app.post("/people/reset", async (c) => {
  const uid = c.get("userId") as string;
  const resetAt = new Date().toISOString();
  const sb = getServiceClient();

  const { error: resetStampErr } = await sb.from("privacy_settings").upsert({
    user_id: uid,
    face_pipeline_reset_at: resetAt,
  }, { onConflict: "user_id" });
  if (resetStampErr) throw new Error(`people/reset: reset marker update failed: ${resetStampErr.message}`);

  // 1. Nuke the Rekognition collection.
  if (rekognitionConfigured()) {
    await recreateCollection(collectionIdForUser(uid));
  }

  // 2. Clear all face / person data for this user.
  // Some legacy rows/jobs were written with a missing user_id, so purge by the
  // user's asset/person ids as well — not only by user_id.
  const { data: assetRows } = await sb
    .from("assets")
    .select("id, mime_type, media_type")
    .eq("user_id", uid)
    .or("media_type.in.(photo,live_photo,animation),mime_type.like.image/%");
  const assetIds = new Set((assetRows ?? []).map((a: { id: string }) => a.id));
  const personIds = new Set<string>();
  const { data: ownedPeople, error: ownedPeopleErr } = await sb.from("people")
    .select("id")
    .eq("user_id", uid);
  if (ownedPeopleErr) throw new Error(`people/reset: people lookup failed: ${ownedPeopleErr.message}`);
  for (const row of ownedPeople ?? []) personIds.add(row.id as string);

  const { data: faceAssetRows, error: faceAssetErr } = await sb
    .from("asset_faces")
    .select("asset_id")
    .eq("user_id", uid);
  if (faceAssetErr) throw new Error(`people/reset: asset_faces lookup failed: ${faceAssetErr.message}`);
  for (const row of faceAssetRows ?? []) if (row.asset_id) assetIds.add(row.asset_id as string);

  const { data: enrichAssetRows, error: enrichAssetErr } = await sb
    .from("asset_ai_enrichment")
    .select("asset_id")
    .eq("user_id", uid);
  if (enrichAssetErr) throw new Error(`people/reset: asset_ai_enrichment lookup failed: ${enrichAssetErr.message}`);
  for (const row of enrichAssetRows ?? []) if (row.asset_id) assetIds.add(row.asset_id as string);

  const allAssetIds = Array.from(assetIds);
  // Keep PostgREST filter URLs comfortably below gateway/proxy limits.
  // UUID lists are URL-encoded inside `.in(...)`, so even 100 ids can still
  // produce edge-runtime fetch failures before PostgREST returns a 414.
  const POSTGREST_IN_FILTER_CHUNK = 25;

  if (allAssetIds.length > 0) {
    for (let i = 0; i < allAssetIds.length; i += POSTGREST_IN_FILTER_CHUNK) {
      const chunk = allAssetIds.slice(i, i + POSTGREST_IN_FILTER_CHUNK);

      const { data: linkedPeople, error: linkedPeopleErr } = await sb.from("people")
        .select("id")
        .in("asset_id", chunk);
      if (linkedPeopleErr) throw new Error(`people/reset: linked people lookup failed: ${linkedPeopleErr.message}`);
      for (const row of linkedPeople ?? []) personIds.add(row.id as string);

      const { error: afErr } = await sb.from("asset_faces").delete().in("asset_id", chunk);
      if (afErr) throw new Error(`people/reset: asset_faces delete failed: ${afErr.message}`);

      const { error: enrichErr } = await sb.from("asset_ai_enrichment")
        .update({
          faces: [],
          face_count: 0,
        })
        .in("asset_id", chunk);
      if (enrichErr) throw new Error(`people/reset: asset_ai_enrichment reset failed: ${enrichErr.message}`);

      const { error: assetErr } = await sb.from("assets")
        .update({ face_scanned_at: null })
        .in("id", chunk)
        .not("face_scanned_at", "is", null);
      if (assetErr) throw new Error(`people/reset: assets reset failed: ${assetErr.message}`);
    }
  }

  if (personIds.size > 0) {
    const ids = Array.from(personIds);
    for (let i = 0; i < ids.length; i += POSTGREST_IN_FILTER_CHUNK) {
      const chunk = ids.slice(i, i + POSTGREST_IN_FILTER_CHUNK);
      const { error: peopleErr } = await sb.from("people").delete().in("id", chunk);
      if (peopleErr) throw new Error(`people/reset: people delete failed: ${peopleErr.message}`);
    }
  }

  // Purge ALL prior face-pipeline jobs (any status) for this user, and
  // their job_ledger entries.  Two reasons:
  //   1. Stale pending/running rows would fire after the reset with
  //      incomplete data.
  //   2. Stale completed rows (per-asset idempotency keys from earlier
  //      cycles) would cause enqueueJob to dedup against them — even after
  //      we wipe the people/faces tables, no fresh clusterPeople would ever
  //      be queued for those assets, so the People page stays empty.
  // clusterPlaces and detectEvents share the same coalescing pattern, so
  // include them too.
  const FACE_PIPELINE_JOBS = [
    "enrichAI",
    "clusterPeople",
    "clusterPlaces",
    "detectEvents",
  ];
  const { error: queueOwnedErr } = await sb.from("job_queue")
    .delete()
    .in("job_name", FACE_PIPELINE_JOBS)
    .eq("user_id", uid);
  if (queueOwnedErr) throw new Error(`people/reset: job_queue purge failed: ${queueOwnedErr.message}`);

  const { error: ledgerOwnedErr } = await sb.from("job_ledger")
    .delete()
    .in("job_name", FACE_PIPELINE_JOBS)
    .eq("user_id", uid);
  if (ledgerOwnedErr) throw new Error(`people/reset: job_ledger purge failed: ${ledgerOwnedErr.message}`);

  const { error: queuePayloadErr } = await sb.from("job_queue")
    .delete()
    .in("job_name", ["clusterPeople", "clusterPlaces", "detectEvents"])
    .filter("payload->>user_id", "eq", uid);
  if (queuePayloadErr) throw new Error(`people/reset: payload job_queue purge failed: ${queuePayloadErr.message}`);

  const legacyLedgerPrefixes = [
    { job: "clusterPeople", prefix: `people:${uid}:` },
    { job: "clusterPlaces", prefix: `places:${uid}:` },
    { job: "detectEvents", prefix: `events:${uid}:` },
  ] as const;
  for (const entry of legacyLedgerPrefixes) {
    const { error: legacyLedgerErr } = await sb.from("job_ledger")
      .delete()
      .eq("job_name", entry.job)
      .like("idempotency_key", `${entry.prefix}%`);
    if (legacyLedgerErr) throw new Error(`people/reset: legacy job_ledger purge failed: ${legacyLedgerErr.message}`);
  }

  if (allAssetIds.length > 0) {
    for (let i = 0; i < allAssetIds.length; i += POSTGREST_IN_FILTER_CHUNK) {
      const chunk = allAssetIds.slice(i, i + POSTGREST_IN_FILTER_CHUNK);
      const { error: queueAssetErr } = await sb.from("job_queue")
        .delete()
        .eq("job_name", "enrichAI")
        .in("payload->>asset_id", chunk);
      if (queueAssetErr) throw new Error(`people/reset: asset job_queue purge failed: ${queueAssetErr.message}`);

      for (const assetId of chunk) {
        const { error: ledgerAssetErr } = await sb.from("job_ledger")
          .delete()
          .eq("job_name", "enrichAI")
          .like("idempotency_key", `ai:${assetId}%`);
        if (ledgerAssetErr) throw new Error(`people/reset: asset job_ledger purge failed: ${ledgerAssetErr.message}`);
      }
    }
  }

  // 3. Enqueue enrichAI for all image assets so they are re-detected immediately.
  // Time-based idempotency key so repeated resets always re-enqueue.
  const resetEpoch = Date.now();

  const jobs = allAssetIds.map((id: string) => ({
    job_name: "enrichAI",
    payload: { asset_id: id },
    idempotency_key: `ai:${id}:face-reset-${resetEpoch}`,
    status: "pending",
    user_id: uid,
    priority: 5,
  }));

  if (jobs.length > 0) {
    // Batch in chunks of 500 to stay within PostgREST limits.
    for (let i = 0; i < jobs.length; i += 500) {
      await sb.from("job_queue").upsert(jobs.slice(i, i + 500), { onConflict: "idempotency_key", ignoreDuplicates: true });
    }
  }

  return c.json({ ok: true, queued: jobs.length, message: "Face pipeline reset. Assets will be re-scanned automatically." });
});

Deno.serve(app.fetch);
