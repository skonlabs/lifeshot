// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { sanitizeFaceBox } from "../_shared/face-box.ts";
import { collectionIdForUser, searchFaces, rekognitionConfigured } from "../_ai/rekognition.ts";

/**
 * clusterPeople — groups detected faces into people using AWS Rekognition's
 * face matching. Each face was indexed by enrichAI; here we call SearchFaces
 * with its FaceId to find any other faces (already assigned to a person)
 * that match above the similarity threshold.
 *
 * Biometric consent gate: only runs when privacy_settings.face_processing_enabled = true.
 *
 * Algorithm (per face with a rekognition_face_id):
 *   1. SearchFaces against the user's collection (threshold 90% similarity).
 *   2. If a match maps to an existing person → assign to that person.
 *   3. Otherwise, create a new auto-labelled person and assign this face.
 *
 * Idempotent: upserts on (person_id, asset_id), skips faces already linked.
 */

const FACE_MATCH_THRESHOLD = 90; // 0-100, AWS recommends 80+ for identity matching

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

  // Build flat list of faces that have a Rekognition FaceId.
  interface FaceEntry {
    asset_id: string;
    face_index: number;
    bbox: any;
    confidence: number;
    face_id: string;
    attributes: Record<string, unknown> | null;
  }

  const faceEntries: FaceEntry[] = [];
  for (const row of enrichRows ?? []) {
    const faces = Array.isArray(row.faces) ? row.faces : [];
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i] as any;
      const faceId = typeof f.face_id === "string" && f.face_id.length > 0 ? f.face_id : null;
      if (!faceId) continue;
      const bbox = sanitizeFaceBox(f.bbox ?? null);
      if (!bbox) continue;
      faceEntries.push({
        asset_id: row.asset_id,
        face_index: i,
        bbox,
        confidence: Number(f.score ?? f.confidence ?? 0.5),
        face_id: faceId,
        attributes: (f.attributes ?? null) as Record<string, unknown> | null,
      });
    }
  }

  if (faceEntries.length === 0) {
    return { user_id: uid, people: 0, clustered: 0, skipped_faces: true };
  }

  const collectionId = collectionIdForUser(uid);

  // Load existing FaceId → personId mapping so we can attach incoming faces
  // to known clusters without re-querying Rekognition for previously-seen faces.
  const allFaceIds = faceEntries.map((e) => e.face_id);
  const { data: existingMappings } = await sb
    .from("person_faces")
    .select("person_id, rekognition_face_id")
    .in("rekognition_face_id", allFaceIds);
  const faceIdToPerson = new Map<string, string>();
  for (const row of existingMappings ?? []) {
    if (row.rekognition_face_id) faceIdToPerson.set(row.rekognition_face_id, row.person_id);
  }

  // Determine highest existing auto-label counter for new-person naming.
  const { data: existingPeople } = await sb
    .from("people")
    .select("id, auto_label")
    .eq("user_id", uid)
    .like("auto_label", "auto:person:%");
  let personCounter = Math.max(
    0,
    ...(existingPeople ?? [])
      .map((p) => Number(String(p.auto_label ?? "").split(":").at(-1) ?? 0))
      .filter(Number.isFinite),
  );

  let clusteredFaces = 0;

  for (const entry of faceEntries) {
    // Skip faces already linked to a person.
    if (faceIdToPerson.has(entry.face_id)) {
      const existingPersonId = faceIdToPerson.get(entry.face_id)!;
      // Ensure this exact (person, asset, face) link exists.
      const { error: upErr } = await sb.from("person_faces").upsert({
        person_id: existingPersonId,
        asset_id: entry.asset_id,
        bbox: entry.bbox,
        confidence: entry.confidence,
        rekognition_face_id: entry.face_id,
      }, { onConflict: "person_id,asset_id" });
      if (!upErr) clusteredFaces++;
      continue;
    }

    // Search the collection for similar faces (excluding this one).
    let matchedPersonId: string | null = null;
    try {
      const matches = await searchFaces({
        collectionId,
        faceId: entry.face_id,
        faceMatchThreshold: FACE_MATCH_THRESHOLD,
        maxFaces: 10,
      });
      for (const m of matches) {
        const pid = faceIdToPerson.get(m.faceId);
        if (pid) { matchedPersonId = pid; break; }
      }
    } catch (e: any) {
      console.warn("clusterPeople: searchFaces failed", entry.face_id, String(e?.message ?? e));
    }

    let personId: string;
    if (matchedPersonId) {
      personId = matchedPersonId;
    } else {
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

    const { error: fErr } = await sb.from("person_faces").upsert({
      person_id: personId,
      asset_id: entry.asset_id,
      bbox: entry.bbox,
      confidence: entry.confidence,
      rekognition_face_id: entry.face_id,
    }, { onConflict: "person_id,asset_id" });
    if (fErr) console.error("clusterPeople: person_faces upsert failed", fErr.message);
    else {
      faceIdToPerson.set(entry.face_id, personId);
      clusteredFaces++;
    }
  }

  return {
    user_id: uid,
    clustered: clusteredFaces,
    faces_total: faceEntries.length,
  };
}
