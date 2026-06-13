// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { searchFaces, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";
import { isUsableIndexedFace } from "../_ai/face-quality.ts";
import { checkFaceResetGuard } from "./faceResetGuard.ts";

// Similarity threshold (percent) passed directly to Rekognition SearchFaces.
// Rekognition itself decides whether two faces belong to the same person —
// we do NOT filter or re-compare on our side.
const SIMILARITY_THRESHOLD = 80;

const SEARCH_PAGE_SIZE = 4096;

type FaceRecord = {
  asset_id: string;
  face_id: string;
  face: any;
  asset_face_row_id: string | null;
};

type PersonRow = {
  id: string;
  display_name: string | null;
  face_ids: string[];
  cover_face_id: string | null;
};

function isAutoPersonName(value: string | null | undefined): boolean {
  return /^Person \d+$/.test(String(value ?? "").trim());
}

function faceQualityRank(face: any): number {
  const confidence = Number(face?.Confidence ?? 0);
  const yaw = Math.abs(Number(face?.FaceDetail?.Pose?.Yaw ?? 180));
  const pitch = Math.abs(Number(face?.FaceDetail?.Pose?.Pitch ?? 180));
  const sharpness = Number(face?.FaceDetail?.Quality?.Sharpness ?? 0);
  const brightness = Number(face?.FaceDetail?.Quality?.Brightness ?? 0);
  return confidence * 1000 + sharpness * 10 + brightness - yaw * 4 - pitch * 3;
}

function pickSurvivorPersonId(persons: PersonRow[]): string | null {
  const ordered = [...persons].sort((a, b) => {
    const aCustom = isAutoPersonName(a.display_name) ? 0 : 1;
    const bCustom = isAutoPersonName(b.display_name) ? 0 : 1;
    if (aCustom !== bCustom) return bCustom - aCustom;
    if (a.face_ids.length !== b.face_ids.length) return b.face_ids.length - a.face_ids.length;
    return String(a.id).localeCompare(String(b.id));
  });
  return ordered[0]?.id ?? null;
}

class UnionFind {
  private parent = new Map<string, string>();

  add(value: string) {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    const current = this.parent.get(value) ?? value;
    if (current === value) {
      this.parent.set(value, value);
      return value;
    }
    const root = this.find(current);
    this.parent.set(value, root);
    return root;
  }

  union(a: string, b: string) {
    this.add(a);
    this.add(b);
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

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
    .select("face_processing_enabled, face_pipeline_reset_at")
    .eq("user_id", uid)
    .maybeSingle();
  if (!privacy?.face_processing_enabled) {
    return { user_id: uid, skipped: "consent", clustered: 0 };
  }

  const initialResetGuard = await checkFaceResetGuard(sb, {
    userId: uid,
    jobId: ctx.jobId,
    resetAt: privacy?.face_pipeline_reset_at ?? null,
  });
  if (!initialResetGuard.valid) {
    return { user_id: uid, skipped: initialResetGuard.reason, clustered: 0 };
  }

  if (!rekognitionConfigured()) {
    return { user_id: uid, skipped: "rekognition_not_configured", clustered: 0 };
  }

  const isLeader = await isLeaderClusterJob(sb, uid, ctx.jobId);
  if (!isLeader) {
    return { user_id: uid, skipped: "cluster_already_running", clustered: 0 };
  }

  // ── 1. Load qualifying faces across the whole user, not just one asset. ────
  // Asset-scoped clustering can only assign the newest detections; it cannot
  // reliably repair already-split people rows created by older runs because
  // the bridged faces may live on different assets. Every clusterPeople run is
  // therefore a full per-user reconciliation pass.
  const { data: faceRows, error } = await sb.rpc("get_qualifying_faces", { p_user_id: uid });
  if (error) throw new Error(`clusterPeople get_qualifying_faces: ${error.message}`);

  const qualifying: FaceRecord[] = (faceRows ?? [])
    .filter((r: any) => r.face_id && r.asset_id && isUsableIndexedFace(r.face))
    .sort((a: any, b: any) => {
      const assetCmp = String(a.asset_id).localeCompare(String(b.asset_id));
      if (assetCmp !== 0) return assetCmp;
      return String(a.face_id).localeCompare(String(b.face_id));
    });

  if (qualifying.length === 0) {
    return { user_id: uid, people: 0, clustered: 0, reason: "no_qualifying_faces" };
  }

  const collectionId = collectionIdForUser(uid);

  // ── 2. Load existing people (one row per unique person) ─────────────────────
  // Each row owns a set of Rekognition FaceIds in `face_ids` plus a cover face.
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

  const { data: allAssetFaces } = await sb
    .from("asset_faces")
    .select("id, asset_id, person_id, face")
    .eq("user_id", uid);

