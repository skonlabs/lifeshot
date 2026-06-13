// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { searchFaces, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";

// SearchFaces similarity threshold for linking a new detection to an existing
// person. The user asked for >0.50 confidence.
const SIMILARITY_THRESHOLD = 50;

const SEARCH_PAGE_SIZE = 4096;

function uniqueFaceIds(faceIds: string[]): string[] {
  return Array.from(new Set(faceIds.filter(Boolean)));
}

function faceIdFromFace(face: any): string | null {
  const faceId = face?.FaceId;
  return typeof faceId === "string" && faceId ? faceId : null;
}

function compareJobStart(a: any, b: any): number {
  const aKey = String(a.started_at ?? a.locked_at ?? a.created_at ?? "");
  const bKey = String(b.started_at ?? b.locked_at ?? b.created_at ?? "");
  if (aKey !== bKey) return aKey.localeCompare(bKey);
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

async function isLeaderClusterJob(sb: any, userId: string, jobId: string): Promise<boolean> {
  const { data, error } = await sb.from("job_queue")
    .select("id, started_at, locked_at, created_at")
    .eq("job_name", "clusterPeople")
    .eq("user_id", userId)
    .eq("status", "running");
  if (error) {
    console.warn("clusterPeople: running-job lookup failed", userId, error.message);
    return true;
  }
  const leader = [...(data ?? [])].sort(compareJobStart)[0];
  return !leader || leader.id === jobId;
}

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

  const isLeader = await isLeaderClusterJob(sb, uid, ctx.jobId);
  if (!isLeader) {
    return { user_id: uid, skipped: "cluster_already_running", clustered: 0 };
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
  interface PersonRow {
    id: string;
    display_name: string | null;
    face_ids: string[];
    cover_face_id: string | null;
  }
  const { data: existingPeople } = await sb
    .from("people")
    .select("id, display_name, face_ids, face")
    .eq("user_id", uid);

  const people: PersonRow[] = (existingPeople ?? []).map((p: any) => ({
    id: p.id,
    display_name: p.display_name ?? null,
    cover_face_id: faceIdFromFace(p.face),
    face_ids: uniqueFaceIds([
      ...(Array.isArray(p.face_ids) ? p.face_ids : []),
      faceIdFromFace(p.face) ?? "",
    ]),
  }));

  const { data: existingLinks } = await sb
    .from("asset_faces")
    .select("person_id, face")
    .eq("user_id", uid)
    .not("person_id", "is", null);

  // faceId → personId index for O(1) "already-known-face" lookups.
  const faceIdToPersonId = new Map<string, string>();
  for (const p of people) for (const fid of p.face_ids) faceIdToPersonId.set(fid, p.id);
  for (const row of existingLinks ?? []) {
    const pid = row.person_id as string | null;
    const fid = row.face?.FaceId as string | undefined;
    if (pid && fid) faceIdToPersonId.set(fid, pid);
  }

  // For auto-naming new persons.
  let maxPersonN = 0;
  for (const p of people) {
    const m = String(p.display_name ?? "").match(/^Person (\d+)$/);
    if (m) maxPersonN = Math.max(maxPersonN, Number(m[1]));
  }

  const peopleById = new Map<string, PersonRow>(people.map((p) => [p.id, p]));
  const personFaceIds = uniqueFaceIds(people.flatMap((p) => p.face_ids));
  const searchMaxFaces = Math.max(SEARCH_PAGE_SIZE, personFaceIds.length + qualifying.length + 32);

  const mergePeople = async (survivorId: string, duplicateIds: string[]): Promise<PersonRow | null> => {
    const survivor = peopleById.get(survivorId);
    const dedupedIds = Array.from(new Set(duplicateIds.filter((id) => id && id !== survivorId && peopleById.has(id))));
    if (!survivor) return null;
    if (!dedupedIds.length) return survivor;

    const mergedFaceIds = uniqueFaceIds([
      ...survivor.face_ids,
      ...dedupedIds.flatMap((id) => peopleById.get(id)?.face_ids ?? []),
      survivor.cover_face_id ?? "",
    ]);

    const now = new Date().toISOString();
    const { error: peopleErr } = await sb.from("people")
      .update({ face_ids: mergedFaceIds, updated_at: now })
      .eq("id", survivorId);
    if (peopleErr) {
      console.warn("clusterPeople: merge people update failed", survivorId, peopleErr.message);
      return null;
    }

    const { error: relinkErr } = await sb.from("asset_faces")
      .update({ person_id: survivorId, updated_at: now })
      .in("person_id", dedupedIds);
    if (relinkErr) {
      console.warn("clusterPeople: merge asset_faces relink failed", survivorId, relinkErr.message);
      return null;
    }

    const { error: eventRelinkErr } = await sb.from("event_people")
      .update({ person_id: survivorId })
      .in("person_id", dedupedIds);
    if (eventRelinkErr) {
      console.warn("clusterPeople: merge event_people relink failed", survivorId, eventRelinkErr.message);
    }

    const { error: deleteErr } = await sb.from("people")
      .delete()
      .in("id", dedupedIds);
    if (deleteErr) {
      console.warn("clusterPeople: delete merged duplicate people failed", survivorId, deleteErr.message);
      return null;
    }

    survivor.face_ids = mergedFaceIds;
    for (const fid of mergedFaceIds) faceIdToPersonId.set(fid, survivorId);
    for (const duplicateId of dedupedIds) {
      const duplicate = peopleById.get(duplicateId);
      for (const fid of duplicate?.face_ids ?? []) faceIdToPersonId.set(fid, survivorId);
      peopleById.delete(duplicateId);
    }

    return survivor;
  };

  const ensurePersonOwnsFaceId = async (personId: string, faceId: string): Promise<PersonRow | null> => {
    const target = peopleById.get(personId);
    if (!target) return null;
    const nextFaceIds = uniqueFaceIds([
      ...target.face_ids,
      faceId,
      target.cover_face_id ?? "",
    ]);
    for (const fid of nextFaceIds) faceIdToPersonId.set(fid, personId);
    if (nextFaceIds.length === target.face_ids.length) return target;
    target.face_ids = nextFaceIds;
    const { error: upErr } = await sb.from("people")
      .update({ face_ids: nextFaceIds, updated_at: new Date().toISOString() })
      .eq("id", personId);
    if (upErr) {
      console.warn("clusterPeople: append face_ids failed", personId, upErr.message);
    }
    return target;
  };

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
          maxFaces: searchMaxFaces,
        });
        // Highest similarity first; first match that maps to a known person wins.
        const sorted = matches
          .filter((m) => m.faceId && m.faceId !== faceId)
          .sort((a, b) => b.similarity - a.similarity);
        const matchedPersonIds: string[] = [];
        for (const m of sorted) {
          const pid = faceIdToPersonId.get(m.faceId);
          if (!pid) continue;
          matchedPersonIds.push(pid);
          if (!personId) personId = pid;
        }
        if (personId && matchedPersonIds.length > 1) {
          const merged = await mergePeople(personId, matchedPersonIds);
          if (!merged) {
            skippedCount++;
            continue;
          }
        }
        if (personId) {
          const target = await ensurePersonOwnsFaceId(personId, faceId);
          if (!target) {
            skippedCount++;
            continue;
          }
          faceIdToPersonId.set(faceId, personId);
          linkedCount++;
        }
      } catch (e: any) {
        console.warn("clusterPeople: SearchFaces failed", faceId, String(e?.message ?? e));
      }
    } else {
      await ensurePersonOwnsFaceId(personId, faceId);
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
      const created = { id: personId, display_name: displayName, face_ids: [faceId], cover_face_id: faceId };
      people.push(created);
      peopleById.set(personId, created);
      faceIdToPersonId.set(faceId, personId);
      createdCount++;
    }

    // 3d. Link the detection row in asset_faces to its person.
    // jsonb-operator filters via PostgREST are brittle; fetch candidates and
    // match the FaceId in-process. An asset has at most a handful of faces.
    const { data: candidateRows } = await sb.from("asset_faces")
      .select("id, face")
      .eq("user_id", uid)
      .eq("asset_id", assetId);
    const targetId = (candidateRows ?? []).find((r: any) => r.face?.FaceId === faceId)?.id;
    if (targetId) {
      const { error: linkErr } = await sb.from("asset_faces")
        .update({ person_id: personId, updated_at: new Date().toISOString() })
        .eq("id", targetId);
      if (linkErr) console.warn("clusterPeople: link asset_faces failed", faceId, linkErr.message);
    }
  }

  return {
    user_id:         uid,
    faces_processed: qualifying.length,
    people_created:  createdCount,
    detections_linked: linkedCount,
    skipped:         skippedCount,
  };
}
