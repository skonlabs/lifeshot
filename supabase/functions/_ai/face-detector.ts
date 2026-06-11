// deno-lint-ignore-file no-explicit-any
/**
 * Face detector backed by AWS Rekognition IndexFaces.
 *
 * Industry-standard pipeline:
 *   1. Fetch image; resize to < 3.75 MB if needed (Rekognition base64 limit).
 *   2. Ensure per-user Rekognition collection exists.
 *   3. Call IndexFaces (qualityFilter NONE, DetectionAttributes ALL).
 *      NONE indexes ALL detected faces — same set as DetectFaces returns.
 *      Quality is used ONLY for cover photo selection in clusterPeople.
 *   4. Dedup at 98%: keep NEW FaceId, delete OLD stale entries so the collection
 *      stays clean across re-scans.
 *   5. Crop each face using Rekognition Landmarks (upperJawlineLeft/Right → chinBottom)
 *      for precise hairline-to-chin framing. Falls back to BoundingBox if landmarks absent.
 *
 * Landmark-based crop (the correct approach):
 *   - Top:    min(upperJawlineLeft.Y, upperJawlineRight.Y) — the actual top of the face.
 *             Add 70% of face height upward for hair/forehead above the jawline.
 *   - Bottom: chinBottom.Y — the actual chin tip. Add 15% padding below.
 *   - Sides:  upperJawlineLeft.X / upperJawlineRight.X + 35% horizontal padding each side.
 *   Then expand to a square from the crop center — no stretching.
 *
 * Quality filtering is intentionally NOT done here — filtering at detection
 * time causes missed faces. Quality is only applied when selecting which face
 * to use as a person's cover photo (in clusterPeople.ts).
 */
import {
  ensureCollection,
  indexFaces,
  searchFaces,
  deleteFaces,
  collectionIdForUser,
  rekognitionConfigured,
} from "./rekognition.ts";

const REKOGNITION_MAX_BYTES = 3_750_000;
const DEDUP_SIMILARITY = 98;

export interface DetectedFace {
  bbox: { x: number; y: number; w: number; h: number } | null;
  description: string;
  confidence: number;   // 0..1
  embedding: number[] | null;
  face_id: string | null;
  attributes: Record<string, unknown> | null;
  face_crop: string | null; // JPEG base64 data-URL, landmark-cropped
}

async function resizeToFit(bytes: Uint8Array, mime: string, maxBytes: number): Promise<Uint8Array> {
  if (bytes.byteLength <= maxBytes) return bytes;
  const scale = Math.sqrt(maxBytes / bytes.byteLength) * 0.90;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const w = Math.max(1, Math.floor(bitmap.width * scale));
    const h = Math.max(1, Math.floor(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.90 });
    const out = new Uint8Array(await blob.arrayBuffer());
    return out.byteLength > maxBytes ? resizeToFit(out, "image/jpeg", maxBytes) : out;
  } catch {
    return bytes;
  }
}

