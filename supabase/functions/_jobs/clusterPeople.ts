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

const PRIMARY_THRESHOLD  = 80;
const FALLBACK_THRESHOLD = 70;
const MIN_COVER_SCORE    = 0.50;

// Maximum absolute pose angles for a face to qualify (excludes side profiles).
const MAX_YAW_DEG   = 40;
const MAX_PITCH_DEG = 35;

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
    .select("asset_id, face_id, bbox, confidence, attributes")
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
    attributes: any;
  }

  const faceEntries: FaceEntry[] = [];
  for (const f of faceRows ?? []) {
    if (!f.face_id) continue;
    // Use values straight from the stored Rekognition FaceDetail JSON:
    // FaceOccluded.Value (boolean) and Confidence (0-100).
    const attrs = f.attributes as any;
    const notOccluded = attrs?.FaceOccluded?.Value === false;
    const jsonConfidence = Number(attrs?.Confidence ?? 0); // 0-100 Rekognition scale
    const pose  = attrs?.Pose ?? {};
    const yaw   = Math.abs(Number(pose.Yaw   ?? 90));
    const pitch = Math.abs(Number(pose.Pitch ?? 90));
    const notSideProfile = yaw < MAX_YAW_DEG && pitch < MAX_PITCH_DEG;
    const qualifies = notOccluded && jsonConfidence > 90 && notSideProfile;
    if (!qualifies) continue;
    const confidence = jsonConfidence / 100;
    faceEntries.push({
      asset_id:   f.asset_id,
      face_id:    f.face_id,
      bbox:       f.bbox ?? null,
      confidence,
      attributes: f.attributes ?? null,
    });
  }

  if (faceEntries.length === 0) {
    return {
      user_id: uid, people: 0, clustered: 0, reason: "no_qualifying_faces",
      faces_total: (faceRows ?? []).length,
    };
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
        // Throw instead of swallowing: a silent continue here makes the job
        // "complete" while writing zero people, hiding the root cause.
        throw new Error(`clusterPeople: person upsert failed: ${npErr?.message ?? "no row returned"}`);
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
  // MERGE strategy: keep face entries from assets not in this run, replace those
  // from assets touched in this run. Uses a client-side read-then-write; the
  // atomic merge_person_faces RPC (migration 20260612040000) eliminates the race
  // when that migration has been applied — until then this path is safe for
  // sequential (non-parallel) clusterPeople runs.
  const assetsInThisRun = new Set(faceEntries.map((e) => e.asset_id));

  let peopleUpdated = 0;
  for (const [pid, entries] of personFaceMap) {
    const existing = (existingPeople ?? []).find((p: any) => p.id === pid);
    const existingFaces: any[] = Array.isArray((existing as any)?.faces)
      ? (existing as any).faces
      : [];

    // Keep occurrences from assets NOT processed in this run.
    const kept = existingFaces.filter((o: any) => !assetsInThisRun.has(o.asset_id));
    // Add fresh occurrences from this run (no face_crop — stored separately in
    // asset_faces; including it here bloats the people.faces JSONB into 100MB+,
    // which causes the bulk query above to return empty results silently).
    const fresh = entries.map((e) => ({
      asset_id:            e.asset_id,
      bbox:                e.bbox,
      confidence:          e.confidence,
      attributes:          e.attributes,
      rekognition_face_id: e.face_id,
    }));
    const merged = [...kept, ...fresh];

    // Pick best cover candidate from merged faces by score.
    // Prefer solo-portrait assets (only one qualifying face from that asset).
    const facesPerAsset = new Map<string, number>();
    for (const o of merged) facesPerAsset.set(o.asset_id, (facesPerAsset.get(o.asset_id) ?? 0) + 1);

    let bestCoverEntry: typeof fresh[0] | null = null;
    let bestScore = -1;
    for (const o of merged) {
      const s = coverScore(o.attributes ?? null);
      if (s < MIN_COVER_SCORE) continue;
      const isSolo = (facesPerAsset.get(o.asset_id) ?? 0) === 1;
      const adjusted = isSolo ? s * 1.3 : s;
      if (adjusted > bestScore) { bestScore = adjusted; bestCoverEntry = o; }
    }

    // Fetch face_crop only for the chosen cover (single targeted row fetch).
    let coverFaceCrop: string | null = null;
    if (bestCoverEntry) {
      const { data: cropRow } = await sb
        .from("asset_faces")
        .select("face_crop")
        .eq("asset_id", bestCoverEntry.asset_id)
        .eq("face_id", bestCoverEntry.rekognition_face_id)
        .maybeSingle();
      coverFaceCrop = cropRow?.face_crop ?? null;
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
    if (coverFaceCrop && bestCoverEntry) {
      update.cover_face_crop = coverFaceCrop;
      update.cover_asset_id  = bestCoverEntry.asset_id;
      update.cover_bbox      = bestCoverEntry.bbox;
    }

    const { error: uErr } = await sb.from("people").update(update).eq("id", pid);
    if (uErr) throw new Error(`clusterPeople: people update failed for ${pid}: ${uErr.message}`);
    peopleUpdated++;
  }

  return {
    user_id:         uid,
    people_created:  maxPersonN - (existingPeople?.length ?? 0),
    people_updated:  peopleUpdated,
    faces_processed: faceEntries.length,
  };
}
