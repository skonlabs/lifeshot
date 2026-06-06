// deno-lint-ignore-file no-explicit-any
/**
 * Minimal AWS Signature V4 signer for Deno / Web Crypto.
 * Used to call AWS Rekognition without pulling in the AWS SDK
 * (which is Node-heavy and slow to cold-start in Edge runtime).
 */
const enc = new TextEncoder();

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const buf = typeof data === "string" ? enc.encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export interface SignedAwsRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface SignAwsOptions {
  service: string;     // e.g. "rekognition"
  region: string;      // e.g. "us-east-1"
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  target: string;      // e.g. "RekognitionService.IndexFaces"
  body: unknown;       // JSON-serializable
}

/** Sign an AWS JSON-1.1 POST request (the protocol used by Rekognition). */
export async function signAwsJson(opts: SignAwsOptions): Promise<SignedAwsRequest> {
  const host = `${opts.service}.${opts.region}.amazonaws.com`;
  const url = `https://${host}/`;
  const bodyStr = JSON.stringify(opts.body ?? {});
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(bodyStr);

  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    "host": host,
    "x-amz-date": amzDate,
    "x-amz-target": opts.target,
  };
  if (opts.sessionToken) headers["x-amz-security-token"] = opts.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(enc.encode("AWS4" + opts.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, opts.region);
  const kService = await hmac(kRegion, opts.service);
  const kSigning = await hmac(kService, "aws4_request");
  const sigBuf = await hmac(kSigning, stringToSign);
  const signature = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  headers["authorization"] = [
    `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  // Capitalize for fetch hygiene (Deno preserves the keys but uppercase is conventional).
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) outHeaders[k] = v;

  return { url, headers: outHeaders, body: bodyStr };
}