// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { searchFaces, collectionIdForUser, rekognitionConfigured } from "../_ai/rekognition.ts";

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

  // ── 2. Load existing people → build faceId → displayName + row-id maps ──────
  const { data: existingPeople } = await sb
    .from("people")
    .select("id, display_name, asset_id, face")
    .eq("user_id", uid);

  const faceIdToDisplayName = new Map<string, string>(); // faceId → displayName
  const existingByKey = new Map<string, string>();        // "assetId:faceId" → row id

  for (const p of existingPeople ?? []) {
    const fid: string | undefined = (p as any).face?.FaceId;
    if (fid && p.display_name) faceIdToDisplayName.set(fid, p.display_name);
    if (fid && (p as any).asset_id) existingByKey.set(`${(p as any).asset_id}:${fid}`, p.id);
  }

  let maxPersonN = 0;
  for (const p of existingPeople ?? []) {
    const m = String(p.display_name ?? "").match(/^Person (\d+)$/);
    if (m) maxPersonN = Math.max(maxPersonN, Number(m[1]));
  }

  // ── 3. Assign each face to a person and upsert into people table ─────────────
  let created = 0;
  let upserted = 0;

  for (const row of qualifying) {
    const faceId  = row.face_id;
    const faceJson = row.face; // Rekognition attributes, no FaceCrop
    const assetId = row.asset_id;

    let displayName: string | null = faceIdToDisplayName.get(faceId) ?? null;

    if (!displayName) {
      try {
        const matches = await searchFaces({
          collectionId,
          faceId,
          faceMatchThreshold: FALLBACK_THRESHOLD,
          maxFaces: 10,
        });
        const sorted = matches
          .filter((m) => m.faceId !== faceId)
          .sort((a, b) => b.similarity - a.similarity);
        const best =
          sorted.find((m) => m.similarity >= PRIMARY_THRESHOLD  && faceIdToDisplayName.has(m.faceId)) ??
          sorted.find((m) => m.similarity >= FALLBACK_THRESHOLD && faceIdToDisplayName.has(m.faceId)) ??
          null;
        if (best) displayName = faceIdToDisplayName.get(best.faceId)!;
      } catch (e: any) {
        console.warn("clusterPeople: SearchFaces failed", faceId, String(e?.message ?? e));
      }
    }

    if (!displayName) {
      maxPersonN++;
      displayName = `Person ${maxPersonN}`;
      created++;
    }

    faceIdToDisplayName.set(faceId, displayName);

    const key = `${assetId}:${faceId}`;
    const existingId = existingByKey.get(key);

    if (existingId) {
      // Refresh face metadata; preserve display_name (may have been user-corrected).
      const { error: upErr } = await sb.from("people")
        .update({ face: faceJson, display_name: displayName, updated_at: new Date().toISOString() })
        .eq("id", existingId);
      if (upErr) console.warn("clusterPeople: update failed", existingId, upErr.message);
    } else {
      const { error: insErr } = await sb.from("people")
        .insert({ user_id: uid, asset_id: assetId, display_name: displayName, face: faceJson });
      if (insErr) console.warn("clusterPeople: insert failed", faceId, insErr.message);
    }
    upserted++;
  }

  return {
    user_id:         uid,
    people_created:  created,
    faces_processed: qualifying.length,
    rows_upserted:   upserted,
  };
}
