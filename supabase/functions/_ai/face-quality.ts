// deno-lint-ignore-file no-explicit-any
export const FACE_MIN_CONFIDENCE  = 0.60;
export const FACE_MAX_YAW         = 20;   // degrees — rejects clear side profiles (data: bad faces at 25°–77°)
export const FACE_MAX_PITCH       = 20;   // degrees — rejects sharp up/down tilt (data: bad faces at -29° to -63°)
export const FACE_MIN_SHARPNESS   = 35;   // 0..100 — data: bad faces at 5–16, good faces at 38+
export const FACE_MIN_BRIGHTNESS  = 20;   // 0..100

export function isUsableFace(input: {
  confidence?: number | null;
  attributes?: Record<string, any> | null;
}): boolean {
  const conf = Number(input.confidence ?? 0);
  if (conf > 0 && conf < FACE_MIN_CONFIDENCE) return false;

  const a = input.attributes;
  if (!a) return false;

  // Reject occluded faces (hair, hands, objects over face).
  const occVal = a?.FaceOccluded?.Value ?? a?.FaceOccluded?.value ?? null;
  if (occVal === true || occVal === "true") return false;

  // Reject side profiles and sharp up/down tilt.
  const pose = a?.Pose ?? null;
  if (!pose) return false;
  const yaw   = Math.abs(Number(pose.Yaw   ?? pose.yaw   ?? 0));
  const pitch = Math.abs(Number(pose.Pitch ?? pose.pitch ?? 0));
  if (!Number.isFinite(yaw)   || yaw   > FACE_MAX_YAW)   return false;
  if (!Number.isFinite(pitch) || pitch > FACE_MAX_PITCH) return false;

  // Reject blurry faces.
  const q = a?.Quality ?? null;
  if (q) {
    const sharp  = Number(q.Sharpness  ?? q.sharpness  ?? 100);
    const bright = Number(q.Brightness ?? q.brightness ?? 100);
    if (Number.isFinite(sharp)  && sharp  < FACE_MIN_SHARPNESS)  return false;
    if (Number.isFinite(bright) && bright < FACE_MIN_BRIGHTNESS) return false;
  }

  return true;
}
