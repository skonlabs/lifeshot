// deno-lint-ignore-file no-explicit-any

export const FACE_CLUSTER_QUALITY = {
  minConfidence: 90,
  minEyesOpenConfidence: 60,       // Rekognition attribute confidence, not detection confidence
  minFaceOccludedConfidence: 60,   // Rekognition attribute confidence, not detection confidence
  maxYaw: 30,
  maxPitch: 25,
  // Lowered from 35 → 8. Rekognition's Sharpness score drops sharply for
  // faces that occupy only a few percent of a large photo (group shots),
  // and further when we downscale to fit the 5 MB API limit. Every face is
  // still gated by confidence ≥ 90, pose (yaw/pitch), eyes-open and
  // not-occluded checks, so loosening sharpness alone does not let garbage
  // through — it just stops dropping valid faces from group photos.
  minSharpness: 2,
  minBrightness: 15,
};

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function isUsableFaceDetail(faceDetail: any): boolean {
  if (!faceDetail || typeof faceDetail !== "object") return false;

  const yaw = Math.abs(toNumber(faceDetail?.Pose?.Yaw) ?? Number.POSITIVE_INFINITY);
  const pitch = Math.abs(toNumber(faceDetail?.Pose?.Pitch) ?? Number.POSITIVE_INFINITY);
  const sharpness = toNumber(faceDetail?.Quality?.Sharpness) ?? Number.NEGATIVE_INFINITY;
  const brightness = toNumber(faceDetail?.Quality?.Brightness) ?? Number.NEGATIVE_INFINITY;
  // Treat absent field as passing — Rekognition does not always return EyesOpen/
  // FaceOccluded for every detection. Requiring === true/=== false would silently
  // exclude all faces where the attribute was not returned.
  const faceOccludedValue = toBoolean(faceDetail?.FaceOccluded?.Value);
  const notOccluded = faceOccludedValue !== true; // absent → passes
  const notOccludedConfidence = faceOccludedValue === false
    ? (toNumber(faceDetail?.FaceOccluded?.Confidence) ?? 100)
    : 100;
  const eyesOpenValue = toBoolean(faceDetail?.EyesOpen?.Value);
  const eyesOpen = eyesOpenValue !== false; // absent → passes
  const eyesOpenConfidence = eyesOpenValue === true
    ? (toNumber(faceDetail?.EyesOpen?.Confidence) ?? 100)
    : 100;

  return notOccluded
    && notOccludedConfidence >= FACE_CLUSTER_QUALITY.minFaceOccludedConfidence
    && eyesOpen
    && eyesOpenConfidence >= FACE_CLUSTER_QUALITY.minEyesOpenConfidence
    && yaw <= FACE_CLUSTER_QUALITY.maxYaw
    && pitch <= FACE_CLUSTER_QUALITY.maxPitch
    && sharpness >= FACE_CLUSTER_QUALITY.minSharpness
    && brightness >= FACE_CLUSTER_QUALITY.minBrightness;
}

export function isUsableIndexedFace(face: any): boolean {
  if (!face || typeof face !== "object") return false;
  const confidence = toNumber(face?.Confidence) ?? Number.NEGATIVE_INFINITY;
  return confidence >= FACE_CLUSTER_QUALITY.minConfidence
    && isUsableFaceDetail(face?.FaceDetail);
}
