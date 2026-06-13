// deno-lint-ignore-file no-explicit-any

export const FACE_CLUSTER_QUALITY = {
  minConfidence: 90,
  maxYaw: 30,
  maxPitch: 25,
  minSharpness: 35,
  minBrightness: 25,
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
  const notOccluded = toBoolean(faceDetail?.FaceOccluded?.Value) === false;

  return notOccluded
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
