export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalize and lightly pad a Rekognition bounding box.
 *
 * Rekognition already identifies the face region precisely — we trust its
 * output and only:
 *   1. Validate that x/y/w/h are finite numbers.
 *   2. Clamp coords to [0, 1].
 *   3. Add a small uniform 20% padding so the crop has context around the face.
 *   4. Convert to a square centred on the face (required for circular avatars).
 *
 * No area or side-length rejection — every face Rekognition found is valid.
 */
export function sanitizeFaceBox(input: unknown): FaceBox | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const rawX = toFiniteNumber(raw.x);
  const rawY = toFiniteNumber(raw.y);
  const rawW = toFiniteNumber(raw.w);
  const rawH = toFiniteNumber(raw.h);
  if (rawX == null || rawY == null || rawW == null || rawH == null) return null;

  const x = clamp01(rawX);
  const y = clamp01(rawY);
  const w = clamp01(Math.min(rawW, 1 - x));
  const h = clamp01(Math.min(rawH, 1 - y));
  if (w <= 0 || h <= 0) return null;

  // Square side = longest face dimension + 10% padding on each side.
  const longest = Math.max(w, h);
  const side = Math.min(longest * 1.20, 1.0);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const sx = clamp01(Math.min(Math.max(cx - side / 2, 0), 1 - side));
  const sy = clamp01(Math.min(Math.max(cy - side / 2, 0), 1 - side));
  return { x: sx, y: sy, w: side, h: side };
}

export function faceQualityScore(box: FaceBox | null, confidence: number, facesInAsset = 1): number {
  if (!box) return Number.NEGATIVE_INFINITY;
  const area = box.w * box.h;
  const idealArea = 0.1;
  const areaFit = 1 - Math.min(Math.abs(area - idealArea) / idealArea, 1);
  const soloBonus = facesInAsset <= 1 ? 0.25 : facesInAsset === 2 ? 0.1 : -0.05 * Math.min(facesInAsset - 2, 4);
  // Prefer cover faces that have enough source pixels to look crisp in an
  // avatar. Confidence is usually saturated at 100 for every face in a group
  // photo, so size must be a stronger signal than tiny confidence differences.
  const sizeBonus = Math.sqrt(area) * 120;
  return confidence * 2 + sizeBonus + areaFit + soloBonus;
}

export function faceVisualSignature(assetId: string, box: FaceBox | null): string {
  if (!box) return `${assetId}:none`;
  return `${assetId}:${[box.x, box.y, box.w, box.h].map((value) => value.toFixed(2)).join(":")}`;
}

export function intersectionOverUnion(a: FaceBox | null, b: FaceBox | null): number {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (intersection <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}