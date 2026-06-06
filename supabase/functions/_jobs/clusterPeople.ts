// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/**
 * clusterPeople — groups detected faces into people using cosine similarity
 * on 512-dim face description embeddings stored in asset_ai_enrichment.faces.
 *
 * Biometric consent gate: only runs when privacy_settings.face_processing_enabled = true.
 *
 * Algorithm:
 *  1. Collect all faces (with embeddings) for the user (or specific asset).
 *  2. For each face, find the closest existing person by cosine similarity.
 *  3. If similarity ≥ CLUSTER_THRESHOLD, assign to that person.
 *     Otherwise create a new person with an auto-incrementing label.
 *  4. Write person_faces rows with real bbox and face_vector.
 *
 * Idempotent: upserts on (person_id, asset_id).
 */

// Identity-signature embeddings (text-embedding-3-small over a deterministic
// slot string) cluster tightly when the slots match; loosen the threshold so
// minor slot differences (e.g. eye-color:brown vs hazel) still match the same
// person across photos.
const CLUSTER_THRESHOLD = 0.78;

function bboxArea(bbox: { w?: number; h?: number } | null | undefined): number {
  if (!bbox) return 0;
  return Math.max(Number(bbox.w ?? 0), 0) * Math.max(Number(bbox.h ?? 0), 0);
}

function cosineSim(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

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

  // Fetch enrichment rows with face detections.
  let enrichQuery = sb
    .from("asset_ai_enrichment")
    .select("asset_id, faces")
    .eq("user_id", uid);
  if (asset_id) enrichQuery = enrichQuery.eq("asset_id", asset_id);

  const { data: enrichRows, error } = await enrichQuery;
  if (error) throw new Error(`clusterPeople fetch: ${error.message}`);

  // Build flat list of faces that have real embeddings.
  interface FaceEntry {
    asset_id: string;
    face_index: number;
    bbox: any;
    description: string;
    confidence: number;
    embedding: number[];
  }

  const faceEntries: FaceEntry[] = [];

  for (const row of enrichRows ?? []) {
    const faces = Array.isArray(row.faces) ? row.faces : [];
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      const emb = Array.isArray(f.embedding) && f.embedding.length > 0 ? f.embedding as number[] : null;
      const bbox = f.bbox ?? null;
      const confidence = f.score ?? f.confidence ?? 0.5;
      const hasUsableBbox = bbox && bbox.w > 0.08 && bbox.h > 0.08;
      if (emb && hasUsableBbox && confidence >= 0.6) {
        faceEntries.push({
          asset_id: row.asset_id,
          face_index: i,
          bbox,
          description: f.description ?? "",
          confidence,
          embedding: emb,
        });
      }
    }
  }

  if (faceEntries.length === 0) {
    return { user_id: uid, people: 0, clustered: 0, skipped_faces: true };
  }

  faceEntries.sort((a, b) => {
    const confDelta = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (confDelta !== 0) return confDelta;
    return bboxArea(b.bbox) - bboxArea(a.bbox);
  });

  // Load existing people with representative face vectors to match against.
  // We use the first face_vector stored per person as the representative centroid.
  const { data: existingPeople } = await sb
    .from("people")
    .select("id, auto_label, display_name")
    .eq("user_id", uid)
    .like("auto_label", "auto:person:%");

  // Load representative vectors for existing auto people.
  const personVectors = new Map<string, { personId: string; autoLabel: string; centroid: number[] }>();
  if (existingPeople?.length) {
    const ids = existingPeople.map((p) => p.id);
    const { data: pf } = await sb
      .from("person_faces")
      .select("person_id, face_vector")
      .in("person_id", ids)
      .not("face_vector", "is", null)
      .order("created_at", { ascending: true });

    for (const row of pf ?? []) {
      if (!personVectors.has(row.person_id) && Array.isArray(row.face_vector)) {
        personVectors.set(row.person_id, {
          personId: row.person_id,
          autoLabel: existingPeople.find((p) => p.id === row.person_id)?.auto_label ?? "",
          centroid: row.face_vector as number[],
        });
      }
    }
  }

  let personCounter = Math.max(
    0,
    ...(existingPeople ?? []).map((p) => Number(String(p.auto_label ?? "").split(":").at(-1) ?? 0)).filter(Number.isFinite),
  );
  let clusteredFaces = 0;
  const assignedAssetFace = new Set<string>();

  for (const entry of faceEntries) {
    if (assignedAssetFace.has(entry.asset_id)) continue;
    let matchedPersonId: string | null = null;
    let bestSim = -1;

    for (const pv of personVectors.values()) {
      const sim = cosineSim(entry.embedding, pv.centroid);
      if (sim > bestSim) { bestSim = sim; matchedPersonId = pv.personId; }
    }

    let personId: string;
    if (matchedPersonId && bestSim >= CLUSTER_THRESHOLD) {
      personId = matchedPersonId;
    } else {
      // Create a new person cluster.
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
      // Register as representative for future faces in this run.
      personVectors.set(personId, { personId, autoLabel, centroid: entry.embedding });
    }

    const { error: fErr } = await sb.from("person_faces").upsert({
      person_id: personId,
      asset_id: entry.asset_id,
      bbox: entry.bbox,
      confidence: entry.confidence,
      face_vector: entry.embedding,
    }, { onConflict: "person_id,asset_id" });
    if (fErr) console.error("clusterPeople: person_faces upsert failed", fErr.message);
    else {
      clusteredFaces++;
      assignedAssetFace.add(entry.asset_id);
    }
  }

  return {
    user_id: uid,
    people: personVectors.size,
    clustered: clusteredFaces,
    faces_with_embedding: faceEntries.length,
    faces_without_embedding: 0,
  };
}
