// deno-lint-ignore-file no-explicit-any
/**
 * Face detector backed by AWS Rekognition.
 *
 * For each asset:
 *   1. Fetches the image bytes from the signed thumbnail/preview URL.
 *   2. Ensures the per-user collection exists.
 *   3. Calls IndexFaces — detects all faces AND indexes them in the
 *      collection. Returns a FaceId per face, used downstream by
 *      clusterPeople (SearchFaces) for real identity matching.
 */
import { ensureCollection, indexFaces, collectionIdForUser, rekognitionConfigured } from "./rekognition.ts";

export interface DetectedFace {
  bbox: { x: number; y: number; w: number; h: number } | null;
  description: string;
  confidence: number;     // 0..1
  embedding: number[] | null;
  face_id: string | null; // AWS Rekognition FaceId
}

async function fetchImageBytes(url: string, maxBytes = 5 * 1024 * 1024): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch image ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new Error(`image too large for Rekognition: ${buf.byteLength} bytes (max ${maxBytes})`);
  }
  return buf;
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
    bytes = await fetchImageBytes(opts.imageUrl);
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
      maxFaces: 15,
      qualityFilter: "AUTO",
    });
  } catch (e: any) {
    console.warn("face-detector: indexFaces failed", String(e?.message ?? e));
    return [];
  }

  return records.map((r) => ({
    bbox: r.bbox,
    description: "",
    confidence: r.confidence / 100, // normalize to 0..1 for consistency with prior schema
    embedding: null,
    face_id: r.faceId,
  }));
}
