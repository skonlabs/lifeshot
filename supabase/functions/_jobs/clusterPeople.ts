// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { searchFaces, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";

// SearchFaces similarity threshold for linking a new detection to an existing
// person. The user asked for ≥50% — keep it conservative; tighten later if we
// see false merges.
const SIMILARITY_THRESHOLD = 50;

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

  // ── 1. Load qualifying faces (quality-filtered; FaceCrop excluded for size) ─
  const rpcArgs: Record<string, unknown> = { p_user_id: uid };
  if (asset_id) rpcArgs.p_asset_id = asset_id;

  const { data: faceRows, error } = await sb.rpc("get_qualifying_faces", rpcArgs);
  if (error) throw new Error(`clusterPeople get_qualifying_faces: ${error.message}`);

  interface FaceRow { asset_id: string; face_id: string; face: any }
  const qualifying: FaceRow[] = (faceRows ?? []).filter((r: any) => r.face_id && r.asset_id);

  if (qualifying.length === 0) {
    return { user_id: uid, people: 0, clustered: 0, reason: "no_qualifying_faces" };
  }

  const collectionId = collectionIdForUser(uid);

  // ── 2. Load existing people (one row per unique person) ─────────────────────
  // Each row owns a set of Rekognition FaceIds in `face_ids` plus a cover face.
  interface PersonRow { id: string; display_name: string | null; face_ids: string[] }
  const { data: existingPeople } = await sb
    .from("people")
    .select("id, display_name, face_ids")
    .eq("user_id", uid);

  const people: PersonRow[] = (existingPeople ?? []).map((p: any) => ({
    id: p.id,
    display_name: p.display_name ?? null,
    face_ids: Array.isArray(p.face_ids) ? p.face_ids : [],
  }));

  // faceId → personId index for O(1) "already-known-face" lookups.
  const faceIdToPersonId = new Map<string, string>();
  for (const p of people) for (const fid of p.face_ids) faceIdToPersonId.set(fid, p.id);

  // For auto-naming new persons.
  let maxPersonN = 0;
  for (const p of people) {
    const m = String(p.display_name ?? "").match(/^Person (\d+)$/);
    if (m) maxPersonN = Math.max(maxPersonN, Number(m[1]));
  }

  // ── 3. Assign each detection to a person ────────────────────────────────────
  let createdCount  = 0;
  let linkedCount   = 0;
  let skippedCount  = 0;

  for (const row of qualifying) {
    const faceId  = row.face_id;
    const faceJson = row.face; // Rekognition attributes, no FaceCrop
    const assetId = row.asset_id;

    // 3a. Already known? Just ensure the asset_faces row points to that person.
    let personId: string | null = faceIdToPersonId.get(faceId) ?? null;

    // 3b. Search Rekognition for a similar face that some person already owns.
    if (!personId) {
      try {
        const matches = await searchFaces({
          collectionId,
          faceId,
          faceMatchThreshold: SIMILARITY_THRESHOLD,
          maxFaces: 20,
        });
        // Highest similarity first; first match that maps to a known person wins.
        const sorted = matches
          .filter((m) => m.faceId && m.faceId !== faceId)
          .sort((a, b) => b.similarity - a.similarity);
        for (const m of sorted) {
          const pid = faceIdToPersonId.get(m.faceId);
          if (pid) { personId = pid; break; }
        }
        if (personId) {
          // Append this faceId to the matched person's face_ids set.
          const target = people.find((p) => p.id === personId)!;
          if (!target.face_ids.includes(faceId)) {
            target.face_ids.push(faceId);
            const { error: upErr } = await sb.from("people")
              .update({ face_ids: target.face_ids, updated_at: new Date().toISOString() })
              .eq("id", personId);
            if (upErr) console.warn("clusterPeople: append face_ids failed", personId, upErr.message);
          }
          faceIdToPersonId.set(faceId, personId);
          linkedCount++;
        }
      } catch (e: any) {
        console.warn("clusterPeople: SearchFaces failed", faceId, String(e?.message ?? e));
      }
    } else {
      linkedCount++;
    }

    // 3c. No match → create a new person, this detection becomes the cover.
    if (!personId) {
      maxPersonN++;
      const displayName = `Person ${maxPersonN}`;
      const { data: inserted, error: insErr } = await sb.from("people")
        .insert({
          user_id: uid,
          asset_id: assetId,
          display_name: displayName,
          face: faceJson,
          face_ids: [faceId],
        })
        .select("id")
        .single();
      if (insErr || !inserted) {
        console.warn("clusterPeople: insert person failed", faceId, insErr?.message);
        skippedCount++;
        continue;
      }
      personId = inserted.id;
      people.push({ id: personId, display_name: displayName, face_ids: [faceId] });
      faceIdToPersonId.set(faceId, personId);
      createdCount++;
    }

    // 3d. Link the detection row in asset_faces to its person.
    const { error: linkErr } = await sb.from("asset_faces")
      .update({ person_id: personId, updated_at: new Date().toISOString() })
      .eq("user_id", uid)
      .eq("asset_id", assetId)
      .eq("face->>FaceId", faceId);
    if (linkErr) console.warn("clusterPeople: link asset_faces failed", faceId, linkErr.message);
  }

  return {
    user_id:         uid,
    faces_processed: qualifying.length,
    people_created:  createdCount,
    detections_linked: linkedCount,
    skipped:         skippedCount,
  };
}
