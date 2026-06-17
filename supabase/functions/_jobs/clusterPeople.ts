// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { searchFaces, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";
import { isUsableIndexedFace } from "../_ai/face-quality.ts";
import { checkFaceResetGuard } from "./faceResetGuard.ts";

// Faces must exceed this Rekognition similarity to be merged into the same person.
const SIMILARITY_THRESHOLD = 90;

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

  // ── 1. Load qualifying faces from asset_faces ────────────────────────────────
  // Admission gate (applied in code so the same quality logic is always used):
  //   • Confidence >= 90%
  //   • EyesOpen.Value = true, EyesOpen.Confidence >= 90
  //   • FaceOccluded.Value = false, FaceOccluded.Confidence >= 90
  //   • |Yaw| <= 30°, |Pitch| <= 25°
  //   • Sharpness >= 35, Brightness >= 25
  const { data: allAssetFaces, error: afErr } = await sb
    .from("asset_faces")
    .select("id, asset_id, person_id, face")
    .eq("user_id", uid)
    .limit(50000); // PostgREST default is 1000 — must override or faces are silently truncated
  if (afErr) throw new Error(`clusterPeople: asset_faces load failed: ${afErr.message}`);

  interface AssetFaceRow { id: string; asset_id: string; person_id: string | null; face: any }
  const assetFaceRows: AssetFaceRow[] = allAssetFaces ?? [];

  const qualifying = assetFaceRows
    .filter((r) => r.face?.FaceId && r.asset_id && isUsableIndexedFace(r.face))
    .sort((a, b) => faceQualityRank(b.face) - faceQualityRank(a.face)); // best quality first

  if (qualifying.length === 0) {
    return { user_id: uid, people: 0, clustered: 0, reason: "no_qualifying_faces" };
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

  // ── 3. Process each qualifying face ─────────────────────────────────────────
  // Rule: for each qualifying face —
  //   a) Already has a known person → just ensure asset_faces.person_id is set.
  //   b) SearchFaces (similarity >= 90%) → if any match is a known person, add
  //      this face to that person (update face_ids + cover if better quality).
  //   c) No match → create a new person row.
  //
  // Processing best-quality faces first means the highest-quality face wins
  // as the initial cover for a new person, and subsequent lower-quality matches
  // are simply linked without displacing the cover.

  // Check reset guard once before the loop — O(n) per-face DB calls caused
  // timeouts on accounts with thousands of qualifying faces.
  // Also re-check every 50 faces so a reset triggered mid-run is detected
  // within one batch rather than after the full loop completes.
  const preLoopGuard = await checkFaceResetGuard(sb, { userId: uid, jobId: ctx.jobId, resetAt: privacy?.face_pipeline_reset_at ?? null });
  if (!preLoopGuard.valid) {
    return { user_id: uid, faces_processed: 0, people_created: 0, detections_linked: 0, skipped: qualifying.length, stopped: preLoopGuard.reason };
  }

  for (let faceIdx = 0; faceIdx < qualifying.length; faceIdx++) {
    const row = qualifying[faceIdx];

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
          maxFaces: 10,
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

        // Replace cover only if this face has better quality.
        const coverFaceId = person.face?.FaceId ?? null;
        const coverRow = coverFaceId
          ? assetFaceRows.find((r) => r.face?.FaceId === coverFaceId)
          : null;
        const useBetterCover =
          !coverFaceId ||
          !coverRow ||
          faceQualityRank(row.face) > faceQualityRank(coverRow.face);

        const updatePayload: Record<string, unknown> = {
          face_ids: person.face_ids,
          updated_at: now,
        };
        if (useBetterCover) {
          updatePayload.face    = row.face;
          updatePayload.asset_id = row.asset_id;
          person.face    = row.face;
          person.asset_id = row.asset_id;
        }

        const { error: upErr } = await sb
          .from("people")
          .update(updatePayload)
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

  // ── 4. Unlink asset_faces that no longer pass the quality gate ───────────────
  const disqualifiedRows = assetFaceRows.filter(
    (r) => r.person_id && !isUsableIndexedFace(r.face),
  );
  if (disqualifiedRows.length) {
    const ids = disqualifiedRows.map((r) => r.id).filter(Boolean);
    await sb.from("asset_faces").update({ person_id: null, updated_at: now }).in("id", ids);
  }

  // ── 5. Delete people rows with no qualifying linked faces (orphans) ───────────
  const linkedPersonIds = new Set(
    assetFaceRows
      .filter((r) => r.person_id && isUsableIndexedFace(r.face))
      .map((r) => r.person_id as string),
  );
  const orphanIds = Array.from(peopleById.keys()).filter((id) => !linkedPersonIds.has(id));
  if (orphanIds.length) {
    await sb.from("people").delete().in("id", orphanIds);
  }

  return {
    user_id:            uid,
    trigger_asset_id:   asset_id ?? null,
    faces_processed:    qualifying.length,
    people_created:     created,
    detections_linked:  linked,
    skipped,
    orphans_removed:    orphanIds.length,
  };
}
