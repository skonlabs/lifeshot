// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { searchFaces, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";

/**
 * Score a face for cover selection. Higher = better avatar quality.
 * Prioritises: frontal pose > sharpness > non-occluded > bright.
 */
function coverScore(attributes: any): number {
  if (!attributes) return 0;
  const pose    = attributes.Pose    ?? {};
  const quality = attributes.Quality ?? {};
  const yaw    = Math.abs(Number(pose.Yaw   ?? 90));
  const pitch  = Math.abs(Number(pose.Pitch ?? 90));
  const sharp  = Number(quality.Sharpness  ?? 0);
  const bright = Number(quality.Brightness ?? 0);
  const eyeYaw   = Math.abs(Number((attributes.EyeDirection?.Yaw   ?? 90)));
  const eyePitch = Math.abs(Number((attributes.EyeDirection?.Pitch ?? 90)));
  const gazeScore = Math.max(0, (1 - eyeYaw / 90)) * Math.max(0, (1 - eyePitch / 90));
  const frontality = Math.max(0, (1 - yaw / 90)) * Math.max(0, (1 - pitch / 90));
  return frontality * 0.50 + (sharp / 100) * 0.25 + (bright / 100) * 0.10 + gazeScore * 0.15;
}

const PRIMARY_THRESHOLD  = 75;
const FALLBACK_THRESHOLD = 65;
const MIN_COVER_SCORE    = 0.30;

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

  // ── 1. Read qualifying faces from asset_faces ─────────────────────────────
  // Quality gate: FaceOccluded=false AND confidence ≥ 0.90.
  // We read ALL qualifying faces for the user (or just one asset for a quick
  // per-asset pass) — clusterPeople is the authoritative writer of people.
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
    face_id:  string;
    bbox:     any;
    confidence: number;
    face_crop:  string | null;
    attributes: any;
  }

  const faceEntries: FaceEntry[] = [];
  for (const f of faceRows ?? []) {
    if (!f.face_id) continue;
    const notOccluded = (f.attributes as any)?.FaceOccluded?.Value === false;
    const confidence = Number(f.confidence ?? 0);
    const qualifies = notOccluded && confidence > 0.9;
    if (!qualifies) continue;
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

  // ── 2. Load existing people and build face→person map ─────────────────────
  const { data: existingPeople } = await sb
    .from("people")
    .select("id, auto_label, display_name, rekognition_face_ids, faces, cover_face_crop, cover_asset_id, cover_bbox")
    .eq("user_id", uid)
    .like("auto_label", "auto:person:%");

  const faceIdToPersonId = new Map<string, string>();
  for (const person of existingPeople ?? []) {
    for (const fid of ((person as any).rekognition_face_ids ?? []) as string[]) {
      if (fid) faceIdToPersonId.set(fid, person.id);
    }
  }

  // Compute max existing label number to avoid collisions when creating new
  // people. Using length causes wrong assignments if labels have gaps.
  let maxPersonN = 0;
  for (const person of existingPeople ?? []) {
    const m = String(person.auto_label ?? "").match(/^auto:person:(\d+)$/);
    if (m) maxPersonN = Math.max(maxPersonN, Number(m[1]));
  }

  // ── 3. Assign each face to a person ───────────────────────────────────────
  // personFaceMap: personId → array of face entries assigned in this run.
  const personFaceMap = new Map<string, FaceEntry[]>();

  for (const entry of faceEntries) {
    // Fast path: face_id already in our map from a prior iteration or DB.
    let personId: string | null = faceIdToPersonId.get(entry.face_id) ?? null;

    if (!personId) {
      // Ask Rekognition whether this face matches any already-known person.
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
        const match    = primary ?? fallback ?? null;
        if (match) personId = faceIdToPersonId.get(match.faceId)!;
      } catch (e: any) {
        console.warn("clusterPeople: SearchFaces failed", entry.face_id, String(e?.message ?? e));
      }
    }

    if (!personId) {
      // No match — create a new person record.
      maxPersonN++;
      const autoLabel = `auto:person:${maxPersonN}`;
      const { data: newPerson, error: npErr } = await sb
        .from("people")
        .upsert(
          { user_id: uid, auto_label: autoLabel, display_name: `Person ${maxPersonN}`, consent_required: true },
          { onConflict: "user_id,auto_label" },
        )
        .select("id").single();
      if (npErr || !newPerson) {
        console.error("clusterPeople: person upsert failed", npErr?.message);
        continue;
      }
      personId = newPerson.id;
    }
    if (!personId) continue;

    faceIdToPersonId.set(entry.face_id, personId);
    const arr = personFaceMap.get(personId) ?? [];
    arr.push(entry);
    personFaceMap.set(personId, arr);
  }

  // ── 4. Persist to people table ────────────────────────────────────────────
  // MERGE strategy: load existing people.faces, replace occurrences for assets
  // touched in this run, keep occurrences from assets not in this run.
  // This prevents a per-asset run from wiping faces from other assets, and
  // prevents a full-user run from racing with another concurrent run.
  const assetsInThisRun = new Set(faceEntries.map((e) => e.asset_id));

  let peopleUpdated = 0;
  for (const [pid, entries] of personFaceMap) {
    // Find the existing person row for MERGE.
    const existing = (existingPeople ?? []).find((p: any) => p.id === pid);
    const existingFaces: any[] = Array.isArray((existing as any)?.faces)
      ? (existing as any).faces
      : [];

    // Keep occurrences from assets NOT processed in this run.
    const kept = existingFaces.filter((o: any) => !assetsInThisRun.has(o.asset_id));
    // Add all occurrences from this run's assignments for this person.
    const fresh = entries.map((e) => ({
      asset_id:            e.asset_id,
      bbox:                e.bbox,
      confidence:          e.confidence,
      face_crop:           e.face_crop,
      attributes:          e.attributes,
      rekognition_face_id: e.face_id,
    }));
    const merged = [...kept, ...fresh];

    // Pick best cover: highest cover-score face that has a face_crop.
    let bestCover: any = null;
    let bestScore = -1;
    for (const o of merged) {
      if (!o.face_crop) continue;
      const s = coverScore(o.attributes ?? null);
      if (s >= MIN_COVER_SCORE && s > bestScore) { bestScore = s; bestCover = o; }
    }
    // If no scored crop, fall back to highest-confidence face with a bbox.
    if (!bestCover) {
      bestCover = merged
        .filter((o: any) => o.bbox)
        .sort((a: any, b: any) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0))[0] ?? null;
    }

    const allFaceIds = [...new Set(
      entries.map((e) => e.face_id).concat(
        Array.isArray((existing as any)?.rekognition_face_ids) ? (existing as any).rekognition_face_ids : [],
      ),
    )].filter(Boolean);

    const update: Record<string, unknown> = {
      faces:                merged,
      face_count:           merged.length,
      rekognition_face_ids: allFaceIds,
    };
    if (bestCover?.face_crop) {
      update.cover_face_crop = bestCover.face_crop;
      update.cover_asset_id  = bestCover.asset_id;
      update.cover_bbox      = bestCover.bbox;
    } else if (bestCover) {
      update.cover_asset_id = bestCover.asset_id;
      update.cover_bbox     = bestCover.bbox;
    }

    const { error: uErr } = await sb.from("people").update(update).eq("id", pid);
    if (uErr) console.error("clusterPeople: people update failed", pid, uErr.message);
    else peopleUpdated++;
  }

  return {
    user_id:         uid,
    people_created:  maxPersonN - (existingPeople?.length ?? 0),
    people_updated:  peopleUpdated,
    faces_processed: faceEntries.length,
  };
}