  const assetFaceRows = allAssetFaces ?? [];
  const assetFaceByFaceId = new Map<string, any>();
  for (const row of assetFaceRows) {
    const fid = row?.face?.FaceId;
    if (typeof fid === "string" && fid && !assetFaceByFaceId.has(fid)) assetFaceByFaceId.set(fid, row);
  }
  for (const row of qualifying) {
    const existing = assetFaceByFaceId.get(row.face_id);
    row.asset_face_row_id = existing?.id ?? null;
  }
  const existingLinks = assetFaceRows.filter((row: any) => row.person_id);

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

  const mergePeople = async (
    survivorId: string,
    duplicateIds: string[],
  ): Promise<PersonRow | null> => {
    const survivor = peopleById.get(survivorId);
    const dedupedIds = Array.from(
      new Set(duplicateIds.filter((id) => id && id !== survivorId && peopleById.has(id))),
    );
    if (!survivor) return null;
    if (!dedupedIds.length) return survivor;

    const mergedFaceIds = uniqueFaceIds([
      ...survivor.face_ids,
      ...dedupedIds.flatMap((id) => peopleById.get(id)?.face_ids ?? []),
      survivor.cover_face_id ?? "",
    ]);

    const now = new Date().toISOString();
    const { error: peopleErr } = await sb
      .from("people")
      .update({ face_ids: mergedFaceIds, updated_at: now })
      .eq("id", survivorId);
    if (peopleErr) {
      console.warn("clusterPeople: merge people update failed", survivorId, peopleErr.message);
      return null;
    }

    const { error: relinkErr } = await sb
      .from("asset_faces")
      .update({ person_id: survivorId, updated_at: now })
      .in("person_id", dedupedIds);
    if (relinkErr) {
      console.warn("clusterPeople: merge asset_faces relink failed", survivorId, relinkErr.message);
      return null;
    }

    const { data: duplicateEventLinks, error: eventReadErr } = await sb
      .from("event_people")
      .select("id, event_id")
      .in("person_id", dedupedIds);
    if (eventReadErr) {
      console.warn(
        "clusterPeople: read duplicate event_people links failed",
        survivorId,
        eventReadErr.message,
      );
      return null;
    }

    const eventIds = Array.from(
      new Set((duplicateEventLinks ?? []).map((row: any) => row.event_id).filter(Boolean)),
    );
    if (eventIds.length) {
      const { data: survivorEventLinks, error: survivorEventErr } = await sb
        .from("event_people")
        .select("event_id")
        .eq("person_id", survivorId)
        .in("event_id", eventIds);
      if (survivorEventErr) {
        console.warn(
          "clusterPeople: read survivor event_people links failed",
          survivorId,
          survivorEventErr.message,
        );
        return null;
      }
      const survivorEventIds = new Set((survivorEventLinks ?? []).map((row: any) => row.event_id));
      const missingEventLinks = eventIds
        .filter((eventId) => !survivorEventIds.has(eventId))
        .map((event_id) => ({ event_id, person_id: survivorId }));
      if (missingEventLinks.length) {
        const { error: eventInsertErr } = await sb.from("event_people").insert(missingEventLinks);
        if (eventInsertErr) {
          console.warn(
            "clusterPeople: insert survivor event_people links failed",
            survivorId,
            eventInsertErr.message,
          );
          return null;
        }
      }
      const duplicateEventLinkIds = (duplicateEventLinks ?? [])
        .map((row: any) => row.id)
        .filter(Boolean);
      if (duplicateEventLinkIds.length) {
        const { error: eventDeleteErr } = await sb
          .from("event_people")
          .delete()
          .in("id", duplicateEventLinkIds);
        if (eventDeleteErr) {
          console.warn(
            "clusterPeople: delete duplicate event_people links failed",
            survivorId,
            eventDeleteErr.message,
          );
          return null;
        }
      }
    }

    const { error: deleteErr } = await sb.from("people").delete().in("id", dedupedIds);
    if (deleteErr) {
      console.warn(
        "clusterPeople: delete merged duplicate people failed",
        survivorId,
        deleteErr.message,
      );
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

  // ── 3. Build connected components from Rekognition matches ──────────────────
  let createdCount = 0;
  let linkedCount = 0;
  let skippedCount = 0;
  const uf = new UnionFind();
  const qualifyingFaceIds = new Set(qualifying.map((row) => row.face_id));
  for (const row of qualifying) {
    const rowResetGuard = await checkFaceResetGuard(sb, {
      userId: uid,
      jobId: ctx.jobId,
    });
    if (!rowResetGuard.valid) {
      return {
        user_id: uid,
        faces_processed: qualifying.length,
        people_created: createdCount,
        detections_linked: linkedCount,
        skipped: skippedCount,
        stopped: rowResetGuard.reason,
      };
    }

    uf.add(row.face_id);
    try {
      const matches = await searchFaces({
        collectionId,
        faceId: row.face_id,
        faceMatchThreshold: SIMILARITY_THRESHOLD,
        maxFaces: SEARCH_PAGE_SIZE,
      });
      for (const match of matches) {
        if (!match.faceId || match.faceId === row.face_id) continue;
        if (!qualifyingFaceIds.has(match.faceId)) continue;
        uf.union(row.face_id, match.faceId);
      }
    } catch (e: any) {
      console.warn("clusterPeople: SearchFaces failed", row.face_id, String(e?.message ?? e));
      skippedCount++;
    }
  }

  const componentMap = new Map<string, FaceRecord[]>();
  for (const row of qualifying) {
    const root = uf.find(row.face_id);
    const bucket = componentMap.get(root) ?? [];
    bucket.push(row);
    componentMap.set(root, bucket);
  }

  // ── 4. Materialize one person per component ─────────────────────────────────
  for (const component of componentMap.values()) {
    const rowResetGuard = await checkFaceResetGuard(sb, {
      userId: uid,
      jobId: ctx.jobId,
    });
    if (!rowResetGuard.valid) {
      return {
        user_id: uid,
        faces_processed: qualifying.length,
        people_created: createdCount,
        detections_linked: linkedCount,
        skipped: skippedCount,
        stopped: rowResetGuard.reason,
      };
    }

    const componentFaceIds = uniqueFaceIds(component.map((row) => row.face_id));
    const existingPersonIds = Array.from(new Set(componentFaceIds
      .map((faceId) => faceIdToPersonId.get(faceId))
      .filter(Boolean) as string[]));

    let personId: string | null = null;
    if (existingPersonIds.length) {
      const survivorId = pickSurvivorPersonId(existingPersonIds
        .map((id) => peopleById.get(id))
        .filter(Boolean) as PersonRow[]);
      if (!survivorId) {
        skippedCount += component.length;
        continue;
      }
      personId = survivorId;
      if (existingPersonIds.length > 1) {
        const merged = await mergePeople(survivorId, existingPersonIds);
        if (!merged) {
          skippedCount += component.length;
          continue;
        }
      }
    }

    const bestRow = [...component].sort((a, b) => faceQualityRank(b.face) - faceQualityRank(a.face))[0];
    const now = new Date().toISOString();

    if (!personId) {
      maxPersonN++;
      const displayName = `Person ${maxPersonN}`;
      const { data: inserted, error: insErr } = await sb
        .from("people")
        .insert({
          user_id: uid,
          asset_id: bestRow.asset_id,
          display_name: displayName,
          face: bestRow.face,
          face_ids: componentFaceIds,
        })
        .select("id")
        .single();
      if (insErr || !inserted) {
        console.warn("clusterPeople: insert person failed", bestRow.face_id, insErr?.message);
        skippedCount += component.length;
        continue;
      }
      personId = inserted.id;
      const created = {
        id: personId,
        display_name: displayName,
        face_ids: componentFaceIds,
        cover_face_id: bestRow.face_id,
      };
      people.push(created);
      peopleById.set(personId, created);
      createdCount++;
    } else {
      const target = peopleById.get(personId);
      if (!target) {
        skippedCount += component.length;
        continue;
      }
      target.face_ids = componentFaceIds;
      target.cover_face_id = bestRow.face_id;
      const { error: upErr } = await sb
        .from("people")
        .update({
          asset_id: bestRow.asset_id,
          face: bestRow.face,
          face_ids: componentFaceIds,
          updated_at: now,
        })
        .eq("id", personId);
      if (upErr) {
        console.warn("clusterPeople: update person component failed", personId, upErr.message);
        skippedCount += component.length;
        continue;
      }
    }

    const targetRowIds = component
      .map((row) => row.asset_face_row_id)
      .filter(Boolean) as string[];
    if (targetRowIds.length) {
      const { error: linkErr } = await sb
        .from("asset_faces")
        .update({ person_id: personId, updated_at: now })
        .in("id", targetRowIds);
      if (linkErr) {
        console.warn("clusterPeople: component link asset_faces failed", personId, linkErr.message);
        skippedCount += component.length;
        continue;
      }
      linkedCount += targetRowIds.length;
      for (const row of assetFaceRows) {
        if (targetRowIds.includes(row.id)) row.person_id = personId;
      }
    }

    for (const faceId of componentFaceIds) {
      faceIdToPersonId.set(faceId, personId);
    }
  }

  const orphanIds = Array.from(peopleById.values())
    .filter((person) => !assetFaceRows.some((row: any) => row.person_id === person.id))
    .map((person) => person.id);
  if (orphanIds.length) {
    const { error: cleanupErr } = await sb.from("people").delete().in("id", orphanIds);
    if (cleanupErr) {
      console.warn("clusterPeople: cleanup orphan people failed", uid, cleanupErr.message);
    }
  }

  return {
    user_id: uid,
    trigger_asset_id: asset_id ?? null,
    faces_processed: qualifying.length,
    people_created: createdCount,
    detections_linked: linkedCount,
    skipped: skippedCount,
  };
}
