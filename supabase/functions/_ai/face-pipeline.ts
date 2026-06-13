// deno-lint-ignore-file no-explicit-any
/**
 * Face detection & storage pipeline — five small, single-purpose functions.
 *
 *   1. analyzeAssetFaces      — call Rekognition IndexFaces, return raw face JSON
 *   2. parseDetectedFaces     — parse raw response into one JSON object per face
 *   3. qualifyFaceForPerson   — quality gate: FaceOccluded=false AND confidence>90%
 *   4. findBestPersonMatch    — Rekognition SearchFaces against existing people
 *   5. storeFaceResults       — persist to asset_ai_enrichment, asset_faces, people
 *
 * enrichAI calls 1 → 2 → 5; storeFaceResults applies 3 and 4 per face when
 * assigning faces to the people table.
 */
import {
  ensureCollection,
  indexFaces,
  searchFaces,
  deleteFaces,
  collectionIdForUser,
  rekognitionConfigured,
} from "./rekognition.ts";
import { serviceClient } from "../_pipeline/clients.ts";
import { isUsableIndexedFace } from "./face-quality.ts";

const REKOGNITION_MAX_BYTES = 3_750_000;
const DEDUP_SIMILARITY = 90;   // reuse existing indexed face only at 90%+ similarity
const PRIMARY_THRESHOLD = 90;  // confident person match
const FALLBACK_THRESHOLD = 90; // acceptable person match
const MIN_PERSON_CONFIDENCE = 0.90; // function 3 gate (0..1 scale)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw analysis result from function 1. */
export interface FaceAnalysis {
  assetId: string;
  userId: string;
  collectionId: string;
  /** Raw Rekognition face records (FaceId + BoundingBox + full FaceDetail). */
  faceRecords: Array<Record<string, unknown>>;
  /** Image bytes kept in memory so parseDetectedFaces can generate crops. */
  imageBytes: Uint8Array;
  imageMime: string;
}

/** One face, parsed by function 2. */
export interface ParsedFace {
  face_id: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  confidence: number; // 0..1
  attributes: Record<string, unknown> | null; // full FaceDetail JSON
  face_crop: string | null; // landmark-cropped JPEG data-URL
}

/** Person match result from function 4. */
export interface PersonMatch {
  personId: string;
  similarity: number; // 0..100 Rekognition similarity
}

// ---------------------------------------------------------------------------
// Image helpers (fetch / resize / landmark crop)
// ---------------------------------------------------------------------------

async function resizeToFit(bytes: Uint8Array, mime: string, maxBytes: number): Promise<Uint8Array> {
  if (bytes.byteLength <= maxBytes) return bytes;
  const scale = Math.sqrt(maxBytes / bytes.byteLength) * 0.90;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mime }));
    const w = Math.max(1, Math.floor(bitmap.width * scale));
    const h = Math.max(1, Math.floor(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d") as any;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.90 });
    const out = new Uint8Array(await blob.arrayBuffer());
    return out.byteLength > maxBytes ? resizeToFit(out, "image/jpeg", maxBytes) : out;
  } catch {
    return bytes;
  }
}

async function fetchImage(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const mime = resp.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/jpeg";
    const raw = new Uint8Array(await resp.arrayBuffer());
    const bytes = await resizeToFit(raw, mime, REKOGNITION_MAX_BYTES);
    return { bytes, mime };
  } catch {
    return null;
  }
}

function findLandmark(landmarks: any[], type: string): { x: number; y: number } | null {
  const lm = landmarks?.find((l: any) => l.Type === type);
  return lm ? { x: Number(lm.X), y: Number(lm.Y) } : null;
}

/**
 * Crop a face using Rekognition Landmarks (upperJawlineLeft/Right → chinBottom)
 * for hairline-to-chin framing; falls back to padded BoundingBox.
 */
