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
  const yaw     = Math.abs(Number(pose.Yaw   ?? 90));
  const pitch   = Math.abs(Number(pose.Pitch ?? 90));
  const sharp   = Number(quality.Sharpness  ?? 0);
  const bright  = Number(quality.Brightness ?? 0);
  if (occluded) return 0;
  // Normalise: lower yaw/pitch = better; higher sharpness/brightness = better.
  const frontality = Math.max(0, (1 - yaw / 90)) * Math.max(0, (1 - pitch / 90));
  return frontality * 0.6 + (sharp / 100) * 0.3 + (bright / 100) * 0.1;
}

/**
 * clusterPeople — identifies people across detected faces using AWS Rekognition
 * SearchFaces for identity matching.
 *
 * Biometric consent gate: only runs when privacy_settings.face_processing_enabled = true.
 *
 * Algorithm:
 *  1. Collect all faces (with face_id) for the user (or specific asset).
 *  2. For each face, call SearchFaces at 75% threshold in the user's Rekognition collection.
 *  3. If a match is found, look up which person owns that matching face_id in person_faces.
 *  4. If similarity ≥ PRIMARY_THRESHOLD (75%), assign to that person.
 *     If similarity ≥ FALLBACK_THRESHOLD (65%) and no primary match, use fallback.
 *     Otherwise create a new person.
 *  5. Upsert person_faces with face_id, bbox, confidence.
 *  6. Set cover_face_crop on people when a high-quality face crop is available.
 *
 * Idempotent: upserts on (person_id, asset_id).
 */

const PRIMARY_THRESHOLD = 75;  // Rekognition similarity 0-100
const FALLBACK_THRESHOLD = 65;
// Minimum cover quality: score < this means side profile / occluded / blurry.
// Approx: yaw<40°, pitch<40°, not occluded, some sharpness.
const MIN_COVER_SCORE = 0.30;

export async function clusterPeople(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, asset_id } = ctx.payload as { user_id?: string; asset_id?: string };
  const uid = user_id ?? ctx.userId;
  if (!uid) throw new Error("invalid: user_id");

  // Consent gate — biometric processing requires explicit opt-in.
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

  // Build flat list of faces that have Rekognition face_ids.
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

  // Load existing people for this user.
  const { data: existingPeople } = await sb
    .from("people")
    .select("id, auto_label, display_name, cover_face_crop, cover_asset_id")
    .eq("user_id", uid)
    .like("auto_label", "auto:person:%");

  // Build a map from face_id → person_id using person_faces.
  // This is how we look up who owns a matching FaceId after SearchFaces.
  const faceIdToPersonId = new Map<string, string>();
  if (existingPeople?.length) {
    const ids = existingPeople.map((p: any) => p.id);
    const { data: pf } = await sb
      .from("person_faces")
      .select("person_id, face_id")
      .in("person_id", ids)
      .not("face_id", "is", null);
    for (const row of pf ?? []) {
      if (row.face_id) faceIdToPersonId.set(row.face_id, row.person_id);
    }
  }

  let personCounter = existingPeople?.length ?? 0;
  let clusteredFaces = 0;
  // Track people that need cover updates: person_id → best face entry
  const coverCandidates = new Map<string, FaceEntry>();

  for (const entry of faceEntries) {
    let personId: string | null = null;

    // SearchFaces returns other faces in the collection that match this one.
    try {
      const matches = await searchFaces({
        collectionId,
        faceId: entry.face_id,
        faceMatchThreshold: FALLBACK_THRESHOLD,
        maxFaces: 10,
      });

      // Find the best match above threshold, sorted by similarity desc.
      const sorted = matches
        .filter((m) => m.faceId !== entry.face_id)
        .sort((a, b) => b.similarity - a.similarity);

      // Primary threshold first, then fallback.
      const primary = sorted.find((m) => m.similarity >= PRIMARY_THRESHOLD && faceIdToPersonId.has(m.faceId));
      const fallback = sorted.find((m) => m.similarity >= FALLBACK_THRESHOLD && faceIdToPersonId.has(m.faceId));
      const match = primary ?? fallback ?? null;

      if (match) {
        personId = faceIdToPersonId.get(match.faceId)!;
      }
    } catch (e: any) {
      console.warn("clusterPeople: SearchFaces failed", entry.face_id, String(e?.message ?? e));
      // Continue — we'll create a new person rather than crashing.
    }

    if (!personId) {
      // No match found — create a new person cluster.
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

    // Register this face_id as belonging to this person so future faces in
    // this run can match against it without another SearchFaces round-trip.
    faceIdToPersonId.set(entry.face_id, personId);

    const { error: fErr } = await sb.from("person_faces").upsert({
      person_id: personId,
      asset_id: entry.asset_id,
      bbox: entry.bbox,
      confidence: entry.confidence,
      face_id: entry.face_id,
    }, { onConflict: "person_id,asset_id" });

    if (fErr) {
      console.error("clusterPeople: person_faces upsert failed", fErr.message);
    } else {
      clusteredFaces++;
      // Track best-quality face crop for this person's cover avatar.
      // Replace the current candidate if this face scores higher.
      if (entry.face_crop) {
        const score = coverScore({ attributes: entry.attributes, confidence: entry.confidence });
        if (score >= MIN_COVER_SCORE) {
          const current = coverCandidates.get(personId);
          const currentScore = current ? coverScore({ attributes: current.attributes, confidence: current.confidence }) : -1;
          if (score > currentScore) coverCandidates.set(personId, entry);
        }
      }
    }
  }

  // Update cover_face_crop — always write the best-scored face found this run.
  if (coverCandidates.size > 0) {
    for (const [pid, entry] of coverCandidates) {
      await sb.from("people").update({
        cover_face_crop: entry.face_crop,
        cover_asset_id: entry.asset_id,
        cover_bbox: entry.bbox,
      }).eq("id", pid);
    }
  }

  return {
    user_id: uid,
    people: personCounter,
    clustered: clusteredFaces,
    faces_processed: faceEntries.length,
    covers_updated: coverCandidates.size,
  };
}
