export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_SIDE = 0.04;
const MIN_AREA = 0.0035;
const MAX_SIDE = 0.58;
const MAX_AREA = 0.22;

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

function squareFromCenter(cx: number, cy: number, side: number): FaceBox {
  const normalizedSide = Math.min(Math.max(side, MIN_SIDE), 1);
  const x = clamp01(Math.min(Math.max(cx - normalizedSide / 2, 0), 1 - normalizedSide));
  const y = clamp01(Math.min(Math.max(cy - normalizedSide / 2, 0), 1 - normalizedSide));
  return { x, y, w: normalizedSide, h: normalizedSide };
}

export function sanitizeFaceBox(input: unknown): FaceBox | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const rawX = toFiniteNumber(raw.x);
  const rawY = toFiniteNumber(raw.y);
  let rawW = toFiniteNumber(raw.w);
  let rawH = toFiniteNumber(raw.h);
  if (rawX == null || rawY == null || rawW == null || rawH == null) return null;

  const x = clamp01(rawX);
  const y = clamp01(rawY);
  rawW = Math.max(Math.min(rawW, 1), 0);
  rawH = Math.max(Math.min(rawH, 1), 0);
  if (x + rawW > 1) rawW = 1 - x;
  if (y + rawH > 1) rawH = 1 - y;
  if (rawW < MIN_SIDE || rawH < MIN_SIDE) return null;

  const rawArea = rawW * rawH;
  if (rawArea < MIN_AREA || rawW > 0.72 || rawH > 0.85 || rawArea > 0.42) return null;

  const aspect = rawW / rawH;
  let side = Math.max(rawW, rawH);
  const cx = x + rawW / 2;
  let cy = y + rawH / 2;

  if (aspect < 0.72 || rawH > rawW * 1.28) {
    side = Math.min(Math.max(rawW * 1.1, rawH * 0.52), 0.5);
    cy = y + Math.min(rawH * 0.34, side * 0.58);
  } else if (aspect > 1.18) {
    side = Math.min(Math.max(rawH * 1.12, rawW * 0.64), 0.5);
  } else {
    side = Math.min(Math.max(Math.max(rawW, rawH) * 1.18, 0.08), 0.5);
    cy = y + rawH * 0.48;
  }

  const box = squareFromCenter(cx, cy, side);
  const area = box.w * box.h;
  if (box.w < MIN_SIDE || box.h < MIN_SIDE) return null;
  if (box.w > MAX_SIDE || box.h > MAX_SIDE || area > MAX_AREA) return null;
  return box;
}

export function faceQualityScore(box: FaceBox | null, confidence: number, facesInAsset = 1): number {
  if (!box) return Number.NEGATIVE_INFINITY;
  const area = box.w * box.h;
  const idealArea = 0.1;
  const areaFit = 1 - Math.min(Math.abs(area - idealArea) / idealArea, 1);
  const soloBonus = facesInAsset <= 1 ? 0.25 : facesInAsset === 2 ? 0.1 : -0.05 * Math.min(facesInAsset - 2, 4);
  return confidence * 2 + areaFit + soloBonus;
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