async function cropFace(
  bytes: Uint8Array,
  mime: string,
  bbox: { x: number; y: number; w: number; h: number },
  landmarks?: any[] | null,
): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mime }));
    const W = bitmap.width, H = bitmap.height;

    let left: number, right: number, top: number, bottom: number;

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
      // 35% side padding, 70% above for hair, 15% below chin.
      left   = faceLeft   - faceW * 0.35;
      right  = faceRight  + faceW * 0.35;
      top    = faceTop    - faceH * 0.70;
      bottom = faceBottom + faceH * 0.15;
    } else {
      const faceCx = (bbox.x + bbox.w / 2) * W;
      const faceCy = (bbox.y + bbox.h / 2) * H;
      const faceW  = bbox.w * W;
      const faceH  = bbox.h * H;
      left   = faceCx - faceW * 0.80;
      right  = faceCx + faceW * 0.80;
      top    = faceCy - faceH * 1.00;
      bottom = faceCy + faceH * 0.80;
    }

    // Expand to a square from center — never stretch.
    const cx   = (left + right) / 2;
    const cy   = (top  + bottom) / 2;
    const half = Math.max(right - left, bottom - top) / 2;
    const sx = Math.max(0, cx - half);
    const sy = Math.max(0, cy - half);
    const sw = Math.min(W, cx + half) - sx;
    const sh = Math.min(H, cy + half) - sy;

    const size = Math.min(300, Math.round(Math.max(sw, sh)));
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d") as any;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, size, size);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let b64 = "";
    for (let i = 0; i < buf.length; i += 8192) b64 += String.fromCharCode(...buf.subarray(i, i + 8192));
    return `data:image/jpeg;base64,${btoa(b64)}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. analyzeAssetFaces
// ---------------------------------------------------------------------------

/**
 * Call the Rekognition analysis API for one asset and return the raw JSON of
 * all detected faces (FaceId + BoundingBox + full FaceDetail per face).
 *
 * Image source preference: preview → thumbnail → original. Preview is the
 * right size for Rekognition; original may exceed the 3.75 MB byte limit and
 * is resized when used.
 *
 * Re-scans are idempotent: a newly indexed face that matches an existing
 * collection entry at ≥98% similarity is deleted and the existing (canonical)
 * FaceId is kept, so person links never fragment.
 */
export async function analyzeAssetFaces(opts: {
  originalImageUrl: string | null;
  previewImageUrl: string | null;
  thumbnailImageUrl: string | null;
  assetId: string;
  userId: string;
}): Promise<FaceAnalysis | null> {
  if (!rekognitionConfigured()) {
    console.warn("analyzeAssetFaces: Rekognition not configured", { assetId: opts.assetId });
    return null;
  }

  let image: { bytes: Uint8Array; mime: string } | null = null;
  for (const url of [opts.previewImageUrl, opts.thumbnailImageUrl, opts.originalImageUrl]) {
    if (!url) continue;
    image = await fetchImage(url);
    if (image) break;
  }
  if (!image) throw new Error(`retryable: analyzeAssetFaces: no fetchable image for asset ${opts.assetId}`);

  const collectionId = collectionIdForUser(opts.userId);
  await ensureCollection(collectionId);

  const sb = serviceClient();
  const { data: knownRows } = await sb
    .from("asset_faces")
    .select("face")
    .eq("user_id", opts.userId);
  const validKnownFaceIds = new Set(
    (knownRows ?? [])
      .map((row: any) => row?.face)
      .filter((face: any) => isUsableIndexedFace(face))
      .map((face: any) => String(face?.FaceId ?? ""))
      .filter(Boolean),
  );

  const records = await indexFaces({
    collectionId,
    imageBytes: image.bytes,
    externalImageId: opts.assetId,
    maxFaces: 100,
    qualityFilter: "NONE", // index ALL detected faces; quality gating happens later
  });

  // Dedup against the collection: keep the OLD canonical FaceId.
  // Sequential (not Promise.all) — the `seen` set must be updated before the
  // next face is checked, otherwise two faces in the same photo can race and
  // both resolve to the same canonical FaceId, which then violates the unique
  // (asset_id, face_id) index and fails the whole asset_faces insert.
  const toDelete = new Set<string>();
  const seen = new Set<string>();
  const faceRecords: Array<Record<string, unknown>> = [];
  for (const r of records) {
    if (!isUsableIndexedFace({ Confidence: r.confidence, FaceDetail: r.attributes })) {
      toDelete.add(r.faceId);
      continue;
    }

    let canonicalFaceId = r.faceId;
    try {
      const matches = await searchFaces({
        collectionId, faceId: r.faceId,
        faceMatchThreshold: DEDUP_SIMILARITY, maxFaces: 5,
      });
      const existing = matches
        .filter((m) => {
          if (m.faceId === r.faceId || m.similarity < DEDUP_SIMILARITY || seen.has(m.faceId)) return false;
          if (validKnownFaceIds.has(m.faceId)) return true;
          toDelete.add(m.faceId);
          return false;
        })
        .sort((a, b) => b.similarity - a.similarity)[0];
      if (existing) {
        toDelete.add(r.faceId);
        canonicalFaceId = existing.faceId;
      }
    } catch (e: any) {
      console.warn("analyzeAssetFaces: dedup search failed", r.faceId, String(e?.message ?? e));
    }
    if (seen.has(canonicalFaceId)) continue; // same physical face already recorded for this asset
    seen.add(canonicalFaceId);
    faceRecords.push({
      FaceId: canonicalFaceId,
      BoundingBox: r.bbox,
      Confidence: r.confidence, // 0-100 as returned by Rekognition
      FaceDetail: r.attributes,
    });
  }

  if (toDelete.size > 0) {
    try {
      await deleteFaces({ collectionId, faceIds: Array.from(toDelete) });
    } catch (e: any) {
      console.warn("analyzeAssetFaces: dedup deleteFaces failed", String(e?.message ?? e));
    }
  }

  return {
    assetId: opts.assetId,
    userId: opts.userId,
    collectionId,
    faceRecords,
    imageBytes: image.bytes,
    imageMime: image.mime,
  };
}

// ---------------------------------------------------------------------------
// 2. parseDetectedFaces
// ---------------------------------------------------------------------------

/**
 * Parse the raw analysis into one JSON object per face: stable face_id,
 * normalized bbox, confidence on a 0..1 scale, full FaceDetail attributes,
 * and a landmark-based face crop generated while the image bytes are in memory.
 */
export async function parseDetectedFaces(analysis: FaceAnalysis): Promise<ParsedFace[]> {
  return await Promise.all(analysis.faceRecords.map(async (rec) => {
    const bbox = (rec.BoundingBox ?? null) as ParsedFace["bbox"];
    const attributes = (rec.FaceDetail ?? null) as Record<string, unknown> | null;
    const landmarks = (attributes as any)?.Landmarks ?? null;
    return {
      face_id: String(rec.FaceId),
      bbox,
      confidence: Number(rec.Confidence ?? 0) / 100,
      attributes,
      face_crop: bbox ? await cropFace(analysis.imageBytes, analysis.imageMime, bbox, landmarks) : null,
    };
  }));
}

// ---------------------------------------------------------------------------
// 3. qualifyFaceForPerson
// ---------------------------------------------------------------------------

/**
 * Quality gate for the people table: a face qualifies only when
 * FaceOccluded is false AND detection confidence is above 90%.
 * Returns the face unchanged when it qualifies, null otherwise.
 */
export function qualifyFaceForPerson(face: ParsedFace): ParsedFace | null {
  return isUsableIndexedFace({
    Confidence: face.confidence * 100,
    FaceDetail: face.attributes ?? {},
  }) ? face : null;
}

// ---------------------------------------------------------------------------
// 4. findBestPersonMatch
// ---------------------------------------------------------------------------

/**
 * Compare one face against all faces already assigned to people via
 * Rekognition SearchFaces and return the best-matching person, or null when
 * no existing person matches above threshold (caller then creates a new one).
 *
 * `faceIdToPersonId` maps every rekognition_face_id already on a people row
 * to its person id (built once per run by the caller).
 */
export async function findBestPersonMatch(
  face: ParsedFace,
  ctx: { collectionId: string; faceIdToPersonId: Map<string, string> },
): Promise<PersonMatch | null> {
  let matches: Array<{ faceId: string; similarity: number }> = [];
  try {
    matches = await searchFaces({
      collectionId: ctx.collectionId,
      faceId: face.face_id,
      faceMatchThreshold: FALLBACK_THRESHOLD,
      maxFaces: 10,
    });
  } catch (e: any) {
    console.warn("findBestPersonMatch: SearchFaces failed", face.face_id, String(e?.message ?? e));
    return null;
  }

  const sorted = matches
    .filter((m) => m.faceId !== face.face_id && m.similarity >= PRIMARY_THRESHOLD && ctx.faceIdToPersonId.has(m.faceId))
    .sort((a, b) => b.similarity - a.similarity);

  const best = sorted[0] ?? null;
  if (!best) return null;
  return { personId: ctx.faceIdToPersonId.get(best.faceId)!, similarity: best.similarity };
}

// ---------------------------------------------------------------------------
// 5. storeFaceResults
// ---------------------------------------------------------------------------

/**
 * Persist one asset's face detection results to asset_faces only.
 * People clustering is intentionally NOT done here — it is the exclusive
 * responsibility of clusterPeople, which runs as a serialised per-user job
 * after enrichAI completes.
 *
 * Keeping the two writes separate eliminates the race condition that caused
 * duplicate people records: concurrent enrichAI jobs can safely write to
 * asset_faces in parallel (delete+insert is idempotent per asset_id) without
 * touching the people table at all.
 *
 *   a. asset_faces — one row per parsed face; existing rows for this asset
 *      are replaced (delete + insert) so re-scans are idempotent.
 *
 * Returns the number of face rows written.
 */
export async function storeFaceResults(opts: {
  analysis: FaceAnalysis;
  faces: ParsedFace[];
  beforeWrite?: () => Promise<void>;
}): Promise<{ asset_faces: number }> {
  const sb = serviceClient();
  const { analysis, faces } = opts;
  const { assetId, userId } = analysis;

  if (opts.beforeWrite) await opts.beforeWrite();

  // Delete existing rows for this asset so re-scans are idempotent.
  const { error: delErr } = await sb.from("asset_faces").delete().eq("asset_id", assetId);
  if (delErr) throw new Error(`storeFaceResults: asset_faces delete failed: ${delErr.message}`);

  // Deduplicate by face_id within this asset.
  const uniqueFaces = [...new Map(faces.map((f) => [f.face_id, f])).values()];

  if (uniqueFaces.length > 0) {
    if (opts.beforeWrite) await opts.beforeWrite();
    // Each row stores one unified face JSON with all Rekognition attributes + generated crop.
    const { error: insErr } = await sb.from("asset_faces").insert(uniqueFaces.map((f) => ({
      asset_id: assetId,
      user_id:  userId,
      face: {
        FaceId:      f.face_id,
        BoundingBox: f.bbox,
        Confidence:  Math.round(f.confidence * 1000) / 10, // normalize back to 0-100 scale
        FaceDetail:  f.attributes ?? {},
        FaceCrop:    f.face_crop,
      },
    })));
    if (insErr) throw new Error(`storeFaceResults: asset_faces insert failed: ${insErr.message}`);
  }

  return { asset_faces: uniqueFaces.length };
}
