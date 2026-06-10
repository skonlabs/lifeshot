// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { searchFaces, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";

/**
 * Score a face for cover selection. Higher = better avatar quality.
 * Prioritises: frontal pose > sharpness > non-occluded.
 * All faces are clustered regardless of score — score only controls which
 * face is chosen as the person's display avatar.
 */
function coverScore(entry: { attributes: any; confidence: number }): number {
  const a = entry.attributes;
  if (!a) return 0;
  const pose = a.Pose ?? {};
  const quality = a.Quality ?? {};
  const occluded = a.FaceOccluded?.Value === true || a.FaceOccluded?.Value === "true";
  const yaw   = Math.abs(Number(pose.Yaw   ?? 90));
  const pitch = Math.abs(Number(pose.Pitch ?? 90));
  const sharp = Number(quality.Sharpness  ?? 0);
  const bright = Number(quality.Brightness ?? 0);
  if (occluded) return 0;
  const frontality = Math.max(0, (1 - yaw / 90)) * Math.max(0, (1 - pitch / 90));
  return frontality * 0.6 + (sharp / 100) * 0.3 + (bright / 100) * 0.1;
}

const PRIMARY_THRESHOLD = 75;
const FALLBACK_THRESHOLD = 65;
// Only faces scoring >= this become cover avatars (blocks side profiles).
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

  // Fetch enrichment rows with face detections.
  let enrichQuery = sb
    .from("asset_ai_enrichment")
    .select("asset_id, faces")
    .eq("user_id", uid);
  if (asset_id) enrichQuery = enrichQuery.eq("asset_id", asset_id);

  const { data: enrichRows, error } = await enrichQuery;
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
  for (const row of enrichRows ?? []) {
    const faces = Array.isArray(row.faces) ? row.faces : [];
    for (const f of faces) {
      if (f.face_id) {
        faceEntries.push({
          asset_id: row.asset_id,
          face_id: f.face_id,
          bbox: f.bbox ?? null,
          confidence: f.score ?? f.confidence ?? 0.5,
          face_crop: f.face_crop ?? null,
          attributes: f.attributes ?? null,
        });
      }
    }
  }

  if (faceEntries.length === 0) {
    return { user_id: uid, people: 0, clustered: 0, reason: "no_faces_with_face_id" };
  }

  const collectionId = collectionIdForUser(uid);

  // Load existing people — use rekognition_face_ids (array on people row) as
  // the canonical lookup. This avoids depending on the person_faces table which
  // is now secondary/legacy.
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
  // personFaceMap accumulates all faces assigned to each person this run.
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

    // Accumulate face entry for this person.
    const arr = personFaceMap.get(personId) ?? [];
    arr.push(entry);
    personFaceMap.set(personId, arr);
  }

  // Persist results: update people.faces (canonical), people.face_count,
  // people.rekognition_face_ids, and cover fields.
  // people.faces is what the organization endpoint reads for asset_count.
  let peopleUpdated = 0;
  for (const [pid, entries] of personFaceMap) {
    // Build the best cover face (highest score that meets minimum quality).
    let bestCover: FaceEntry | null = null;
    let bestScore = -1;
    for (const e of entries) {
      if (!e.face_crop) continue;
      const s = coverScore({ attributes: e.attributes, confidence: e.confidence });
      if (s >= MIN_COVER_SCORE && s > bestScore) {
        bestScore = s;
        bestCover = e;
      }
    }

    // Build people.faces JSONB array (format expected by organization endpoint).
    const facesJsonb = entries.map((e) => ({
      asset_id: e.asset_id,
      bbox: e.bbox,
      confidence: e.confidence,
      face_crop: e.face_crop,
      rekognition_face_id: e.face_id,
    }));

    const faceIds = [...new Set(entries.map((e) => e.face_id).filter(Boolean))];

    const update: Record<string, unknown> = {
      faces: facesJsonb,
      face_count: facesJsonb.length,
      rekognition_face_ids: faceIds,
    };
    if (bestCover) {
      update.cover_face_crop  = bestCover.face_crop;
      update.cover_asset_id   = bestCover.asset_id;
      update.cover_bbox       = bestCover.bbox;
    }

    const { error: uErr } = await sb.from("people").update(update).eq("id", pid);
    if (uErr) {
      console.error("clusterPeople: people update failed", pid, uErr.message);
    } else {
      peopleUpdated++;
    }
  }

  // Merge pass: find duplicate people created by parallel runs or prior
  // fragmented scans. For every person updated this run, search their face IDs
  // against the collection and merge any existing person that matches at
  // PRIMARY_THRESHOLD. This is the industry-standard "consolidation pass"
  // used by Google Photos / Apple Photos after initial clustering.
  let peopleMerged = 0;
  const { data: freshPeople } = await sb
    .from("people")
    .select("id, rekognition_face_ids, faces, face_count, cover_face_crop, cover_asset_id, cover_bbox")
    .eq("user_id", uid)
    .like("auto_label", "auto:person:%");

  // Build id→person map for quick lookup.
  const personById = new Map<string, typeof freshPeople extends (infer T)[] | null ? T : never>();
  for (const p of freshPeople ?? []) personById.set((p as any).id, p as any);

  // Track which person IDs have already been merged (absorbed) into another.
  const absorbed = new Set<string>();

  for (const [pid] of personFaceMap) {
    if (absorbed.has(pid)) continue;
    const person = personById.get(pid);
    if (!person) continue;
    const faceIds: string[] = Array.isArray((person as any).rekognition_face_ids)
      ? (person as any).rekognition_face_ids : [];
    if (faceIds.length === 0) continue;

    // Search with first face_id to find matches across the collection.
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

    // Merge matchingPersonId into pid (keep pid, absorb the other).
    const other = personById.get(matchingPersonId);
    if (!other) continue;

    const otherFaces: any[] = Array.isArray((other as any).faces) ? (other as any).faces : [];
    const otherFaceIds: string[] = Array.isArray((other as any).rekognition_face_ids)
      ? (other as any).rekognition_face_ids : [];
    const myFaces: any[] = Array.isArray((person as any).faces) ? (person as any).faces : [];
    const myFaceIds: string[] = Array.isArray((person as any).rekognition_face_ids)
      ? (person as any).rekognition_face_ids : [];

    const mergedFaces = [...myFaces, ...otherFaces];
    const mergedFaceIds = [...new Set([...myFaceIds, ...otherFaceIds])];

    // Pick best cover from merged faces.
    let mergedBestCover = (person as any).cover_face_crop ? person : null;
    let mergedBestScore = mergedBestCover
      ? coverScore({ attributes: null, confidence: (person as any).cover_face_crop ? 1 : 0 })
      : -1;
    for (const mface of mergedFaces) {
      if (!mface.face_crop) continue;
      const s = coverScore({ attributes: mface.attributes ?? null, confidence: mface.confidence ?? 0.5 });
      if (s >= MIN_COVER_SCORE && s > mergedBestScore) {
        mergedBestScore = s;
        mergedBestCover = mface;
      }
    }

    const mergeUpdate: Record<string, unknown> = {
      faces: mergedFaces,
      face_count: mergedFaces.length,
      rekognition_face_ids: mergedFaceIds,
    };
    if (mergedBestCover && (mergedBestCover as any).face_crop) {
      mergeUpdate.cover_face_crop = (mergedBestCover as any).face_crop;
      mergeUpdate.cover_asset_id  = (mergedBestCover as any).asset_id ?? (mergedBestCover as any).cover_asset_id;
      mergeUpdate.cover_bbox      = (mergedBestCover as any).bbox ?? (mergedBestCover as any).cover_bbox;
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
