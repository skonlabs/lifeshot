// deno-lint-ignore-file no-explicit-any
/**
 * AWS Rekognition client (Edge-runtime compatible).
 *
 * Capabilities used:
 *  - CreateCollection (idempotent — ignores ResourceAlreadyExistsException)
 *  - IndexFaces       — detects + adds faces to a per-user collection,
 *                       returns FaceId + bounding box + confidence
 *  - SearchFaces      — given a FaceId, finds matching FaceIds in collection
 *  - DeleteFaces      — cleanup
 *
 * Collection naming: `lifeshot-user-<uuid>` (per-user isolation, matches
 * Rekognition collection ID constraints: [a-zA-Z0-9_.\-]+).
 */
import { signAwsJson } from "./aws-sigv4.ts";

function env(name: string): string | undefined {
  if (typeof Deno !== "undefined") return Deno.env.get(name) ?? undefined;
  return (globalThis as any).process?.env?.[name];
}

function creds() {
  const accessKeyId = env("AWS_REKOGNITION_ACCESS_KEY_ID");
  const secretAccessKey = env("AWS_REKOGNITION_SECRET_ACCESS_KEY");
  const region = env("AWS_REKOGNITION_REGION") ?? "us-east-1";
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, region };
}

export function rekognitionConfigured(): boolean {
  return !!creds();
}

export function collectionIdForUser(userId: string): string {
  // Rekognition collection IDs allow [a-zA-Z0-9_.\-]+ up to 255 chars.
  // UUIDs already match; we just prefix for namespacing.
  return `lifeshot-user-${userId}`;
}

async function call<T>(target: string, body: unknown): Promise<T> {
  const c = creds();
  if (!c) throw new Error("AWS Rekognition credentials not configured");
  const signed = await signAwsJson({
    service: "rekognition",
    region: c.region,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    target,
    body,
  });
  const resp = await fetch(signed.url, { method: "POST", headers: signed.headers, body: signed.body });
  const text = await resp.text();
  if (!resp.ok) {
    // Parse AWS error body for the __type field.
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* noop */ }
    const code = parsed?.__type ?? `HTTP_${resp.status}`;
    const message = parsed?.message ?? parsed?.Message ?? text.slice(0, 500);
    const err = new Error(`Rekognition ${target} failed: ${code}: ${message}`) as Error & { code?: string };
    err.code = String(code);
    throw err;
  }
  return text ? JSON.parse(text) as T : ({} as T);
}

export async function ensureCollection(collectionId: string): Promise<void> {
  try {
    await call<unknown>("RekognitionService.CreateCollection", { CollectionId: collectionId });
  } catch (e: any) {
    // Idempotent — collection may already exist.
    if (typeof e?.code === "string" && /ResourceAlreadyExistsException/.test(e.code)) return;
    throw e;
  }
}

export interface RekFaceRecord {
  faceId: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;     // 0-100
  /** Full Rekognition FaceDetail JSON (age, gender, emotions, landmarks, pose, etc.). */
  attributes: Record<string, unknown> | null;
}

/**
 * IndexFaces — detects all faces in the image (passed as bytes) and stores
 * them in the given collection. Returns one record per indexed face.
 * MaxFaces defaults to 15 (Rekognition hard limit per call is 100).
 */
export async function indexFaces(opts: {
  collectionId: string;
  imageBytes: Uint8Array;
  externalImageId?: string;
  maxFaces?: number;
  qualityFilter?: "NONE" | "AUTO" | "LOW" | "MEDIUM" | "HIGH";
}): Promise<RekFaceRecord[]> {
  // Rekognition accepts up to 5 MiB of Image.Bytes (base64 expands ~33%).
  const b64 = btoa(String.fromCharCode(...opts.imageBytes));
  const body: Record<string, unknown> = {
    CollectionId: opts.collectionId,
    Image: { Bytes: b64 },
    DetectionAttributes: ["ALL"],
    MaxFaces: opts.maxFaces ?? 15,
    QualityFilter: opts.qualityFilter ?? "AUTO",
  };
  if (opts.externalImageId) {
    // Allowed chars: [a-zA-Z0-9_.\-:]+
    body.ExternalImageId = opts.externalImageId.replace(/[^a-zA-Z0-9_.\-:]/g, "_");
  }
  const res = await call<{ FaceRecords?: Array<{ Face: any; FaceDetail: any }> }>(
    "RekognitionService.IndexFaces", body,
  );
  return (res.FaceRecords ?? []).map((rec) => {
    const bb = rec.Face?.BoundingBox ?? rec.FaceDetail?.BoundingBox ?? {};
    return {
      faceId: String(rec.Face?.FaceId ?? ""),
      bbox: {
        x: Number(bb.Left ?? 0),
        y: Number(bb.Top ?? 0),
        w: Number(bb.Width ?? 0),
        h: Number(bb.Height ?? 0),
      },
      confidence: Number(rec.Face?.Confidence ?? rec.FaceDetail?.Confidence ?? 0),
      attributes: (rec.FaceDetail ?? null) as Record<string, unknown> | null,
    };
  }).filter((r) => r.faceId.length > 0);
}

/** SearchFaces — find faces matching the given FaceId within the collection. */
export async function searchFaces(opts: {
  collectionId: string;
  faceId: string;
  faceMatchThreshold?: number; // 0-100, default 80
  maxFaces?: number;            // default 10
}): Promise<Array<{ faceId: string; similarity: number }>> {
  try {
    const res = await call<{ FaceMatches?: Array<{ Face: any; Similarity: number }> }>(
      "RekognitionService.SearchFaces",
      {
        CollectionId: opts.collectionId,
        FaceId: opts.faceId,
        FaceMatchThreshold: opts.faceMatchThreshold ?? 80,
        MaxFaces: opts.maxFaces ?? 10,
      },
    );
    return (res.FaceMatches ?? []).map((m) => ({
      faceId: String(m.Face?.FaceId ?? ""),
      similarity: Number(m.Similarity ?? 0),
    })).filter((m) => m.faceId.length > 0);
  } catch (e: any) {
    // Collection may not exist yet, or face not found — treat as no matches.
    if (typeof e?.code === "string" && /ResourceNotFoundException|InvalidParameterException/.test(e.code)) {
      return [];
    }
    throw e;
  }
}

/** DeleteFaces — remove FaceIds from a collection. */
export async function deleteFaces(opts: { collectionId: string; faceIds: string[] }): Promise<void> {
  if (!opts.faceIds.length) return;
  await call("RekognitionService.DeleteFaces", { CollectionId: opts.collectionId, FaceIds: opts.faceIds });
}