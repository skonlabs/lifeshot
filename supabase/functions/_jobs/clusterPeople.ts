// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { searchFaces, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";

/**
 * Score a face for cover selection. Higher = better avatar quality.
 * Prioritises: frontal pose > sharpness > non-occluded > bright.
 */
function coverScore(attributes: any): number {
  if (!attributes) return 0;
  const pose    = attributes.Pose    ?? {};
  const quality = attributes.Quality ?? {};
  const yaw    = Math.abs(Number(pose.Yaw   ?? 90));
  const pitch  = Math.abs(Number(pose.Pitch ?? 90));
  const sharp  = Number(quality.Sharpness  ?? 0);
  const bright = Number(quality.Brightness ?? 0);
  const eyeYaw   = Math.abs(Number((attributes.EyeDirection?.Yaw   ?? 90)));
  const eyePitch = Math.abs(Number((attributes.EyeDirection?.Pitch ?? 90)));
  const gazeScore = Math.max(0, (1 - eyeYaw / 90)) * Math.max(0, (1 - eyePitch / 90));
  const frontality = Math.max(0, (1 - yaw / 90)) * Math.max(0, (1 - pitch / 90));
  return frontality * 0.50 + (sharp / 100) * 0.25 + (bright / 100) * 0.10 + gazeScore * 0.15;
}