async function fetchImage(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch image ${resp.status}`);
  const mime = resp.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/jpeg";
  const raw = new Uint8Array(await resp.arrayBuffer());
  const bytes = await resizeToFit(raw, mime, REKOGNITION_MAX_BYTES);
  return { bytes, mime };
}

function findLandmark(
  landmarks: any[],
  type: string,
): { x: number; y: number } | null {
  const lm = landmarks?.find((l: any) => l.Type === type);
  return lm ? { x: Number(lm.X), y: Number(lm.Y) } : null;
}

async function cropFace(
  bytes: Uint8Array,
  mime: string,
  bbox: { x: number; y: number; w: number; h: number },
  landmarks?: any[] | null,
): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const W = bitmap.width, H = bitmap.height;

    let left: number, right: number, top: number, bottom: number;

    // Use Rekognition Landmarks for precise hairline-to-chin crop when available.
    // upperJawlineLeft / upperJawlineRight mark the top corners of the face shape
    // (near the hairline). chinBottom is the actual chin tip.
    const upperLeft  = landmarks ? findLandmark(landmarks, "upperJawlineLeft")  : null;
    const upperRight = landmarks ? findLandmark(landmarks, "upperJawlineRight") : null;
    const chin       = landmarks ? findLandmark(landmarks, "chinBottom")        : null;

    if (upperLeft && upperRight && chin) {
      const faceLeft   = Math.min(upperLeft.x, upperRight.x) * W;
      const faceRight  = Math.max(upperLeft.x, upperRight.x) * W;
      const faceTop    = Math.min(upperLeft.y, upperRight.y) * H;
      const faceBottom = chin.y * H;
      const faceW      = faceRight - faceLeft;
      const faceH      = faceBottom - faceTop;

      // 35% side padding, 70% above (hair grows above the jawline reference point),
      // 15% below chin.
      left   = faceLeft   - faceW * 0.35;
      right  = faceRight  + faceW * 0.35;
      top    = faceTop    - faceH * 0.70;
      bottom = faceBottom + faceH * 0.15;
    } else {
      // Fallback: BoundingBox-based crop with asymmetric padding.
      // +50% above for hair/forehead, +30% sides and below.
      const faceCx = (bbox.x + bbox.w / 2) * W;
      const faceCy = (bbox.y + bbox.h / 2) * H;
      const faceW  = bbox.w * W;
      const faceH  = bbox.h * H;

      left   = faceCx - faceW * (0.5 + 0.30);
      right  = faceCx + faceW * (0.5 + 0.30);
      top    = faceCy - faceH * (0.5 + 0.50);
      bottom = faceCy + faceH * (0.5 + 0.30);
    }

    // Expand to a square from the center so the image is never stretched.
    const cx   = (left + right) / 2;
    const cy   = (top  + bottom) / 2;
    const half = Math.max(right - left, bottom - top) / 2;

    const sx = Math.max(0, cx - half);
    const sy = Math.max(0, cy - half);
    const ex = Math.min(W, cx + half);
    const ey = Math.min(H, cy + half);
    const sw = ex - sx;
    const sh = ey - sy;

    const size = Math.min(300, Math.round(Math.max(sw, sh)));
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, size, size);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let b64 = ""; const ch = 8192;
    for (let i = 0; i < buf.length; i += ch) b64 += String.fromCharCode(...buf.subarray(i, i + ch));
    return `data:image/jpeg;base64,${btoa(b64)}`;
  } catch {
    return null;
  }
}

export async function detectFaces(opts: {
  imageUrl: string;
  userId: string;
  assetId: string;
}): Promise<DetectedFace[]> {
  if (!rekognitionConfigured()) {
    console.warn("face-detector: Rekognition not configured — skipping");
    return [];
  }

  let bytes: Uint8Array, mime: string;
  try {
    ({ bytes, mime } = await fetchImage(opts.imageUrl));
  } catch (e: any) {
    console.warn("face-detector: image fetch failed", String(e?.message ?? e));
    return [];
  }

  const collectionId = collectionIdForUser(opts.userId);
  try {
    await ensureCollection(collectionId);
  } catch (e: any) {
    console.error("face-detector: ensureCollection failed", String(e?.message ?? e));
    return [];
  }

  let records;
  try {
    records = await indexFaces({
      collectionId,
      imageBytes: bytes,
      externalImageId: opts.assetId,
      maxFaces: 100,
      qualityFilter: "NONE", // Index ALL detected faces — same as DetectFaces; no quality pre-filtering
    });
  } catch (e: any) {
    console.warn("face-detector: indexFaces failed", String(e?.message ?? e));
    return [];
  }

  if (records.length === 0) return [];

  // Dedup: when the same physical face already exists in the collection from a
  // previous scan, keep the OLD (canonical) FaceId and delete the NEW duplicate.
  // Keeping the old face_id preserves person_faces links in the DB —
  // if we deleted the old id, clusterPeople's faceIdToPersonId map (built from
  // person_faces) would lose the person link and fragment clustering.
  const toDelete: string[] = [];
  const seen = new Set<string>();
  // Map from new face_id → existing canonical face_id (when deduped).
  const replacedBy = new Map<string, string>();

  const deduped = await Promise.all(records.map(async (r) => {
    try {
      const matches = await searchFaces({
        collectionId, faceId: r.faceId,
        faceMatchThreshold: DEDUP_SIMILARITY, maxFaces: 5,
      });
      const existing = matches
        .filter((m) => m.faceId !== r.faceId && !seen.has(m.faceId))
        .sort((a, b) => b.similarity - a.similarity)[0];
      if (existing) {
        // Keep existing (old) face_id; delete the newly indexed duplicate.
        toDelete.push(r.faceId);
        replacedBy.set(r.faceId, existing.faceId);
        seen.add(existing.faceId);
        return { ...r, canonicalFaceId: existing.faceId };
      }
    } catch (e: any) {
      console.warn("face-detector: dedup search failed", r.faceId, String(e?.message ?? e));
    }
    seen.add(r.faceId);
    return { ...r, canonicalFaceId: r.faceId };
  }));

  if (toDelete.length > 0) {
    try {
      await deleteFaces({ collectionId, faceIds: toDelete });
    } catch (e: any) {
      console.warn("face-detector: deleteFaces (dedup) failed", String(e?.message ?? e));
    }
  }

  // Generate face crops while image bytes are still in memory.
  // Pass Landmarks from FaceDetail (attributes) so cropFace can use precise
  // hairline/chin coordinates instead of BoundingBox guesses.
  return await Promise.all(deduped.map(async (r) => {
    const landmarks = (r.attributes as any)?.Landmarks ?? null;
    return {
      bbox: r.bbox,
      description: "",
      confidence: r.confidence / 100,
      embedding: null,
      face_id: r.canonicalFaceId,  // always use the stable canonical face_id
      attributes: r.attributes,
      face_crop: r.bbox ? await cropFace(bytes, mime, r.bbox, landmarks) : null,
    };
  }));
}
