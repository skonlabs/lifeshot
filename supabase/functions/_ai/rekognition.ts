// deno-lint-ignore-file no-explicit-any
/**
 * AWS Rekognition client for face indexing, searching, and collection management.
 *
 * Uses IndexFaces (DetectionAttributes:ALL) which returns:
 *   - FaceId for SearchFaces comparison
 *   - BoundingBox for face location
 *   - FaceDetail with Pose (Yaw/Pitch/Roll), Quality (Sharpness/Brightness),
 *     FaceOccluded, Landmarks, AgeRange, Gender, Emotions
 */

function getCredentials() {
  // Prefer AWS_REKOGNITION_* (project-scoped names), fall back to bare AWS_*.
  const region =
    Deno.env.get("AWS_REKOGNITION_REGION") ??
    Deno.env.get("AWS_REGION") ??
    "us-east-1";
  const accessKeyId =
    Deno.env.get("AWS_REKOGNITION_ACCESS_KEY_ID") ??
    Deno.env.get("AWS_ACCESS_KEY_ID") ??
    "";
  const secretAccessKey =
    Deno.env.get("AWS_REKOGNITION_SECRET_ACCESS_KEY") ??
    Deno.env.get("AWS_SECRET_ACCESS_KEY") ??
    "";
  return { region, accessKeyId, secretAccessKey };
}

export function rekognitionConfigured(): boolean {
  const { accessKeyId, secretAccessKey } = getCredentials();
  return !!(accessKeyId && secretAccessKey);
}

export function collectionIdForUser(userId: string): string {
  return `lifeshot-${userId}`;
}

// ---------------------------------------------------------------------------
// AWS Signature V4 signing for Rekognition REST (JSON) API
// ---------------------------------------------------------------------------

async function hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
}

