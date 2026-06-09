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
import {
  ensureCollection,
  indexFaces,
  searchFaces,
  deleteFaces,
  collectionIdForUser,
  rekognitionConfigured,
} from "./rekognition.ts";
import { isUsableFace } from "./face-quality.ts";

// Similarity (%) above which two Rekognition FaceIds are treated as the
// same physical face. 98 is intentionally strict — we only collapse a
// freshly-indexed face into an existing one when AWS is highly confident
// they are the same person from a very similar angle/lighting.
const DEDUP_SIMILARITY = 98;

export interface DetectedFace {
  bbox: { x: number; y: number; w: number; h: number } | null;
  description: string;
  confidence: number;     // 0..1
  embedding: number[] | null;
  face_id: string | null; // AWS Rekognition FaceId
  attributes: Record<string, unknown> | null; // Full Rekognition FaceDetail JSON
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
      maxFaces: 100, // Rekognition hard limit — detect every face in the photo
      qualityFilter: "AUTO",
    });
  } catch (e: any) {
    console.warn("face-detector: indexFaces failed", String(e?.message ?? e));
    return [];
  }

  // Quality gate BEFORE anything else: reject non-front-facing / low-quality
  // detections and DELETE their FaceIds from the AWS collection so they cannot
  // pollute future SearchFaces results. Same thresholds the rest of the
  // pipeline uses (see _ai/face-quality.ts).
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

  // De-duplicate against the collection: for each newly-indexed face, ask
  // Rekognition CompareFaces-style (SearchFaces) whether a very similar
  // face already exists. If so, drop the just-created FaceId and reuse
  // the existing one so downstream clustering doesn't create duplicate
  // person_faces rows for the same physical face.
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
      // Pick the best match that isn't the face we just indexed and that
      // we haven't already collapsed another new face onto in this batch.
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
    confidence: r.confidence / 100, // normalize to 0..1 for consistency with prior schema
    embedding: null,
    face_id: r.faceId,
    attributes: r.attributes,
  }));
}