const MIN_COVER_SCORE = 0.40;
const PRIMARY_THRESHOLD  = 80;
const FALLBACK_THRESHOLD = 70;

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

  // ── 1. Load qualifying faces via SQL function ─────────────────────────────
  // get_qualifying_faces applies the full quality gate in PostgreSQL and returns
  // only tiny columns (no attributes, no face_crop).  This keeps the HTTP
  // response under ~100 KB even for thousands of faces, avoiding the silent
  // empty-result failure that occurred when the bulk SELECT included attributes
  // (~3 KB/face) or face_crop (~100 KB/face).
  const rpcArgs: Record<string, unknown> = { p_user_id: uid };
  if (asset_id) rpcArgs.p_asset_id = asset_id;

  const { data: faceRows, error } = await sb.rpc("get_qualifying_faces", rpcArgs);
  if (error) throw new Error(`clusterPeople get_qualifying_faces: ${error.message}`);

  interface FaceEntry {
    asset_id: string;
    face_id:  string;
    bbox:     any;
    confidence: number;
  }

  const faceEntries: FaceEntry[] = (faceRows ?? []).map((f: any) => ({
    asset_id:   f.asset_id,
    face_id:    f.face_id,
    bbox:       f.bbox ?? null,
    confidence: Number(f.confidence ?? 0),
  }));

  if (faceEntries.length === 0) {
    return { user_id: uid, people: 0, clustered: 0, reason: "no_qualifying_faces" };
  }

  const collectionId = collectionIdForUser(uid);

  // ── 2. Load existing people and build face→person map ─────────────────────
  const { data: existingPeople } = await sb
    .from("people")
    .select("id, auto_label, rekognition_face_ids, faces, cover_face_crop, cover_asset_id, cover_bbox")
    .eq("user_id", uid)
    .like("auto_label", "auto:person:%");

  const faceIdToPersonId = new Map<string, string>();
  for (const person of existingPeople ?? []) {
    for (const fid of ((person as any).rekognition_face_ids ?? []) as string[]) {
      if (fid) faceIdToPersonId.set(fid, person.id);
    }
  }

  let maxPersonN = 0;
  for (const person of existingPeople ?? []) {
    const m = String(person.auto_label ?? "").match(/^auto:person:(\d+)$/);
    if (m) maxPersonN = Math.max(maxPersonN, Number(m[1]));
  }

  // ── 3. Assign each face to a person ───────────────────────────────────────
  const personFaceMap = new Map<string, FaceEntry[]>();

  for (const entry of faceEntries) {
    let personId: string | null = faceIdToPersonId.get(entry.face_id) ?? null;

    if (!personId) {
      try {
        const matches = await searchFaces({
          collectionId,
          faceId: entry.face_id,
          faceMatchThreshold: FALLBACK_THRESHOLD,
          maxFaces: 10,
        });
        const sorted = matches
          .filter((m) => m.faceId !== entry.face_id)
          .sort((a, b) => b.similarity - a.similarity);
        const primary  = sorted.find((m) => m.similarity >= PRIMARY_THRESHOLD  && faceIdToPersonId.has(m.faceId));
        const fallback = sorted.find((m) => m.similarity >= FALLBACK_THRESHOLD && faceIdToPersonId.has(m.faceId));
        const match    = primary ?? fallback ?? null;
        if (match) personId = faceIdToPersonId.get(match.faceId)!;
      } catch (e: any) {
        console.warn("clusterPeople: SearchFaces failed", entry.face_id, String(e?.message ?? e));
      }
    }

    if (!personId) {
      maxPersonN++;
      const autoLabel = `auto:person:${maxPersonN}`;
      const { data: newPerson, error: npErr } = await sb
        .from("people")
        .upsert(
          { user_id: uid, auto_label: autoLabel, display_name: `Person ${maxPersonN}`, consent_required: true },
          { onConflict: "user_id,auto_label" },
        )
        .select("id").single();
      if (npErr || !newPerson) {
        throw new Error(`clusterPeople: person upsert failed: ${npErr?.message ?? "no row returned"}`);
      }
      personId = newPerson.id;
    }
    if (!personId) continue;

    faceIdToPersonId.set(entry.face_id, personId);
    const arr = personFaceMap.get(personId) ?? [];
    arr.push(entry);
    personFaceMap.set(personId, arr);
  }

  // ── 4. Persist to people table ────────────────────────────────────────────
  const assetsInThisRun = new Set(faceEntries.map((e) => e.asset_id));

  let peopleUpdated = 0;
  for (const [pid, entries] of personFaceMap) {
    const existing   = (existingPeople ?? []).find((p: any) => p.id === pid);
    const existingFaces: any[] = Array.isArray((existing as any)?.faces) ? (existing as any).faces : [];

    // Keep occurrences from other assets; replace occurrences from this run's assets.
    const kept  = existingFaces.filter((o: any) => !assetsInThisRun.has(o.asset_id));
    const fresh = entries.map((e) => ({
      asset_id:            e.asset_id,
      bbox:                e.bbox,
      confidence:          e.confidence,
      rekognition_face_id: e.face_id,
    }));
    const merged = [...kept, ...fresh];

    // ── Cover selection ─────────────────────────────────────────────────────
    // Fetch attributes + face_crop only for this person's candidate faces
    // (never the full table — keeps per-person fetch tiny).
    const candidateFaceIds = entries.map((e) => e.face_id);
    const { data: candidateRows } = await sb
      .from("asset_faces")
      .select("face_id, asset_id, face_crop, attributes")
      .eq("user_id", uid)
      .in("face_id", candidateFaceIds);

    // Count faces per asset to prefer solo portraits over group photos.
    const facesPerAsset = new Map<string, number>();
    for (const o of merged) facesPerAsset.set(o.asset_id, (facesPerAsset.get(o.asset_id) ?? 0) + 1);

    let bestCoverRow: any = null;
    let bestScore = -1;
    for (const row of candidateRows ?? []) {
      if (!row.face_crop) continue;
      const s = coverScore(row.attributes);
      if (s < MIN_COVER_SCORE) continue;
      const isSolo = (facesPerAsset.get(row.asset_id) ?? 0) === 1;
      const adjusted = isSolo ? s * 1.3 : s;
      if (adjusted > bestScore) { bestScore = adjusted; bestCoverRow = row; }
    }

    const allFaceIds = [...new Set(
      entries.map((e) => e.face_id).concat(
        Array.isArray((existing as any)?.rekognition_face_ids) ? (existing as any).rekognition_face_ids : [],
      ),
    )].filter(Boolean);

    const update: Record<string, unknown> = {
      faces:                merged,
      face_count:           merged.length,
      rekognition_face_ids: allFaceIds,
    };
    if (bestCoverRow?.face_crop) {
      update.cover_face_crop = bestCoverRow.face_crop;
      update.cover_asset_id  = bestCoverRow.asset_id;
      update.cover_bbox      = entries.find((e) => e.face_id === bestCoverRow.face_id)?.bbox ?? null;
    }

    const { error: uErr } = await sb.from("people").update(update).eq("id", pid);
    if (uErr) throw new Error(`clusterPeople: people update failed for ${pid}: ${uErr.message}`);
    peopleUpdated++;
  }

  return {
    user_id:         uid,
    people_created:  maxPersonN - (existingPeople?.length ?? 0),
    people_updated:  peopleUpdated,
    faces_processed: faceEntries.length,
  };
}
