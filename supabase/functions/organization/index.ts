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
  // Query people with Rekognition-pipeline cover fields.
  // Face quality is already guaranteed at detection time (face-detector.ts gate),
  // so we don't re-score here — we just use the stored cover_face_crop / cover_asset_id.
  const { data, error } = await supa.from("people")
    .select("id, display_name, is_child, is_elder, consent_required, auto_label, cover_face_crop, cover_asset_id, cover_bbox")
    .eq("user_id", uid);
  if (error) throw new ApiError("internal", error.message);
  const peopleRows = (data ?? []).filter((p: any) => p.auto_label !== "auto:unclustered-faces");
  console.log("[/people] uid=", uid, "raw=", (data ?? []).length, "after_filter=", peopleRows.length);

  // Asset counts: derive from the canonical `people.faces` jsonb array — the
  // clusterPeople pipeline writes there, not into the legacy `person_faces`
  // table. Counting distinct asset_id within the array gives the true number
  // of photos this person appears in.
  const ids = peopleRows.map((p: any) => p.id);
  const counts: Record<string, number> = {};
  if (ids.length) {
    const { data: faceRows } = await supa.from("people")
      .select("id, faces").in("id", ids);
    for (const row of faceRows ?? []) {
      const arr = Array.isArray((row as any).faces) ? (row as any).faces : [];
      const seen = new Set<string>();
      for (const f of arr) if (f && typeof f.asset_id === "string") seen.add(f.asset_id);
      counts[(row as any).id] = seen.size;
    }
  }

  // Batch-resolve thumbnail URLs for any cover that doesn't already have a
  // baked-in face_crop data URL.
  const coverAssetIds = Array.from(new Set(
    peopleRows
      .filter((p: any) => p.cover_asset_id && !p.cover_face_crop)
      .map((p: any) => p.cover_asset_id as string),
  ));
  const coverAssets: Record<string, any> = {};
  const mediaMap: Record<string, any> = {};
  if (coverAssetIds.length) {
    // Chunk .in() to keep URL length under PostgREST's ~4KB limit.
    // UUIDs are 36 chars each; chunks of 80 keep us well under.
    const CHUNK = 80;
    for (let i = 0; i < coverAssetIds.length; i += CHUNK) {
      const slice = coverAssetIds.slice(i, i + CHUNK);
      const { data: assets, error: aErr } = await supa.from("assets")
        .select("id, thumbnail_cache_key, proxy_cache_key, blurhash, dominant_color, media_type, width, height")
        .in("id", slice);
      if (aErr) console.warn("[/people] assets fetch err", aErr.message);
      for (const a of assets ?? []) coverAssets[a.id] = a;
      const { data: mm, error: mErr } = await supa.from("asset_media_metadata")
        .select("asset_id, thumbnail_url, thumbnail_storage_path, preview_url, preview_storage_path")
        .in("asset_id", slice);
      if (mErr) console.warn("[/people] media fetch err", mErr.message);
      for (const row of mm ?? []) mediaMap[row.asset_id] = row;
    }
  }

  // Batch-sign storage paths to avoid sequential round-trips.
  const pathsToSign = new Set<string>();
  for (const cid of coverAssetIds) {
    const asset = coverAssets[cid] ?? null;
    const media = mediaMap[cid] ?? null;
    for (const ck of [media?.thumbnail_url, media?.thumbnail_storage_path, asset?.thumbnail_cache_key,
      media?.preview_url, media?.preview_storage_path, asset?.proxy_cache_key]) {
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
        const { data: signed, error: sErr } = await svc.storage.from(bucket).createSignedUrls(remaining, 60 * 60);
        if (sErr) console.warn("[/people] sign err bucket=", bucket, sErr.message);
        for (const s of signed ?? []) {
          if (s?.signedUrl && s.path && !signedMap.has(s.path)) signedMap.set(s.path, s.signedUrl);
        }
      } catch (e) { console.warn("[/people] sign throw bucket=", bucket, String((e as any)?.message ?? e)); }
    }
  }
  console.log("[/people] coverAssetIds=", coverAssetIds.length, "pathsToSign=", pathsToSign.size, "signed=", signedMap.size, "coverAssets=", Object.keys(coverAssets).length, "mediaMap=", Object.keys(mediaMap).length);
  const resolveKey = (ck: string | null | undefined): string | null => {
    if (!ck) return null;
    if (/^https?:\/\//.test(ck)) return ck;
    return signedMap.get(ck) ?? null;
  };

  const people = peopleRows.map((p: any) => {
    const faceCrop = typeof p.cover_face_crop === "string" ? p.cover_face_crop : null;
    const coverBbox = (p.cover_bbox && typeof p.cover_bbox === "object" &&
      typeof (p.cover_bbox as any).x === "number") ? p.cover_bbox : null;
    let thumbUrl: string | null = null;
    let coverWidth: number | null = null;
    let coverHeight: number | null = null;
    if (!faceCrop && p.cover_asset_id) {
      const asset = coverAssets[p.cover_asset_id] ?? null;
      const media = mediaMap[p.cover_asset_id] ?? null;
      thumbUrl = resolveKey(media?.thumbnail_url) ?? resolveKey(media?.thumbnail_storage_path)
        ?? resolveKey(asset?.thumbnail_cache_key) ?? resolveKey(media?.preview_url)
        ?? resolveKey(media?.preview_storage_path) ?? resolveKey(asset?.proxy_cache_key);
      coverWidth  = typeof asset?.width  === "number" ? asset.width  : null;
      coverHeight = typeof asset?.height === "number" ? asset.height : null;
    }
    // Cover preference:
    //   1. baked face_crop data URL (when face-detector produced one)
    //   2. thumbnail + face_bbox  (PersonTile CSS-crops to the face region)
    //   3. thumbnail alone        (PersonTile falls back to centered crop)
    const cover = faceCrop
      ? { face_crop: faceCrop, thumbnail_url: null, face_bbox: null, width: null, height: null }
      : thumbUrl
        ? { face_crop: null, thumbnail_url: thumbUrl, face_bbox: coverBbox, width: coverWidth, height: coverHeight }
        : null;
    return {
      id: p.id, display_name: p.display_name, is_child: p.is_child, is_elder: p.is_elder,
      consent_required: p.consent_required, auto_label: p.auto_label,
      asset_count: counts[p.id] ?? 0, cover,
    };
  // Show any person with at least one face occurrence. PersonTile renders a
  // fallback avatar when cover is null, so don't drop people whose cover
  // thumbnail couldn't be resolved.
  }).filter((person: any) => person.asset_count > 0);
  console.log("[/people] final=", people.length);
  // Suppress unused import warnings.
  void faceQualityScore; void faceVisualSignature; void sanitizeFaceBox;
  return c.json({ people, face_processing_disabled: false });
});

