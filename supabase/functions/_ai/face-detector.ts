// deno-lint-ignore-file no-explicit-any
/**
 * Face detector backed by AWS Rekognition IndexFaces.
 *
 * Pipeline per asset:
 *   1. Fetch image; resize to < 3.75 MB if needed (Rekognition base64 limit).
 *   2. Ensure per-user Rekognition collection exists.
 *   3. Call IndexFaces with DetectionAttributes:ALL — returns FaceId + full
 *      FaceDetail (Pose, Quality, FaceOccluded, Landmarks).
 *   4. VALIDATION LOOP — double-check every detected face against ALL criteria:
 *        - confidence ≥ 0.6
 *        - |Yaw| ≤ 15°, |Pitch| ≤ 10°  (frontal only)
 *        - Sharpness ≥ 40, Brightness ≥ 25
 *        - FaceOccluded = false
 *      Faces that fail are immediately deleted from the collection so they
 *      cannot pollute SearchFaces results. If a face fails we do NOT "try
 *      again" on the same image — the face is genuinely bad. But the asset
 *      stays eligible for re-scan so a better photo of the same person can
 *      be processed later.
 *   5. Dedup: SearchFaces at 98% to find near-identical faces already in the
 *      collection (same physical face, different photo). Keep the NEW FaceId
 *      and delete the old one — this progressively purges stale pre-reset IDs.
 *   6. Crop each accepted face from the image and store as a 200×200 JPEG
 *      base64 data-URL so the People page can display the exact face pixel
 *      data instead of CSS-cropping a group-photo thumbnail.
 */
import {
  ensureCollection,
  indexFaces,
  searchFaces,
  deleteFaces,
  collectionIdForUser,
  rekognitionConfigured,
} from "./rekognition.ts";
import { isUsableFace } from "./face-quality.ts";

const REKOGNITION_MAX_BYTES = 3_750_000; // 5 MB base64 limit → ~3.75 MB raw
const DEDUP_SIMILARITY = 98;             // same face, different photo

export interface DetectedFace {
  bbox: { x: number; y: number; w: number; h: number } | null;
  description: string;
  confidence: number;   // 0..1
  embedding: number[] | null;
  face_id: string | null;
  attributes: Record<string, unknown> | null; // full Rekognition FaceDetail
  face_crop: string | null; // base64 data-URL 200×200 JPEG
}

// ---------------------------------------------------------------------------
// Image utilities
// ---------------------------------------------------------------------------

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
    return bytes; // OffscreenCanvas unavailable — send original, let Rekognition reject if too large
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

/**
 * Crop the face bbox region from image bytes and return as a 200×200 JPEG
 * base64 data-URL. Adds 10% margin on each side beyond the Rekognition bbox
 * for natural framing. Falls back to null when OffscreenCanvas is unavailable.
 */
async function cropFace(
  bytes: Uint8Array,
  mime: string,
  bbox: { x: number; y: number; w: number; h: number },
): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const W = bitmap.width, H = bitmap.height;
    const m = Math.max(bbox.w, bbox.h) * 0.10; // 10% margin
    const sx = Math.max(0, (bbox.x - m) * W);
    const sy = Math.max(0, (bbox.y - m) * H);
    const sw = Math.min(W - sx, (bbox.w + m * 2) * W);
    const sh = Math.min(H - sy, (bbox.h + m * 2) * H);
    const size = Math.min(200, Math.max(Math.round(sw), Math.round(sh)));
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, size, size);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    return `data:image/jpeg;base64,${btoa(String.fromCharCode(...buf))}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

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

  // Step 1: Index all faces Rekognition can find in this image.
  let records;
  try {
    records = await indexFaces({
      collectionId,
      imageBytes: bytes,
      externalImageId: opts.assetId,
      maxFaces: 100,
      qualityFilter: "AUTO",
    });
  } catch (e: any) {
    console.warn("face-detector: indexFaces failed", String(e?.message ?? e));
    return [];
  }

  // Step 2: VALIDATION LOOP — double-check every face against ALL criteria.
  // Faces that fail are deleted from the collection immediately so they cannot
  // corrupt SearchFaces results used for identity matching.
  const rejected: string[] = [];
  const accepted = records.filter((r) => {
    const passes = isUsableFace({
      confidence: r.confidence / 100,
      attributes: r.attributes as Record<string, any> | null,
    });
    if (!passes && r.faceId) rejected.push(r.faceId);
    return passes;
  });

  if (rejected.length > 0) {
    try {
      await deleteFaces({ collectionId, faceIds: rejected });
    } catch (e: any) {
      console.warn("face-detector: deleteFaces (validation) failed", String(e?.message ?? e));
    }
  }

  if (accepted.length === 0) return [];

  // Step 3: Dedup — keep NEW FaceId, delete OLD. This purges stale pre-reset
  // collection entries that would otherwise cause SearchFaces mismatches.
  const toDelete: string[] = [];
  const seen = new Set<string>();
  const finalRecords = await Promise.all(accepted.map(async (r) => {
    try {
      const matches = await searchFaces({
        collectionId, faceId: r.faceId,
        faceMatchThreshold: DEDUP_SIMILARITY, maxFaces: 5,
      });
      const existing = matches
        .filter((m) => m.faceId !== r.faceId && !seen.has(m.faceId))
        .sort((a, b) => b.similarity - a.similarity)[0];
      if (existing) {
        toDelete.push(existing.faceId); // delete OLD stale ID
        seen.add(r.faceId);
        return { ...r, deduped: true };
      }
    } catch (e: any) {
      console.warn("face-detector: dedup search failed", r.faceId, String(e?.message ?? e));
    }
    seen.add(r.faceId);
    return { ...r, deduped: false };
  }));

  if (toDelete.length > 0) {
    try {
      await deleteFaces({ collectionId, faceIds: toDelete });
    } catch (e: any) {
      console.warn("face-detector: deleteFaces (dedup) failed", String(e?.message ?? e));
    }
  }

  // Step 4: Generate face crops while image bytes are still in memory.
  return await Promise.all(finalRecords.map(async (r) => ({
    bbox: r.bbox,
    description: "",
    confidence: r.confidence / 100,
    embedding: null, // Rekognition identity matching via SearchFaces — no text embedding needed
    face_id: r.faceId,
    attributes: r.attributes,
    face_crop: r.bbox ? await cropFace(bytes, mime, r.bbox) : null,
  })));
}
