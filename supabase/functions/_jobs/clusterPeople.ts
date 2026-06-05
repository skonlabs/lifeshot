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

const CLUSTER_THRESHOLD = 0.82; // cosine similarity; tune based on real data

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
  const facesWithoutEmbedding: Array<{ asset_id: string; face: any }> = [];

  for (const row of enrichRows ?? []) {
    const faces = Array.isArray(row.faces) ? row.faces : [];
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      const emb = Array.isArray(f.embedding) && f.embedding.length > 0 ? f.embedding as number[] : null;
      if (emb) {
        faceEntries.push({
          asset_id: row.asset_id,
          face_index: i,
          bbox: f.bbox ?? null,
          description: f.description ?? "",
          confidence: f.score ?? f.confidence ?? 0.5,
          embedding: emb,
        });
      } else if (f.score != null || f.confidence != null) {
        // Face detected but no embedding — link to generic group.
        facesWithoutEmbedding.push({ asset_id: row.asset_id, face: f });
      }
    }
  }

  // For faces without embeddings, upsert into a generic "unclustered" person.
  let unclusteredLinked = 0;
  if (facesWithoutEmbedding.length > 0) {
    const { data: genericPerson, error: gpErr } = await sb
      .from("people")
      .upsert(
        { user_id: uid, auto_label: "auto:unclustered-faces", display_name: "People in your photos", consent_required: true },
        { onConflict: "user_id,auto_label" },
      )
      .select("id").single();
    if (!gpErr && genericPerson) {
      const rows = facesWithoutEmbedding.map(({ asset_id: aid, face }) => ({
        person_id: genericPerson.id,
        asset_id: aid,
        bbox: face.bbox ?? null,
        confidence: face.score ?? face.confidence ?? null,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        await sb.from("person_faces").upsert(rows.slice(i, i + 500), { onConflict: "person_id,asset_id" });
        unclusteredLinked += Math.min(500, rows.length - i);
      }
    }
  }

  if (faceEntries.length === 0) {
    return { user_id: uid, people: 0, clustered: unclusteredLinked, no_embeddings: facesWithoutEmbedding.length };
  }

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

  let personCounter = existingPeople?.length ?? 0;
  let clusteredFaces = 0;

  for (const entry of faceEntries) {
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
    else clusteredFaces++;
  }

  return {
    user_id: uid,
    people: personVectors.size,
    clustered: clusteredFaces + unclusteredLinked,
    faces_with_embedding: faceEntries.length,
    faces_without_embedding: facesWithoutEmbedding.length,
  };
}
