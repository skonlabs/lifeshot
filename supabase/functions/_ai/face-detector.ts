// deno-lint-ignore-file no-explicit-any
/**
 * Real face detector using GPT-4o Vision.
 * Returns faces with bounding boxes (0-1 fractions of image dimensions) and
 * neutral text descriptions suitable for embedding as identity proxies.
 */
import { visionStructured, embedBatch, type CallContext } from "./client.ts";
import { FACE_DETECT_PROMPT } from "./prompts.ts";
import { FaceDetectResultZ, FACE_DETECT_JSON_SCHEMA, type FaceDetectResult } from "./schemas.ts";
import { intersectionOverUnion, sanitizeFaceBox } from "../_shared/face-box.ts";

export type { FaceDetectResult };

export interface DetectedFace {
  bbox: { x: number; y: number; w: number; h: number } | null;
  description: string;
  confidence: number;
  embedding: number[] | null;
}

/**
 * Detect faces in an image URL and return them with 512-dim embeddings.
 * Uses GPT-4o-mini vision for detection + text-embedding-3-small (512d) for embeddings.
 */
export async function detectFaces(opts: {
  imageUrl: string;
  ctx?: CallContext;
}): Promise<DetectedFace[]> {
  let result: FaceDetectResult;
  try {
    const { data } = await visionStructured<FaceDetectResult>({
      imageUrl: opts.imageUrl,
      prompt: FACE_DETECT_PROMPT,
      schema: FACE_DETECT_JSON_SCHEMA,
      parse: (raw) => FaceDetectResultZ.parse(raw),
      ctx: opts.ctx,
      maxTokens: 400,
    });
    result = data;
  } catch (e: any) {
    console.warn("face-detector: vision call failed", String(e?.message ?? e));
    return [];
  }

  if (!result.faces.length) return [];

  const cleanedFaces = result.faces
    .map((face) => ({
      bbox: sanitizeFaceBox(face.bbox),
      description: face.description,
      confidence: face.confidence,
    }))
    .filter((face) => face.bbox && face.confidence >= 0.78)
    .sort((a, b) => {
      const confDelta = (b.confidence ?? 0) - (a.confidence ?? 0);
      if (confDelta !== 0) return confDelta;
      const areaA = (a.bbox?.w ?? 0) * (a.bbox?.h ?? 0);
      const areaB = (b.bbox?.w ?? 0) * (b.bbox?.h ?? 0);
      return areaB - areaA;
    })
    .filter((face, index, arr) => arr.findIndex((candidate, candidateIndex) => {
      if (candidateIndex >= index) return false;
      return intersectionOverUnion(candidate.bbox, face.bbox) >= 0.55;
    }) === -1)
    .slice(0, 8);

  if (!cleanedFaces.length) return [];

  // Embed descriptions as 512-dim vectors to use as coarse identity proxies.
  // This is not true face recognition, so downstream code must treat it as a
  // weak signal and rely on sanitized bboxes + conservative matching.
  const descriptions = cleanedFaces.map((f) => f.description || "person face");
  let embeddings: number[][] = [];
  try {
    embeddings = await embedBatch(descriptions, { dimensions: 512, ctx: opts.ctx });
  } catch (e: any) {
    console.warn("face-detector: embedding failed", String(e?.message ?? e));
    // Continue without embeddings rather than failing the whole detection.
    embeddings = cleanedFaces.map(() => []);
  }

  return cleanedFaces.map((face, i) => ({
    bbox: face.bbox,
    description: face.description,
    confidence: face.confidence,
    embedding: embeddings[i]?.length ? embeddings[i] : null,
  }));
}
