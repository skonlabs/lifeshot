// deno-lint-ignore-file no-explicit-any
/**
 * Face detector backed by AWS Rekognition IndexFaces.
 *
 * Industry-standard pipeline:
 *   1. Fetch image; resize to < 3.75 MB if needed (Rekognition base64 limit).
 *   2. Ensure per-user Rekognition collection exists.
 *   3. Call IndexFaces (qualityFilter AUTO, DetectionAttributes ALL).
 *      AUTO lets Rekognition decide what's indexable — no manual pre-filtering.
 *   4. Dedup at 98%: keep NEW FaceId, delete OLD stale entries so the collection
 *      stays clean across re-scans.
 *   5. Crop each face to a 200×200 JPEG data-URL for avatar display.
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
  face_crop: string | null; // 200×200 JPEG base64 data-URL
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

async function cropFace(
  bytes: Uint8Array,
  mime: string,
  bbox: { x: number; y: number; w: number; h: number },
): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const W = bitmap.width, H = bitmap.height;
    const m = Math.max(bbox.w, bbox.h) * 0.10;
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
      qualityFilter: "AUTO",
    });
  } catch (e: any) {
    console.warn("face-detector: indexFaces failed", String(e?.message ?? e));
    return [];
  }

  if (records.length === 0) return [];

  // Dedup: when the same physical face already exists in the collection from a
  // previous scan, keep the NEW FaceId and delete the OLD one. This prevents
  // the collection from accumulating duplicate entries across re-scans.
  const toDelete: string[] = [];
  const seen = new Set<string>();
  const finalRecords = await Promise.all(records.map(async (r) => {
    try {
      const matches = await searchFaces({
        collectionId, faceId: r.faceId,
        faceMatchThreshold: DEDUP_SIMILARITY, maxFaces: 5,
      });
      const existing = matches
        .filter((m) => m.faceId !== r.faceId && !seen.has(m.faceId))
        .sort((a, b) => b.similarity - a.similarity)[0];
      if (existing) {
        toDelete.push(existing.faceId);
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

  // Generate face crops while image bytes are still in memory.
  return await Promise.all(finalRecords.map(async (r) => ({
    bbox: r.bbox,
    description: "",
    confidence: r.confidence / 100,
    embedding: null,
    face_id: r.faceId,
    attributes: r.attributes,
    face_crop: r.bbox ? await cropFace(bytes, mime, r.bbox) : null,
  })));
}