async function signedRequest(opts: {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  target: string; // e.g. "RekognitionService.IndexFaces"
  body: unknown;
}): Promise<any> {
  const { region, accessKeyId, secretAccessKey, target, body } = opts;
  const host = `rekognition.${region}.amazonaws.com`;
  const endpoint = `https://${host}/`;
  const payload = JSON.stringify(body);
  const payloadHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload))),
  ).map((b) => b.toString(16).padStart(2, "0")).join("");

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/rekognition/aws4_request`;

  const canonicalHeaders = `content-type:application/x-amz-json-1.1\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:${target}\n`;
  const signedHeaders = "content-type;host;x-amz-date;x-amz-target";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const canonicalHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest))),
  ).map((b) => b.toString(16).padStart(2, "0")).join("");

  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${canonicalHash}`;

  const enc = (s: string) => new TextEncoder().encode(s);
  const kDate = await hmac(enc(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "rekognition");
  const kSigning = await hmac(kService, "aws4_request");
  const sig = Array.from(new Uint8Array(await hmac(kSigning, stringToSign)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Date": amzDate,
      "X-Amz-Target": target,
      "Authorization": authHeader,
    },
    body: payload,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Rekognition ${target} failed (${resp.status}): ${err}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RekFaceRecord {
  faceId: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number; // 0-100
  attributes: Record<string, unknown> | null; // Full FaceDetail JSON
}

export async function ensureCollection(collectionId: string): Promise<void> {
  const { region, accessKeyId, secretAccessKey } = getCredentials();
  try {
    await signedRequest({
      region, accessKeyId, secretAccessKey,
      target: "RekognitionService.DescribeCollection",
      body: { CollectionId: collectionId },
    });
  } catch (e: any) {
    if (String(e?.message ?? "").includes("ResourceNotFoundException")) {
      await signedRequest({
        region, accessKeyId, secretAccessKey,
        target: "RekognitionService.CreateCollection",
        body: { CollectionId: collectionId },
      });
    } else {
      throw e;
    }
  }
}

export async function indexFaces(opts: {
  collectionId: string;
  imageBytes: Uint8Array;
  externalImageId: string;
  maxFaces: number;
  qualityFilter: "NONE" | "AUTO" | "LOW" | "MEDIUM" | "HIGH";
}): Promise<RekFaceRecord[]> {
  const { region, accessKeyId, secretAccessKey } = getCredentials();
  // btoa(String.fromCharCode(...bytes)) overflows the stack for large images.
  // Chunk it to avoid the spread-into-args limit.
  let b64 = "";
  const chunk = 8192;
  for (let i = 0; i < opts.imageBytes.length; i += chunk) {
    b64 += String.fromCharCode(...opts.imageBytes.subarray(i, i + chunk));
  }
  b64 = btoa(b64);
  const data = await signedRequest({
    region, accessKeyId, secretAccessKey,
    target: "RekognitionService.IndexFaces",
    body: {
      CollectionId: opts.collectionId,
      Image: { Bytes: b64 },
      ExternalImageId: opts.externalImageId,
      MaxFaces: opts.maxFaces,
      QualityFilter: opts.qualityFilter,
      DetectionAttributes: ["ALL"], // get Pose, Quality, FaceOccluded, Landmarks
    },
  });

  return (data.FaceRecords ?? []).map((rec: any) => {
    const bb = rec.Face?.BoundingBox ?? rec.FaceDetail?.BoundingBox ?? {};
    return {
      faceId: String(rec.Face?.FaceId ?? ""),
      bbox: {
        x: Number(bb.Left ?? 0),
        y: Number(bb.Top ?? 0),
        w: Number(bb.Width ?? 0),
        h: Number(bb.Height ?? 0),
      },
      confidence: Number(rec.Face?.Confidence ?? 0),
      attributes: rec.FaceDetail ?? null,
    };
  }).filter((r: RekFaceRecord) => r.faceId);
}

export async function searchFaces(opts: {
  collectionId: string;
  faceId: string;
  faceMatchThreshold: number;
  maxFaces: number;
}): Promise<Array<{ faceId: string; similarity: number }>> {
  const { region, accessKeyId, secretAccessKey } = getCredentials();
  const data = await signedRequest({
    region, accessKeyId, secretAccessKey,
    target: "RekognitionService.SearchFaces",
    body: {
      CollectionId: opts.collectionId,
      FaceId: opts.faceId,
      FaceMatchThreshold: opts.faceMatchThreshold,
      MaxFaces: opts.maxFaces,
    },
  });
  return (data.FaceMatches ?? []).map((m: any) => ({
    faceId: String(m.Face?.FaceId ?? ""),
    similarity: Number(m.Similarity ?? 0),
  }));
}

export async function deleteFaces(opts: {
  collectionId: string;
  faceIds: string[];
}): Promise<void> {
  if (!opts.faceIds.length) return;
  const { region, accessKeyId, secretAccessKey } = getCredentials();
  await signedRequest({
    region, accessKeyId, secretAccessKey,
    target: "RekognitionService.DeleteFaces",
    body: { CollectionId: opts.collectionId, FaceIds: opts.faceIds },
  });
}

export async function deleteCollection(collectionId: string): Promise<void> {
  const { region, accessKeyId, secretAccessKey } = getCredentials();
  try {
    await signedRequest({
      region, accessKeyId, secretAccessKey,
      target: "RekognitionService.DeleteCollection",
      body: { CollectionId: collectionId },
    });
  } catch (e: any) {
    // Already gone — that's fine.
    if (!String(e?.message ?? "").includes("ResourceNotFoundException")) throw e;
  }
}

/** Drop and recreate a collection, giving it a clean slate. */
export async function recreateCollection(collectionId: string): Promise<void> {
  await deleteCollection(collectionId);
  const { region, accessKeyId, secretAccessKey } = getCredentials();
  await signedRequest({
    region, accessKeyId, secretAccessKey,
    target: "RekognitionService.CreateCollection",
    body: { CollectionId: collectionId },
  });
}
