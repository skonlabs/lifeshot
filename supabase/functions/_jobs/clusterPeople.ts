// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { searchFaces, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";
import { isUsableIndexedFace } from "../_ai/face-quality.ts";
import { checkFaceResetGuard } from "./faceResetGuard.ts";

// Faces must exceed this Rekognition similarity to be merged into the same person.
// 70% is the right balance for a family photo album: same person across different
// years, lighting, and expressions commonly scores 70-85% in Rekognition.
// 80%+ is too strict and splits one real person into many entries.
const SIMILARITY_THRESHOLD = 70;
// Duplicate-person cleanup must be conservative. Lower thresholds can collapse
// relatives/lookalikes into one row and make the People page appear to lose
// most faces after a force sync.
const MERGE_SIMILARITY_THRESHOLD = 85;
// SearchFaces returns only the top N matches. Some people already have many
// linked detections, so MaxFaces=10 can be exhausted by faces that are already
// in the same person row and never expose an equally strong match in another
// duplicate row. Ask for the service maximum so the merge pass can see splits.
const SEARCH_MAX_FACES = 4096;

function faceQualityRank(face: any): number {
  const confidence = Number(face?.Confidence ?? 0);
  const yaw        = Math.abs(Number(face?.FaceDetail?.Pose?.Yaw ?? 180));
  const pitch      = Math.abs(Number(face?.FaceDetail?.Pose?.Pitch ?? 180));
  const sharpness  = Number(face?.FaceDetail?.Quality?.Sharpness ?? 0);
  const brightness = Number(face?.FaceDetail?.Quality?.Brightness ?? 0);
  return confidence * 1000 + sharpness * 10 + brightness - yaw * 4 - pitch * 3;
}

function uniqueFaceIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

async function isLeaderClusterJob(sb: any, userId: string, jobId: string): Promise<boolean> {
  const { data, error } = await sb
    .from("job_queue")
    .select("id, started_at, locked_at, created_at")
    .eq("job_name", "clusterPeople")
    .eq("user_id", userId)
    .eq("status", "running");
  if (error) {
    console.warn("clusterPeople: running-job lookup failed", userId, error.message);
    return true;
  }
  const sorted = [...(data ?? [])].sort((a: any, b: any) => {
    const aKey = String(a.started_at ?? a.locked_at ?? a.created_at ?? "");
    const bKey = String(b.started_at ?? b.locked_at ?? b.created_at ?? "");
    return aKey !== bKey ? aKey.localeCompare(bKey) : String(a.id).localeCompare(String(b.id));
  });
  return !sorted[0] || sorted[0].id === jobId;
}

