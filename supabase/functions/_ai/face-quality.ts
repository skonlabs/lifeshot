// deno-lint-ignore-file no-explicit-any
/**
 * Face quality gate — applied at every stage of the pipeline:
 *   1. face-detector.ts: reject before indexing into Rekognition collection
 *   2. enrichAI.ts: reject before persisting to asset_ai_enrichment.faces
 *   3. clusterPeople.ts: re-check stored faces in case older rows exist
 *
 * Rekognition underreports yaw/pitch relative to human perception:
 *   Rekognition 15° ≈ 25-30° visual turn → use 15° as the threshold
 */
export const FACE_MIN_CONFIDENCE = 0.70; // 0..1 (Rekognition confidence / 100)
export const FACE_MAX_YAW       = 10;    // degrees — Rekognition underreports ~2x, so 10 ≈ 20° visual
export const FACE_MAX_PITCH     = 8;     // degrees — same underreport factor
export const FACE_MIN_SHARPNESS = 50;    // 0..100
export const FACE_MIN_BRIGHTNESS = 30;   // 0..100

/**
 * Returns true when a face passes ALL quality criteria.
 * Any failing criterion causes rejection — there is no partial pass.
 *
 * Input:
 *   confidence — Rekognition FaceDetail.Confidence / 100 (0..1 scale)
 *   attributes — full Rekognition FaceDetail JSON (Pose, Quality, FaceOccluded…)
 *
 * If attributes is null the face is rejected — we cannot verify frontal pose
 * or quality without Rekognition's full detection output.
 */
export function isUsableFace(input: {
  confidence?: number | null;
  attributes?: Record<string, any> | null;
}): boolean {
  const conf = Number(input.confidence ?? 0);
  if (Number.isFinite(conf) && conf > 0 && conf < FACE_MIN_CONFIDENCE) return false;

  const a = input.attributes ?? null;
  if (!a) return false; // reject faces without quality data

  // Reject if face is occluded (hair over face, hands, other objects).
  const occ = (a.FaceOccluded ?? null) as Record<string, any> | null;
  if (occ?.Value === true) return false;

  // Reject side profiles and tilted faces.
  const pose = (a.Pose ?? null) as Record<string, any> | null;
  if (pose) {
    const yaw   = Math.abs(Number(pose.Yaw   ?? 0));
    const pitch = Math.abs(Number(pose.Pitch ?? 0));
    if (Number.isFinite(yaw)   && yaw   > FACE_MAX_YAW)   return false;
    if (Number.isFinite(pitch) && pitch > FACE_MAX_PITCH) return false;
  } else {
    return false; // no pose data → can't verify frontal → reject
  }

  // Reject blurry or dark faces.
  const q = (a.Quality ?? null) as Record<string, any> | null;
  if (q) {
    const sharp  = Number(q.Sharpness  ?? 100);
    const bright = Number(q.Brightness ?? 100);
    if (Number.isFinite(sharp)  && sharp  < FACE_MIN_SHARPNESS)  return false;
    if (Number.isFinite(bright) && bright < FACE_MIN_BRIGHTNESS) return false;
  }

  return true;
}
