// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { searchFaces, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";

/**
 * Score a face for cover selection. Higher = better avatar quality.
 * Prioritises: frontal pose > sharpness > non-occluded > bright.
 * All qualifying faces are clustered; score only controls which face
 * is chosen as the person's display avatar.
 */
function coverScore(attributes: any): number {
  if (!attributes) return 0;
  const pose    = attributes.Pose    ?? {};
  const quality = attributes.Quality ?? {};
  // FaceOccluded already filtered out before reaching this function.
  const yaw    = Math.abs(Number(pose.Yaw   ?? 90));
  const pitch  = Math.abs(Number(pose.Pitch ?? 90));
  const sharp  = Number(quality.Sharpness  ?? 0);
  const bright = Number(quality.Brightness ?? 0);
  // EyeDirection: prefer direct gaze (low yaw/pitch on eyes)
  const eyeYaw   = Math.abs(Number((attributes.EyeDirection?.Yaw   ?? 90)));
  const eyePitch = Math.abs(Number((attributes.EyeDirection?.Pitch ?? 90)));
  const gazeScore = Math.max(0, (1 - eyeYaw / 90)) * Math.max(0, (1 - eyePitch / 90));

  const frontality = Math.max(0, (1 - yaw / 90)) * Math.max(0, (1 - pitch / 90));
  return frontality * 0.50 + (sharp / 100) * 0.25 + (bright / 100) * 0.10 + gazeScore * 0.15;
}

const PRIMARY_THRESHOLD  = 75;
const FALLBACK_THRESHOLD = 65;
// Only faces scoring >= this are used as cover avatars.
const MIN_COVER_SCORE = 0.30;

