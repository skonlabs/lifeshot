// deno-lint-ignore-file no-explicit-any
/**
 * Shared face-quality gate.
 *
 * Used by:
 *  - face-detector.ts  → filters BEFORE faces enter the Rekognition collection
 *  - enrichAI.ts       → filters BEFORE persisting to asset_ai_enrichment.faces
 *  - clusterPeople.ts  → re-filters in case older rows contain bad entries
 *  - cleanup migration → mirrored thresholds for one-time backfill
 *
 * Thresholds match the historical enrichAI values so behaviour for compliant
 * faces is unchanged.
 */
export const FACE_MIN_CONFIDENCE = 0.6;   // 0..1 (Rekognition confidence/100)
export const FACE_MAX_YAW = 15;           // degrees — Rekognition underreports yaw; 15° here ≈ 25-30° visually turned
export const FACE_MAX_PITCH = 10;         // degrees — rejects faces looking up/down
export const FACE_MIN_SHARPNESS = 40;     // 0..100
export const FACE_MIN_BRIGHTNESS = 25;    // 0..100

/**
 * Returns true if a face passes the front-facing / quality gate.
 * Accepts a partial input: `confidence` in 0..1 plus a Rekognition `FaceDetail`-shaped
 * attributes object (Pose.Yaw/Pitch, Quality.Sharpness/Brightness, FaceOccluded).
 *
 * Rejection rules (any match → false):
 *  - confidence present and below FACE_MIN_CONFIDENCE
 *  - FaceOccluded.Value === true (any significant occlusion per Rekognition)
 *  - |Pose.Yaw| > FACE_MAX_YAW   (too far turned sideways)
 *  - |Pose.Pitch| > FACE_MAX_PITCH (too far tilted up/down)
 *  - Quality.Sharpness < FACE_MIN_SHARPNESS (blurry)
 *  - Quality.Brightness < FACE_MIN_BRIGHTNESS (too dark)
 *
 * If attributes are missing entirely (older rows without Rekognition payload),
 * we keep the face — we cannot prove it's bad. Only attributes that are
 * present and out of range cause rejection.
 */
export function isUsableFace(input: {
  confidence?: number | null;
  attributes?: Record<string, any> | null;
}): boolean {
  const conf = Number(input.confidence ?? 0);
  if (Number.isFinite(conf) && conf > 0 && conf < FACE_MIN_CONFIDENCE) return false;

  const a = input.attributes ?? null;
  if (!a) return true;

  // Reject occluded faces — Rekognition sets FaceOccluded.Value = true when
  // part of the face is covered by hair, glasses, hands, or other objects.
  // Only reject when Rekognition is confident enough (Value is definitively true).
  const occ = (a.FaceOccluded ?? null) as Record<string, any> | null;
  if (occ && occ.Value === true) return false;

  const pose = (a.Pose ?? null) as Record<string, any> | null;
  if (pose) {
    const yaw = Math.abs(Number(pose.Yaw ?? 0));
    const pitch = Math.abs(Number(pose.Pitch ?? 0));
    if (Number.isFinite(yaw) && yaw > FACE_MAX_YAW) return false;
    if (Number.isFinite(pitch) && pitch > FACE_MAX_PITCH) return false;
  }

  const q = (a.Quality ?? null) as Record<string, any> | null;
  if (q) {
    const sharp = Number(q.Sharpness ?? 100);
    const bright = Number(q.Brightness ?? 100);
    if (Number.isFinite(sharp) && sharp < FACE_MIN_SHARPNESS) return false;
    if (Number.isFinite(bright) && bright < FACE_MIN_BRIGHTNESS) return false;
  }

  return true;
}