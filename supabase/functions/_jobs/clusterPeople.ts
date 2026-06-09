// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { sanitizeFaceBox } from "../_shared/face-box.ts";
import { collectionIdForUser, searchFaces, rekognitionConfigured } from "../_ai/rekognition.ts";
import { isUsableFace } from "../_ai/face-quality.ts";

/**
 * clusterPeople — groups detected faces into people using AWS Rekognition.
 *
 * Post-B-NUKE storage layout: faces are stored as a jsonb array on
 * public.people (faces[], face_count, rekognition_face_ids[], cover_asset_id,
 * cover_bbox). The person_faces table is gone.
 *
 * Per face with a Rekognition FaceId:
 *   1. If FaceId already appears in any people.rekognition_face_ids → use that person.
 *   2. Otherwise SearchFaces(FaceId) → if a match maps to a known person → use it.
 *   3. Otherwise embedding cosine match against existing faces → use that person.
 *   4. Otherwise create a new auto-labelled person.
 * Faces are appended to people.faces (idempotent on asset_id+rekognition_face_id).
 */

// Rekognition's own recommended same-person threshold is 80. We were running
// at 90, which is conservative enough to split the same person across multiple
// "people" rows when lighting/angle differs. Drop to 80 for primary matching
// and use 70 as a wider safety-net sweep before creating a brand-new person.
const FACE_MATCH_THRESHOLD = 80;
const FACE_MATCH_FALLBACK_THRESHOLD = 70;
const FACE_VECTOR_MATCH_THRESHOLD = 0.78;

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = Number(a[i] ?? 0), bv = Number(b[i] ?? 0);
    dot += av * bv; na += av * av; nb += bv * bv;
  }
  if (na <= 0 || nb <= 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface FaceEntry {
  asset_id: string;
  face_index: number;
  bbox: any;
  confidence: number;
  face_id: string | null;
  embedding: number[] | null;
  attributes: Record<string, unknown> | null;
  face_crop: string | null;
}

interface PersonRow {
  id: string;
  auto_label: string | null;
  faces: any[];
  face_count: number;
  rekognition_face_ids: string[];
  cover_asset_id: string | null;
  cover_bbox: any;
}

export async function clusterPeople(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, asset_id } = ctx.payload as { user_id?: string; asset_id?: string };
  const uid = user_id ?? ctx.userId;
  if (!uid) throw new Error("invalid: user_id");

  const { data: privacy } = await sb.from("privacy_settings")
    .select("face_processing_enabled").eq("user_id", uid).maybeSingle();
  if (!privacy?.face_processing_enabled) {
    return { user_id: uid, skipped: "consent", clustered: 0 };
  }
  if (!rekognitionConfigured()) {
    return { user_id: uid, skipped: "rekognition_not_configured", clustered: 0 };
  }

  let enrichQuery = sb.from("asset_ai_enrichment")
    .select("asset_id, faces").eq("user_id", uid);
  if (asset_id) enrichQuery = enrichQuery.eq("asset_id", asset_id);
  const { data: enrichRows, error } = await enrichQuery;
  if (error) throw new Error(`clusterPeople fetch: ${error.message}`);

  const faceEntries: FaceEntry[] = [];
  for (const row of enrichRows ?? []) {
    const faces = Array.isArray(row.faces) ? row.faces : [];
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i] as any;
      const faceId = typeof f.face_id === "string" && f.face_id.length > 0 ? f.face_id : null;
      const bbox = sanitizeFaceBox(f.bbox ?? null);
      if (!bbox) continue;
      const embedding = Array.isArray(f.embedding) && f.embedding.length > 0
        ? f.embedding.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v))
        : null;
      if (!faceId && !embedding?.length) continue;
      // Re-apply the shared quality gate in case this row was written by an
      // older code path that didn't filter pose/quality before persisting.
      const attrs = (f.attributes ?? null) as Record<string, unknown> | null;
      const conf = Number(f.score ?? f.confidence ?? 0.5);
      if (!isUsableFace({ confidence: conf, attributes: attrs as Record<string, any> | null })) continue;
      faceEntries.push({
        asset_id: row.asset_id, face_index: i, bbox,
        confidence: conf,
        face_id: faceId, embedding,
        attributes: attrs,
        face_crop: typeof f.face_crop === "string" ? f.face_crop : null,
      });
    }
  }

  if (faceEntries.length === 0) {
    return { user_id: uid, people: 0, clustered: 0, skipped_faces: true };
  }

  const collectionId = collectionIdForUser(uid);

  const { data: existingPeopleData } = await sb.from("people")
    .select("id, auto_label, faces, face_count, rekognition_face_ids, cover_asset_id, cover_bbox")
    .eq("user_id", uid);

  const people: Map<string, PersonRow> = new Map();
  const faceIdToPerson = new Map<string, string>();
  for (const p of existingPeopleData ?? []) {
    const row: PersonRow = {
      id: p.id, auto_label: p.auto_label,
      faces: Array.isArray(p.faces) ? p.faces : [],
      face_count: p.face_count ?? 0,
      rekognition_face_ids: Array.isArray(p.rekognition_face_ids) ? p.rekognition_face_ids : [],
      cover_asset_id: p.cover_asset_id,
      cover_bbox: p.cover_bbox,
    };
    people.set(p.id, row);
    for (const fid of row.rekognition_face_ids) faceIdToPerson.set(fid, p.id);
  }

  let personCounter = Math.max(0, ...Array.from(people.values())
    .map((p) => Number(String(p.auto_label ?? "").split(":").at(-1) ?? 0))
    .filter(Number.isFinite));

  function bestPersonByEmbedding(embedding: number[]): string | null {
    let best: string | null = null;
    let bestSim = Number.NEGATIVE_INFINITY;
    for (const [pid, row] of people.entries()) {
      for (const f of row.faces) {
        const v = Array.isArray(f.face_vector) ? f.face_vector : null;
        if (!v?.length) continue;
        const sim = cosineSimilarity(embedding, v.map((x: unknown) => Number(x)));
        if (sim > bestSim) { bestSim = sim; best = pid; }
      }
    }
    return best && bestSim >= FACE_VECTOR_MATCH_THRESHOLD ? best : null;
  }

  // Track which people changed so we only write back what we touched.
  const dirty = new Set<string>();
  let clusteredFaces = 0;

  for (const entry of faceEntries) {
    let matchedPersonId: string | null = null;

    if (entry.face_id && faceIdToPerson.has(entry.face_id)) {
      matchedPersonId = faceIdToPerson.get(entry.face_id)!;
    }

    if (!matchedPersonId && entry.face_id) {
      // Primary search: vote across ALL matched face ids by similarity, not
      // just the first hit. This is the dedup step the user asked for —
      // before assigning to a person we make Rekognition compare this face
      // against every face already indexed for the user.
      try {
        const matches = await searchFaces({
          collectionId, faceId: entry.face_id,
          faceMatchThreshold: FACE_MATCH_THRESHOLD, maxFaces: 20,
        });
        matchedPersonId = pickPersonFromMatches(matches, faceIdToPerson);
      } catch (e: any) {
        console.warn("clusterPeople: searchFaces failed", entry.face_id, String(e?.message ?? e));
      }
    }

    if (!matchedPersonId && entry.embedding?.length) {
      matchedPersonId = bestPersonByEmbedding(entry.embedding);
    }

    if (!matchedPersonId && entry.face_id) {
      // Safety-net sweep at a lower threshold to avoid creating a duplicate
      // person for the same face under different lighting/pose.
      try {
        const matches = await searchFaces({
          collectionId, faceId: entry.face_id,
          faceMatchThreshold: FACE_MATCH_FALLBACK_THRESHOLD, maxFaces: 20,
        });
        matchedPersonId = pickPersonFromMatches(matches, faceIdToPerson);
      } catch (e: any) {
        console.warn("clusterPeople: fallback searchFaces failed", entry.face_id, String(e?.message ?? e));
      }
    }

    let personId: string;
    if (matchedPersonId) {
      personId = matchedPersonId;
    } else {
      personCounter++;
      const autoLabel = `auto:person:${personCounter}`;
      const { data: newPerson, error: npErr } = await sb.from("people")
        .upsert({
          user_id: uid, auto_label: autoLabel,
          display_name: `Person ${personCounter}`, consent_required: true,
        }, { onConflict: "user_id,auto_label" })
        .select("id, auto_label, faces, face_count, rekognition_face_ids, cover_asset_id, cover_bbox")
        .single();
      if (npErr || !newPerson) {
        console.error("clusterPeople: person upsert failed", npErr?.message);
        continue;
      }
      const row: PersonRow = {
        id: newPerson.id, auto_label: newPerson.auto_label,
        faces: Array.isArray(newPerson.faces) ? newPerson.faces : [],
        face_count: newPerson.face_count ?? 0,
        rekognition_face_ids: Array.isArray(newPerson.rekognition_face_ids) ? newPerson.rekognition_face_ids : [],
        cover_asset_id: newPerson.cover_asset_id,
        cover_bbox: newPerson.cover_bbox,
      };
      people.set(row.id, row);
      personId = row.id;
    }

    const row = people.get(personId);
    if (!row) continue;

    // Cross-person dedup: scan ALL people for any existing (asset_id, face_id)
    // (or, when face_id is null, asset_id+bbox). If found on a different
    // person, remove it there — every (asset_id, face_id) lives on exactly
    // one person. If found on the same person, this is a no-op.
    const matches = (f: any) =>
      f.asset_id === entry.asset_id &&
      ((entry.face_id && f.rekognition_face_id === entry.face_id) ||
       (!entry.face_id && JSON.stringify(f.bbox) === JSON.stringify(entry.bbox)));
    let alreadyOnThisPerson = false;
    for (const [otherId, otherRow] of people.entries()) {
      const hitIdx = otherRow.faces.findIndex(matches);
      if (hitIdx < 0) continue;
      if (otherId === personId) { alreadyOnThisPerson = true; continue; }
      // Move: remove from the other person, recompute its derived fields.
      otherRow.faces.splice(hitIdx, 1);
      otherRow.face_count = otherRow.faces.length;
      if (otherRow.faces.length > 0) {
        const top = otherRow.faces.reduce((a: any, b: any) =>
          (a.confidence ?? 0) >= (b.confidence ?? 0) ? a : b);
        otherRow.cover_asset_id = top.asset_id;
        otherRow.cover_bbox = top.bbox;
      } else {
        otherRow.cover_asset_id = null;
        otherRow.cover_bbox = null;
      }
      dirty.add(otherId);
    }
    if (!alreadyOnThisPerson) {
      row.faces.push({
        asset_id: entry.asset_id, bbox: entry.bbox, confidence: entry.confidence,
        face_crop: entry.face_crop, face_vector: entry.embedding,
        rekognition_face_id: entry.face_id, rekognition_response: entry.attributes,
        created_at: new Date().toISOString(),
      });
      row.face_count = row.faces.length;
      if (entry.face_id && !row.rekognition_face_ids.includes(entry.face_id)) {
        row.rekognition_face_ids.push(entry.face_id);
        faceIdToPerson.set(entry.face_id, personId);
      }
      // Update cover to highest-confidence face.
      const top = row.faces.reduce((a: any, b: any) =>
        (a.confidence ?? 0) >= (b.confidence ?? 0) ? a : b);
      row.cover_asset_id = top.asset_id;
      row.cover_bbox = top.bbox;
      dirty.add(personId);
      clusteredFaces++;
    }
  }

  for (const pid of dirty) {
    const row = people.get(pid);
    if (!row) continue;
    const { error: upErr } = await sb.from("people").update({
      faces: row.faces,
      face_count: row.face_count,
      rekognition_face_ids: row.rekognition_face_ids,
      cover_asset_id: row.cover_asset_id,
      cover_bbox: row.cover_bbox,
    }).eq("id", pid);
    if (upErr) console.error("clusterPeople: people update failed", pid, upErr.message);
  }

  return { user_id: uid, clustered: clusteredFaces, faces_total: faceEntries.length };
}

/**
 * Pick the best person from a SearchFaces result set: walk matches in
 * similarity order and return the first one whose FaceId we already mapped
 * to a person. If multiple matches map to the same person, that person wins
 * (Rekognition returns matches sorted by similarity desc).
 */
function pickPersonFromMatches(
  matches: Array<{ faceId: string; similarity: number }>,
  faceIdToPerson: Map<string, string>,
): string | null {
  const votes = new Map<string, number>();
  for (const m of matches) {
    const pid = faceIdToPerson.get(m.faceId);
    if (!pid) continue;
    votes.set(pid, (votes.get(pid) ?? 0) + m.similarity);
  }
  let best: string | null = null;
  let bestScore = -1;
  for (const [pid, score] of votes.entries()) {
    if (score > bestScore) { bestScore = score; best = pid; }
  }
  return best;
}