export async function clusterPeople(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, asset_id } = ctx.payload as { user_id?: string; asset_id?: string };
  const uid = user_id ?? ctx.userId;
  if (!uid) throw new Error("invalid: user_id");

  const { data: privacy } = await sb
    .from("privacy_settings")
    .select("face_processing_enabled")
    .eq("user_id", uid)
    .maybeSingle();
  if (!privacy?.face_processing_enabled) {
    return { user_id: uid, skipped: "consent", clustered: 0 };
  }

  if (!rekognitionConfigured()) {
    return { user_id: uid, skipped: "rekognition_not_configured", clustered: 0 };
  }

  // ── Read from asset_faces (canonical source of detected faces) ─────────────
  // Quality gate applied here:
  //   • FaceOccluded = false  (occluded faces are not reliable for identity)
  //   • confidence  ≥ 0.90   (90% detection confidence)
  // Only faces passing both gates are clustered into the people table.
  let facesQuery = sb
    .from("asset_faces")
    .select("asset_id, face_id, bbox, confidence, face_crop, attributes")
    .eq("user_id", uid)
    .not("face_id", "is", null);
  if (asset_id) facesQuery = facesQuery.eq("asset_id", asset_id);

  const { data: faceRows, error } = await facesQuery;
  if (error) throw new Error(`clusterPeople fetch: ${error.message}`);

  interface FaceEntry {
    asset_id: string;
    face_id: string;
    bbox: any;
    confidence: number;
    face_crop: string | null;
    attributes: any;
  }

  const faceEntries: FaceEntry[] = [];
  for (const f of faceRows ?? []) {
    if (!f.face_id) continue;

    // Quality gate: skip occluded faces and low-confidence detections.
    const occluded   = (f.attributes as any)?.FaceOccluded?.Value === true;
    const confidence = Number(f.confidence ?? 0);
    if (occluded || confidence < 0.90) continue;

    faceEntries.push({
      asset_id:   f.asset_id,
      face_id:    f.face_id,
      bbox:       f.bbox ?? null,
      confidence,
      face_crop:  f.face_crop ?? null,
      attributes: f.attributes ?? null,
    });
  }

  if (faceEntries.length === 0) {
    return { user_id: uid, people: 0, clustered: 0, reason: "no_qualifying_faces" };
  }

  const collectionId = collectionIdForUser(uid);

  // Load existing people — rekognition_face_ids (array on people row) is the
  // canonical lookup so we can match new faces to existing persons.
  const { data: existingPeople } = await sb
    .from("people")
    .select("id, auto_label, display_name, rekognition_face_ids")
    .eq("user_id", uid)
    .like("auto_label", "auto:person:%");

  const faceIdToPersonId = new Map<string, string>();
  for (const person of existingPeople ?? []) {
    const ids: string[] = Array.isArray((person as any).rekognition_face_ids)
      ? (person as any).rekognition_face_ids
      : [];
    for (const fid of ids) {
      if (fid) faceIdToPersonId.set(fid, person.id);
    }
  }

  let personCounter = existingPeople?.length ?? 0;
  const personFaceMap = new Map<string, FaceEntry[]>();

  for (const entry of faceEntries) {
    let personId: string | null = null;

    try {
      const matches = await searchFaces({
        collectionId,
        faceId: entry.face_id,
        faceMatchThreshold: FALLBACK_THRESHOLD,
        maxFaces: 10,
      });

      const sorted = matches
        .filter((m) => m.faceId !== entry.face_id)
        .sort((a, b) => b.similarity - a.similarity);

      const primary  = sorted.find((m) => m.similarity >= PRIMARY_THRESHOLD  && faceIdToPersonId.has(m.faceId));
      const fallback = sorted.find((m) => m.similarity >= FALLBACK_THRESHOLD && faceIdToPersonId.has(m.faceId));
      const match = primary ?? fallback ?? null;

      if (match) personId = faceIdToPersonId.get(match.faceId)!;
    } catch (e: any) {
      console.warn("clusterPeople: SearchFaces failed", entry.face_id, String(e?.message ?? e));
    }

    if (!personId) {
      personCounter++;
      const autoLabel = `auto:person:${personCounter}`;
      const { data: newPerson, error: npErr } = await sb
        .from("people")
        .upsert(
          { user_id: uid, auto_label: autoLabel, display_name: `Person ${personCounter}`, consent_required: true },
          { onConflict: "user_id,auto_label" },
        )
        .select("id").single();
      if (npErr || !newPerson) {
        console.error("clusterPeople: person upsert failed", npErr?.message);
        continue;
      }
      personId = newPerson.id;
    }

    // Register face_id → personId so subsequent faces in this run can match it.
    faceIdToPersonId.set(entry.face_id, personId);

    const arr = personFaceMap.get(personId) ?? [];
    arr.push(entry);
    personFaceMap.set(personId, arr);
  }

  // ── Persist to people table ────────────────────────────────────────────────
  // people.faces JSONB stores all qualifying face occurrences for this person.
  // This is the source of truth the People page reads — person_faces table no
  // longer exists.
  let peopleUpdated = 0;
  for (const [pid, entries] of personFaceMap) {
    // Pick the best cover: prefer a face with a baked face_crop and a strong
    // quality score; otherwise fall back to the highest-confidence face with
    // a usable bbox so the People page can render a thumbnail+bbox crop.
    let bestCover: FaceEntry | null = null;
    let bestScore = -1;
    for (const e of entries) {
      if (!e.face_crop) continue;
      const s = coverScore(e.attributes);
      if (s >= MIN_COVER_SCORE && s > bestScore) {
        bestScore = s;
        bestCover = e;
      }
    }
    let bboxFallback: FaceEntry | null = null;
    if (!bestCover) {
      for (const e of entries) {
        if (!e.bbox) continue;
        if (!bboxFallback || e.confidence > bboxFallback.confidence) bboxFallback = e;
      }
    }

    const facesJsonb = entries.map((e) => ({
      asset_id:            e.asset_id,
      bbox:                e.bbox,
      confidence:          e.confidence,
      face_crop:           e.face_crop,
      rekognition_face_id: e.face_id,
    }));

    const faceIds = [...new Set(entries.map((e) => e.face_id).filter(Boolean))];

    const update: Record<string, unknown> = {
      faces:                facesJsonb,
      face_count:           facesJsonb.length,
      rekognition_face_ids: faceIds,
    };
    if (bestCover) {
      update.cover_face_crop = bestCover.face_crop;
      update.cover_asset_id  = bestCover.asset_id;
      update.cover_bbox      = bestCover.bbox;
    } else if (bboxFallback) {
      // No face_crop available (e.g. cropFace failed in Deno); set the asset+bbox
      // so the People page falls back to a CSS thumbnail crop.
      update.cover_asset_id = bboxFallback.asset_id;
      update.cover_bbox     = bboxFallback.bbox;
    }

    const { error: uErr } = await sb.from("people").update(update).eq("id", pid);
    if (uErr) {
      console.error("clusterPeople: people update failed", pid, uErr.message);
    } else {
      peopleUpdated++;
    }
  }

  // ── Merge pass ────────────────────────────────────────────────────────────
  // Consolidate duplicate person records created by parallel runs or prior
  // fragmented scans.
  let peopleMerged = 0;
  const { data: freshPeople } = await sb
    .from("people")
    .select("id, rekognition_face_ids, faces, face_count, cover_face_crop, cover_asset_id, cover_bbox")
    .eq("user_id", uid)
    .like("auto_label", "auto:person:%");

  const personById = new Map<string, any>();
  for (const p of freshPeople ?? []) personById.set((p as any).id, p);

  const absorbed = new Set<string>();

  for (const [pid] of personFaceMap) {
    if (absorbed.has(pid)) continue;
    const person = personById.get(pid);
    if (!person) continue;
    const faceIds: string[] = Array.isArray(person.rekognition_face_ids)
      ? person.rekognition_face_ids : [];
    if (faceIds.length === 0) continue;

    let matchingPersonId: string | null = null;
    try {
      const matches = await searchFaces({
        collectionId,
        faceId: faceIds[0],
        faceMatchThreshold: PRIMARY_THRESHOLD,
        maxFaces: 10,
      });
      for (const m of matches) {
        if (m.faceId === faceIds[0]) continue;
        const otherId = faceIdToPersonId.get(m.faceId);
        if (otherId && otherId !== pid && !absorbed.has(otherId)) {
          matchingPersonId = otherId;
          break;
        }
      }
    } catch { /* ignore search errors in merge pass */ }

    if (!matchingPersonId) continue;

    const other = personById.get(matchingPersonId);
    if (!other) continue;

    const otherFaces: any[] = Array.isArray(other.faces) ? other.faces : [];
    const otherFaceIds: string[] = Array.isArray(other.rekognition_face_ids)
      ? other.rekognition_face_ids : [];
    const myFaces: any[] = Array.isArray(person.faces) ? person.faces : [];
    const myFaceIds: string[] = Array.isArray(person.rekognition_face_ids)
      ? person.rekognition_face_ids : [];

    const mergedFaces   = [...myFaces, ...otherFaces];
    const mergedFaceIds = [...new Set([...myFaceIds, ...otherFaceIds])];

    let mergedBestCover: any = person.cover_face_crop ? person : null;
    let mergedBestScore = mergedBestCover ? coverScore(null) : -1;
    for (const mface of mergedFaces) {
      if (!mface.face_crop) continue;
      const s = coverScore(mface.attributes ?? null);
      if (s >= MIN_COVER_SCORE && s > mergedBestScore) {
        mergedBestScore = s;
        mergedBestCover = mface;
      }
    }

    const mergeUpdate: Record<string, unknown> = {
      faces:                mergedFaces,
      face_count:           mergedFaces.length,
      rekognition_face_ids: mergedFaceIds,
    };
    if (mergedBestCover?.face_crop) {
      mergeUpdate.cover_face_crop = mergedBestCover.face_crop;
      mergeUpdate.cover_asset_id  = mergedBestCover.asset_id ?? mergedBestCover.cover_asset_id;
      mergeUpdate.cover_bbox      = mergedBestCover.bbox ?? mergedBestCover.cover_bbox;
    }

    const { error: mergeErr } = await sb.from("people").update(mergeUpdate).eq("id", pid);
    if (!mergeErr) {
      await sb.from("people").delete().eq("id", matchingPersonId);
      absorbed.add(matchingPersonId);
      peopleMerged++;
    }
  }

  return {
    user_id: uid,
    people: personCounter,
    people_updated: peopleUpdated,
    people_merged: peopleMerged,
    faces_processed: faceEntries.length,
  };
}