app.get("/people/:id", async (c) => {
  const supa = c.get("supabase");
  const { id } = parseParams(c, z.object({ id: z.string().uuid() }));
  const { data: person } = await supa.from("people").select("*").eq("id", id).maybeSingle();
  if (!person) throw new ApiError("not_found", "Person not found");
  const facesArr = Array.isArray(person.faces) ? person.faces : [];
  const compactFaces = facesArr.slice(0, 50).map((f: any) => ({
    asset_id: f.asset_id, confidence: f.confidence,
  }));
  return c.json({
    ...person, person, faces: compactFaces,
    asset_count: person.face_count ?? new Set(facesArr.map((f: any) => f.asset_id)).size,
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
  const supa = c.get("supabase");
  const uid = c.get("userId") as string;

  // 1. Nuke the Rekognition collection.
  if (rekognitionConfigured()) {
    await recreateCollection(collectionIdForUser(uid));
  }

  // 2. Clear all face / person data for this user.
  const sb = getServiceClient();
  const { error: afErr } = await sb.from("asset_faces").delete().eq("user_id", uid);
  if (afErr) throw new Error(`people/reset: asset_faces delete failed: ${afErr.message}`);
  await sb.from("people").delete()
    .eq("user_id", uid)
    .not("auto_label", "is", null);
  await sb.from("asset_ai_enrichment").update({ faces: [], rekognition_response: null })
    .eq("user_id", uid)
    .not("faces", "eq", "[]");
  await sb.from("assets").update({ face_scanned_at: null })
    .eq("user_id", uid)
    .not("face_scanned_at", "is", null);

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
  await sb.from("job_queue")
    .delete()
    .in("job_name", FACE_PIPELINE_JOBS)
    .eq("user_id", uid);
  await sb.from("job_ledger")
    .delete()
    .in("job_name", FACE_PIPELINE_JOBS)
    .eq("user_id", uid);

  // 3. Enqueue enrichAI for all image assets so they are re-detected immediately.
  // Time-based idempotency key so repeated resets always re-enqueue.
  const resetEpoch = Date.now();
  const { data: assetRows } = await sb
    .from("assets")
    .select("id")
    .eq("user_id", uid)
    .in("media_type", ["photo", "live_photo", "animation"]);

  const jobs = (assetRows ?? []).map((a: { id: string }) => ({
    job_name: "enrichAI",
    payload: { asset_id: a.id },
    idempotency_key: `ai:${a.id}:face-reset-${resetEpoch}`,
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
