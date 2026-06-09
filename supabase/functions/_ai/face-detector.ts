// deno-lint-ignore-file no-explicit-any
/**
 * Face detector backed by AWS Rekognition.
 *
 * For each asset:
 *   1. Fetches the image bytes from the signed thumbnail/preview URL.
 *   2. Resizes the image if it exceeds Rekognition's 5 MB base64 limit
 *      (~3.75 MB raw) using OffscreenCanvas — no face is silently dropped
 *      just because the source image is large.
 *   3. Ensures the per-user collection exists.
 *   4. Calls IndexFaces — detects all faces AND indexes them in the
 *      collection. Returns a FaceId per face, used downstream by
 *      clusterPeople (SearchFaces) for real identity matching.
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

// Rekognition accepts images up to 5 MB of base64, which is ~3.75 MB raw.
const REKOGNITION_MAX_BYTES = 3_750_000;

// Similarity (%) above which two Rekognition FaceIds are treated as the
// same physical face when deduplicating a fresh IndexFaces batch.
const DEDUP_SIMILARITY = 98;

export interface DetectedFace {
  bbox: { x: number; y: number; w: number; h: number } | null;
  description: string;
  confidence: number;     // 0..1
  embedding: number[] | null;
  face_id: string | null; // AWS Rekognition FaceId
  attributes: Record<string, unknown> | null; // Full Rekognition FaceDetail JSON
}

/**
 * Resize an image so its raw byte count fits within maxBytes.
 * Uses the Web platform OffscreenCanvas API available in Deno edge runtime.
 * Falls back to the original bytes when the API is unavailable (e.g. unit tests).
 */
async function resizeToFit(bytes: Uint8Array, mime: string, maxBytes: number): Promise<Uint8Array> {
  if (bytes.byteLength <= maxBytes) return bytes;

  // Scale area proportionally, then take 10% extra margin for encoder overhead.
  const scale = Math.sqrt(maxBytes / bytes.byteLength) * 0.90;

  try {
    const blob = new Blob([bytes], { type: mime });
    const bitmap = await createImageBitmap(blob);
    const w = Math.max(1, Math.floor(bitmap.width * scale));
    const h = Math.max(1, Math.floor(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const resized = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.90 });
    const out = new Uint8Array(await resized.arrayBuffer());
    console.log(`face-detector: resized ${bytes.byteLength} → ${out.byteLength} bytes (scale ${scale.toFixed(2)})`);
    // Recurse once in case JPEG encoder output still exceeds limit.
    if (out.byteLength > maxBytes) return resizeToFit(out, "image/jpeg", maxBytes);
    return out;
  } catch (e: any) {
    // OffscreenCanvas not available — send original; Rekognition will reject
    // oversized images with an error we'll catch upstream.
    console.warn("face-detector: canvas resize unavailable, sending original", String(e?.message ?? e));
    return bytes;
  }
}

async function fetchAndPrepareImage(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch image ${resp.status}`);
  const mime = resp.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/jpeg";
  const raw = new Uint8Array(await resp.arrayBuffer());
  const bytes = await resizeToFit(raw, mime, REKOGNITION_MAX_BYTES);
  return { bytes, mime };
}

export async function detectFaces(opts: {
  imageUrl: string;
  userId: string;
  assetId: string;
}): Promise<DetectedFace[]> {
  if (!rekognitionConfigured()) {
    console.warn("face-detector: AWS Rekognition not configured — skipping");
    return [];
  }

  let bytes: Uint8Array;
  try {
    ({ bytes } = await fetchAndPrepareImage(opts.imageUrl));
  } catch (e: any) {
    console.warn("face-detector: image fetch/prepare failed", String(e?.message ?? e));
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
      qualityFilter: "AUTO",
    });
  } catch (e: any) {
    console.warn("face-detector: indexFaces failed", String(e?.message ?? e));
    return [];
  }

  // Filter only by the shared quality gate (occlusion, pose, sharpness, brightness).
  // We trust Rekognition's BoundingBox and Confidence for all other face attributes
  // — no custom area or side-length rejection here.
  const rejectedFaceIds: string[] = [];
  const acceptedRecords: typeof records = [];
  for (const r of records) {
    if (isUsableFace({ confidence: (r.confidence ?? 0) / 100, attributes: r.attributes ?? null })) {
      acceptedRecords.push(r);
    } else if (r.faceId) {
      rejectedFaceIds.push(r.faceId);
    }
  }
  if (rejectedFaceIds.length > 0) {
    try {
      await deleteFaces({ collectionId, faceIds: rejectedFaceIds });
    } catch (e: any) {
      console.warn("face-detector: deleteFaces (quality) failed", String(e?.message ?? e));
    }
  }
  records = acceptedRecords;

  // De-duplicate: for each newly-indexed face, check whether a nearly-identical
  // face already exists in the collection (same physical face, different photo).
  // When found, reuse the existing FaceId so clusterPeople doesn't create a
  // duplicate person row.
  const dedupedFaceIds = new Set<string>();
  const toDelete: string[] = [];
  const finalRecords = await Promise.all(records.map(async (r) => {
    try {
      const matches = await searchFaces({
        collectionId,
        faceId: r.faceId,
        faceMatchThreshold: DEDUP_SIMILARITY,
        maxFaces: 5,
      });
      const existing = matches
        .filter((m) => m.faceId !== r.faceId && !dedupedFaceIds.has(m.faceId))
        .sort((a, b) => b.similarity - a.similarity)[0];
      if (existing) {
        toDelete.push(r.faceId);
        dedupedFaceIds.add(existing.faceId);
        return { ...r, faceId: existing.faceId, deduped: true as const };
      }
    } catch (e: any) {
      console.warn("face-detector: dedup search failed", r.faceId, String(e?.message ?? e));
    }
    return { ...r, deduped: false as const };
  }));

  if (toDelete.length > 0) {
    try {
      await deleteFaces({ collectionId, faceIds: toDelete });
    } catch (e: any) {
      console.warn("face-detector: deleteFaces (dedup) failed", String(e?.message ?? e));
    }
  }

  return finalRecords.map((r) => ({
    bbox: r.bbox,
    description: "",
    confidence: r.confidence / 100,
    embedding: null,
    face_id: r.faceId,
    attributes: r.attributes,
  }));
}
