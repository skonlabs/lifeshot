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
import { faceQualityScore, faceVisualSignature, sanitizeFaceBox, type FaceBox } from "../_shared/face-box.ts";
import { recreateCollection, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";

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

  // Fetch all people rows (face JSON has Rekognition attributes, ~3KB/row — no FaceCrop).
  const { data: rows, error } = await supa.from("people")
    .select("id, display_name, asset_id, face")
    .eq("user_id", uid);
  if (error) throw new ApiError("internal", error.message);

  // Group rows by display_name; each unique display_name = one physical person.
  const groups = new Map<string, any[]>();
  for (const row of rows ?? []) {
    const key = row.display_name ?? "__unlabeled__";
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }

  // Score face quality for cover selection.
  function faceQuality(face: any): number {
    const fd = face?.FaceDetail ?? {};
    const pose    = fd.Pose    ?? {};
    const quality = fd.Quality ?? {};
    const yaw   = Math.abs(Number(pose.Yaw   ?? 90));
    const pitch = Math.abs(Number(pose.Pitch ?? 90));
    const sharp  = Number(quality.Sharpness  ?? 0);
    const bright = Number(quality.Brightness ?? 0);
    const frontality = Math.max(0, 1 - yaw / 90) * Math.max(0, 1 - pitch / 90);
    return frontality * 0.60 + (sharp / 100) * 0.25 + (bright / 100) * 0.15;
  }

  // For each group, pick the best face row and collect cover asset ids.
  type PersonEntry = { id: string; display_name: string; asset_count: number; best: any };
  const entries: PersonEntry[] = [];
  const coverAssetIds = new Set<string>();

  for (const [displayName, groupRows] of groups) {
    let best = groupRows[0];
    let bestScore = faceQuality(best.face);
    for (const row of groupRows.slice(1)) {
      const s = faceQuality(row.face);
      if (s > bestScore) { bestScore = s; best = row; }
    }
    entries.push({
      id:           best.id,
      display_name: displayName === "__unlabeled__" ? null : displayName,
      asset_count:  new Set(groupRows.map((r: any) => r.asset_id).filter(Boolean)).size,
      best,
    });
    if (best.asset_id) coverAssetIds.add(best.asset_id as string);
  }

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

  // Sign storage paths.
  const pathsToSign = new Set<string>();
  for (const cid of coverAssetArr) {
    const asset = coverAssets[cid] ?? null;
    const media = mediaMap[cid] ?? null;
    for (const ck of [media?.thumbnail_url, media?.thumbnail_storage_path,
      asset?.thumbnail_cache_key, media?.preview_url, media?.preview_storage_path,
      asset?.proxy_cache_key]) {
      if (typeof ck === "string" && ck && !/^https?:\/\//.test(ck)) pathsToSign.add(ck);
    }
  }
  const signedMap = new Map<string, string>();
  if (pathsToSign.size) {
    const allPaths = Array.from(pathsToSign);
    const svc = getServiceClient();
    for (const bucket of ["thumbnails", "lifeshot-derived"] as const) {
      const remaining = allPaths.filter((p) => !signedMap.has(p));
      if (!remaining.length) break;
      try {
        const { data: signed } = await svc.storage.from(bucket).createSignedUrls(remaining, 3600);
        for (const s of signed ?? []) {
          if (s?.signedUrl && s.path && !signedMap.has(s.path)) signedMap.set(s.path, s.signedUrl);
        }
      } catch (_) { /* non-fatal */ }
    }
  }
  const resolveKey = (ck: string | null | undefined): string | null => {
    if (!ck) return null;
    if (/^https?:\/\//.test(ck)) return ck;
    return signedMap.get(ck) ?? null;
  };

  // Build response. Cover uses thumbnail + face bbox (BoundingBox from people.face).
  const people = entries
    .filter((e) => e.asset_count > 0)
    .map((e) => {
      const bbox = e.best.face?.BoundingBox ?? null;
      const validBbox = bbox && typeof bbox.x === "number" ? bbox : null;
      const aid  = e.best.asset_id as string | null;
      const asset = aid ? (coverAssets[aid] ?? null) : null;
      const media = aid ? (mediaMap[aid] ?? null) : null;
      const thumbUrl = aid
        ? resolveKey(media?.thumbnail_url) ?? resolveKey(media?.thumbnail_storage_path)
          ?? resolveKey(asset?.thumbnail_cache_key) ?? resolveKey(media?.preview_url)
          ?? resolveKey(media?.preview_storage_path) ?? resolveKey(asset?.proxy_cache_key)
        : null;
      const cover = thumbUrl
        ? { face_crop: null, thumbnail_url: thumbUrl, face_bbox: validBbox,
            width: asset?.width ?? null, height: asset?.height ?? null }
        : null;
      return { id: e.id, display_name: e.display_name, asset_count: e.asset_count, cover };
    });

  // Suppress unused import warnings.
  void faceQualityScore; void faceVisualSignature; void sanitizeFaceBox;
  return c.json({ people, face_processing_disabled: false });
});

app.get("/people/:id", async (c) => {
  const supa = c.get("supabase");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const { data: person } = await supa.from("people")
    .select("id, user_id, display_name, asset_id, face, created_at, updated_at")
    .eq("id", id).maybeSingle();
  if (!person) throw new ApiError("not_found", "Person not found");

  // Return all occurrences of this person (same display_name, same user).
  const { data: occurrences } = await supa.from("people")
    .select("id, asset_id, face")
    .eq("user_id", (person as any).user_id)
    .eq("display_name", (person as any).display_name ?? "");

  const assetIds = [...new Set((occurrences ?? []).map((o: any) => o.asset_id).filter(Boolean))];
  return c.json({
    ...(person as any),
    asset_count: assetIds.length,
    occurrences: (occurrences ?? []).map((o: any) => ({
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
app.post("/people/reset", async (c) => {
  const uid = c.get("userId") as string;

  // 1. Nuke the Rekognition collection.
  if (rekognitionConfigured()) {
    await recreateCollection(collectionIdForUser(uid));
  }

  // 2. Clear all face / person data for this user.
  // Some legacy rows/jobs were written with a missing user_id, so purge by the
  // user's asset/person ids as well — not only by user_id.
  const sb = getServiceClient();
  const { data: assetRows } = await sb
    .from("assets")
    .select("id")
    .eq("user_id", uid)
    .in("media_type", ["photo", "live_photo", "animation"]);
  const assetIds = (assetRows ?? []).map((a: { id: string }) => a.id);
  const CHUNK = 500;

  const personIds = new Set<string>();
  const { data: ownedPeople, error: ownedPeopleErr } = await sb.from("people")
    .select("id")
    .eq("user_id", uid);
  if (ownedPeopleErr) throw new Error(`people/reset: people lookup failed: ${ownedPeopleErr.message}`);
  for (const row of ownedPeople ?? []) personIds.add(row.id as string);

  if (assetIds.length > 0) {
    for (let i = 0; i < assetIds.length; i += CHUNK) {
      const chunk = assetIds.slice(i, i + CHUNK);

      const { data: linkedPeople, error: linkedPeopleErr } = await sb.from("people")
        .select("id")
        .in("asset_id", chunk);
      if (linkedPeopleErr) throw new Error(`people/reset: linked people lookup failed: ${linkedPeopleErr.message}`);
      for (const row of linkedPeople ?? []) personIds.add(row.id as string);

      const { error: afErr } = await sb.from("asset_faces").delete().in("asset_id", chunk);
      if (afErr) throw new Error(`people/reset: asset_faces delete failed: ${afErr.message}`);

      const { error: enrichErr } = await sb.from("asset_ai_enrichment")
        .update({ faces: [], face_count: 0 })
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
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
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
    .eq("payload->>user_id", uid);
  if (queuePayloadErr) throw new Error(`people/reset: payload job_queue purge failed: ${queuePayloadErr.message}`);

  const { error: ledgerPayloadErr } = await sb.from("job_ledger")
    .delete()
    .in("job_name", ["clusterPeople", "clusterPlaces", "detectEvents"])
    .eq("payload->>user_id", uid);
  if (ledgerPayloadErr) throw new Error(`people/reset: payload job_ledger purge failed: ${ledgerPayloadErr.message}`);

  // 3. Enqueue enrichAI for all image assets so they are re-detected immediately.
  // Time-based idempotency key so repeated resets always re-enqueue.
  const resetEpoch = Date.now();

  const jobs = assetIds.map((id: string) => ({
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