export async function clusterPeople(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, asset_id } = ctx.payload as { user_id?: string; asset_id?: string };
  const uid = user_id ?? ctx.userId;
  if (!uid) throw new Error("invalid: user_id");

  const { data: privacy } = await sb
    .from("privacy_settings")
    .select("face_processing_enabled, face_pipeline_reset_at")
    .eq("user_id", uid)
    .maybeSingle();
  if (!privacy?.face_processing_enabled) {
    return { user_id: uid, skipped: "consent", clustered: 0 };
  }

  const initialGuard = await checkFaceResetGuard(sb, {
    userId: uid,
    jobId: ctx.jobId,
    resetAt: privacy?.face_pipeline_reset_at ?? null,
  });
  if (!initialGuard.valid) {
    return { user_id: uid, skipped: initialGuard.reason, clustered: 0 };
  }

  if (!rekognitionConfigured()) {
    return { user_id: uid, skipped: "rekognition_not_configured", clustered: 0 };
  }

  const isLeader = await isLeaderClusterJob(sb, uid, ctx.jobId);
  if (!isLeader) {
    return { user_id: uid, skipped: "cluster_already_running", clustered: 0 };
  }

  // ── 1. Load detected faces from asset_faces ─────────────────────────────────
  // Every Rekognition-indexed face should be linked to a person. The stricter
  // quality gate is used later only to prefer better cover photos; using it as
  // an admission gate caused valid but small/blurry/side-lit faces to disappear
  // from the People page after force syncs.
  const { data: allAssetFaces, error: afErr } = await sb
    .from("asset_faces")
    .select("id, asset_id, person_id, face")
    .eq("user_id", uid)
    .limit(50000); // PostgREST default is 1000 — must override or faces are silently truncated
  if (afErr) throw new Error(`clusterPeople: asset_faces load failed: ${afErr.message}`);

  interface AssetFaceRow { id: string; asset_id: string; person_id: string | null; face: any }
  const assetFaceRows: AssetFaceRow[] = allAssetFaces ?? [];

  const detectedRows = assetFaceRows
    .filter((r) => r.face?.FaceId && r.asset_id)
    .sort((a, b) => faceQualityRank(b.face) - faceQualityRank(a.face)); // best quality first

  if (detectedRows.length === 0) {
    return { user_id: uid, people: 0, clustered: 0, reason: "no_detected_faces" };
  }

  // ── 2. Load existing people and build complete faceId → personId index ────────
  // We index ALL face_ids from ALL people rows — not just those with currently
  // linked asset_faces — so we never create duplicates for already-known faces.
  const { data: existingPeople, error: peopleErr } = await sb
    .from("people")
    .select("id, display_name, asset_id, face, face_ids")
    .eq("user_id", uid)
    .limit(10000); // PostgREST default is 1000 — must override or people are silently truncated
  if (peopleErr) throw new Error(`clusterPeople: people load failed: ${peopleErr.message}`);

  interface PersonEntry { id: string; display_name: string | null; face_ids: string[]; face: any; asset_id: string | null }
  const peopleById = new Map<string, PersonEntry>();
  // faceId → personId: populated from EVERY face_id in EVERY person row.
  const faceIdToPersonId = new Map<string, string>();

  for (const p of existingPeople ?? []) {
    const faceIds = uniqueFaceIds([
      ...(Array.isArray(p.face_ids) ? p.face_ids : []),
      ...(p.face?.FaceId ? [p.face.FaceId] : []),
    ]);
    const entry: PersonEntry = {
      id: p.id,
      display_name: p.display_name ?? null,
      face_ids: faceIds,
      face: p.face,
      asset_id: p.asset_id,
    };
    peopleById.set(p.id, entry);
    for (const fid of faceIds) faceIdToPersonId.set(fid, p.id);
  }

  let maxPersonN = 0;
  for (const p of existingPeople ?? []) {
    const m = String(p.display_name ?? "").match(/^Person (\d+)$/);
    if (m) maxPersonN = Math.max(maxPersonN, Number(m[1]));
  }

  const collectionId = collectionIdForUser(uid);
  const now = new Date().toISOString();

  let created = 0;
  let linked = 0;
  let skipped = 0;

  // ── 3. Process each detected face ───────────────────────────────────────────
  // Rule: for each detected face —
  //   a) Already has a known person → just ensure asset_faces.person_id is set.
  //   b) SearchFaces (similarity >= 90%) → if any match is a known person, add
  //      this face to that person (update face_ids + cover if better quality).
  //   c) No match → create a new person row.
  //
  // Processing best-quality faces first means the highest-quality face wins
  // as the initial cover for a new person, and subsequent lower-quality matches
  // are simply linked without displacing the cover.

  // Check reset guard once before the loop — O(n) per-face DB calls caused
  // timeouts on accounts with thousands of detected faces.
  // Also re-check every 50 faces so a reset triggered mid-run is detected
  // within one batch rather than after the full loop completes.
  const preLoopGuard = await checkFaceResetGuard(sb, { userId: uid, jobId: ctx.jobId, resetAt: privacy?.face_pipeline_reset_at ?? null });
  if (!preLoopGuard.valid) {
    return { user_id: uid, faces_processed: 0, people_created: 0, detections_linked: 0, skipped: detectedRows.length, stopped: preLoopGuard.reason };
  }

  for (let faceIdx = 0; faceIdx < detectedRows.length; faceIdx++) {
    const row = detectedRows[faceIdx];

    // Re-check reset guard every 50 faces to catch mid-run resets without
    // incurring a DB round-trip on every iteration.
    if (faceIdx > 0 && faceIdx % 50 === 0) {
      const midGuard = await checkFaceResetGuard(sb, { userId: uid, jobId: ctx.jobId, resetAt: privacy?.face_pipeline_reset_at ?? null });
      if (!midGuard.valid) {
        return { user_id: uid, faces_processed: faceIdx, people_created: created, detections_linked: linked, skipped, stopped: midGuard.reason };
      }
    }

    const faceId = row.face.FaceId as string;

    // (a) Already assigned to a person.
    let personId = faceIdToPersonId.get(faceId) ?? null;

    if (!personId) {
      // (b) Search Rekognition collection for similar faces.
      // We match against ALL face IDs in the collection, not just qualifying ones.
      // This catches faces from previous pipeline runs that are still in the
      // collection but may have been re-detected with different quality scores.
      try {
        const matches = await searchFaces({
          collectionId,
          faceId,
          faceMatchThreshold: SIMILARITY_THRESHOLD,
          maxFaces: SEARCH_MAX_FACES,
        });
        // Pick the highest-similarity match that maps to a known person.
        const best = matches
          .filter((m) => m.faceId !== faceId && m.similarity >= SIMILARITY_THRESHOLD)
          .sort((a, b) => b.similarity - a.similarity)
          .find((m) => faceIdToPersonId.has(m.faceId));
        if (best) personId = faceIdToPersonId.get(best.faceId)!;
      } catch (e: any) {
        console.warn("clusterPeople: SearchFaces failed", faceId, String(e?.message ?? e));
        skipped++;
        continue;
      }
    }

    if (personId) {
      // Add this face to the existing person if not already tracked.
      const person = peopleById.get(personId);
      if (person && !person.face_ids.includes(faceId)) {
        person.face_ids = uniqueFaceIds([...person.face_ids, faceId]);
        faceIdToPersonId.set(faceId, personId);

        // Cover is NOT updated here — the final pass below recomputes each
        // person's cover from the best-quality asset_face currently linked.
        // Doing per-face cover replacement caused force-sync instability: the
        // stored cover FaceId often pointed at an asset_face row whose
        // FaceId had been replaced by a new canonical id on rescan (the
        // Rekognition dedup threshold is 98% — pose/lighting drift past
        // that orphans the old id), so coverRow was null and the cover got
        // replaced with whatever face happened to be processed first.
        const { error: upErr } = await sb
          .from("people")
          .update({ face_ids: person.face_ids, updated_at: now })
          .eq("id", personId);
        if (upErr) {
          console.warn("clusterPeople: people update failed", personId, upErr.message);
          skipped++;
          continue;
        }
      }
    } else {
      // (c) No match — create a new person. This face is the best cover
      //     (we process highest quality first).
      maxPersonN++;
      const { data: inserted, error: insErr } = await sb
        .from("people")
        .insert({
          user_id:      uid,
          asset_id:     row.asset_id,
          display_name: `Person ${maxPersonN}`,
          face:         row.face,
          face_ids:     [faceId],
        })
        .select("id")
        .single();
      if (insErr || !inserted) {
        console.warn("clusterPeople: insert person failed", faceId, insErr?.message);
        skipped++;
        continue;
      }
      personId = inserted.id;
      const newEntry: PersonEntry = {
        id: personId,
        display_name: `Person ${maxPersonN}`,
        face_ids: [faceId],
        face: row.face,
        asset_id: row.asset_id,
      };
      peopleById.set(personId, newEntry);
      faceIdToPersonId.set(faceId, personId);
      created++;
    }

    // Link asset_faces row to person (if not already set).
    if (personId && row.person_id !== personId) {
      const { error: linkErr } = await sb
        .from("asset_faces")
        .update({ person_id: personId, updated_at: now })
        .eq("id", row.id);
      if (linkErr) {
        console.warn("clusterPeople: asset_faces link failed", row.id, linkErr.message);
      } else {
        row.person_id = personId;
        linked++;
      }
    }
  }

  // ── 4. Merge duplicate people (same physical person split across two rows) ────
  // Two person rows can exist for the same physical person when concurrent
  // clusterPeople runs both created a "new person" for the same face before
  // either run had written the other's person_id to faceIdToPersonId.
  // Strategy: for each person, SearchFaces for their representative face. If the
  // result points to a DIFFERENT person in peopleById, merge the lower-quality
  // person into the higher-quality one (copy face_ids, delete the loser).
  const mergedPersonIds = new Set<string>(); // already absorbed — skip as source
  for (const [pid, person] of peopleById) {
    if (mergedPersonIds.has(pid) || !person.face?.FaceId) continue;
    let matches: Array<{ faceId: string; similarity: number }> = [];
    try {
      matches = await searchFaces({
        collectionId,
        faceId: person.face.FaceId as string,
        faceMatchThreshold: MERGE_SIMILARITY_THRESHOLD,
        maxFaces: SEARCH_MAX_FACES,
      });
    } catch { continue; }
    for (const m of matches) {
      if (!peopleById.has(pid)) break; // this source person was absorbed by an earlier match
      if (m.faceId === person.face.FaceId || m.similarity < MERGE_SIMILARITY_THRESHOLD) continue;
      const otherPersonId = faceIdToPersonId.get(m.faceId);
      if (!otherPersonId || otherPersonId === pid || mergedPersonIds.has(otherPersonId)) continue;
      const other = peopleById.get(otherPersonId);
      if (!other) continue;
      // Keep the higher-quality person as winner; absorb the other.
      const keepId   = faceQualityRank(person.face) >= faceQualityRank(other.face) ? pid : otherPersonId;
      const dropId   = keepId === pid ? otherPersonId : pid;
      const keepPerson = peopleById.get(keepId)!;
      const dropPerson = peopleById.get(dropId)!;
      if (!keepPerson || !dropPerson) continue;
      const merged = uniqueFaceIds([...keepPerson.face_ids, ...dropPerson.face_ids]);
      keepPerson.face_ids = merged;
      for (const fid of merged) faceIdToPersonId.set(fid, keepId);
      await sb.from("people").update({ face_ids: merged, updated_at: now }).eq("id", keepId);
      await sb.from("asset_faces").update({ person_id: keepId, updated_at: now }).eq("person_id", dropId).eq("user_id", uid);
      for (const row of assetFaceRows) {
        if (row.person_id === dropId) row.person_id = keepId;
      }
      await sb.from("people").delete().eq("id", dropId);
      mergedPersonIds.add(dropId);
      peopleById.delete(dropId);
      if (dropId === pid) break;
    }
  }

  // ── 6. Delete people rows with no linked detections (orphans) ────────────────
  const linkedPersonIds = new Set(
    assetFaceRows
      .filter((r) => r.person_id)
      .map((r) => r.person_id as string),
  );
  const orphanIds = Array.from(peopleById.keys()).filter((id) => !linkedPersonIds.has(id));
  if (orphanIds.length) {
    await sb.from("people").delete().in("id", orphanIds);
    for (const id of orphanIds) peopleById.delete(id);
  }

  // ── 8. Deterministic cover pass ─────────────────────────────────────────────
  // For every surviving person, pick the cover as the single highest-quality
  // asset_face currently linked to that person AND passing the usability gate.
  // This makes covers stable across force syncs: regardless of processing order
  // or whether canonical FaceIds shifted on rescan, the chosen cover is always
  // the best face we actually have for the person right now.
  const bestByPerson = new Map<string, AssetFaceRow>();
  for (const r of assetFaceRows) {
    if (!r.person_id || !peopleById.has(r.person_id)) continue;
    if (!isUsableIndexedFace(r.face)) continue;
    const current = bestByPerson.get(r.person_id);
    if (!current || faceQualityRank(r.face) > faceQualityRank(current.face)) {
      bestByPerson.set(r.person_id, r);
    }
  }
  let covers_updated = 0;
  for (const [pid, best] of bestByPerson) {
    const person = peopleById.get(pid);
    if (!person) continue;
    const currentCoverFaceId = person.face?.FaceId ?? null;
    const bestFaceId = best.face?.FaceId ?? null;
    if (currentCoverFaceId === bestFaceId && person.asset_id === best.asset_id) continue;
    const { error: coverErr } = await sb
      .from("people")
      .update({ face: best.face, asset_id: best.asset_id, updated_at: now })
      .eq("id", pid);
    if (coverErr) {
      console.warn("clusterPeople: cover update failed", pid, coverErr.message);
      continue;
    }
    person.face = best.face;
    person.asset_id = best.asset_id;
    covers_updated++;
  }

  return {
    user_id:            uid,
    trigger_asset_id:   asset_id ?? null,
    faces_processed:    detectedRows.length,
    people_created:     created,
    detections_linked:  linked,
    skipped,
    duplicates_merged:  mergedPersonIds.size,
    orphans_removed:    orphanIds.length,
    covers_updated,
  };
}
