// deno-lint-ignore-file no-explicit-any
/**
 * Range-fetch helper for cloud sources. Given a connector and a provider
 * asset id, returns a head-range Uint8Array (default 384 KB — enough for
 * EXIF, XMP, IPTC, ID3, PDF header, MP4 ftyp/moov box in most files).
 *
 * Never loads the full file. Caller controls byte length.
 */
import type { SourceConnector } from "../_sources/types.ts";

export interface FetchedBytes {
  bytes: Uint8Array;
  contentType: string | null;
  totalSize: number | null; // from Content-Range total when partial
  url: string;
}

const DEFAULT_HEAD = 384 * 1024;
const RANGE_FETCH_TIMEOUT_MS = 20_000;
const STREAM_FETCH_TIMEOUT_MS = 45_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchHeadBytes(
  conn: SourceConnector,
  providerAssetId: string,
  byteLength: number = DEFAULT_HEAD,
): Promise<FetchedBytes | null> {
  const token = await conn.getOriginalAccessToken(providerAssetId).catch(() => null);
  if (!token?.url) return null;
  return await fetchRange(token.url, byteLength);
}

export async function fetchRange(url: string, byteLength: number): Promise<FetchedBytes | null> {
  try {
    const res = await fetchWithTimeout(url, { headers: { range: `bytes=0-${byteLength - 1}` } }, RANGE_FETCH_TIMEOUT_MS);
    if (!res.ok && res.status !== 206 && res.status !== 200) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const cr = res.headers.get("content-range");
    let totalSize: number | null = null;
    if (cr) {
      const m = cr.match(/\/(\d+)$/);
      if (m) totalSize = Number(m[1]);
    } else {
      const cl = res.headers.get("content-length");
      if (cl) totalSize = Number(cl);
    }
    return { bytes: buf, contentType: res.headers.get("content-type"), totalSize, url };
  } catch {
    return null;
  }
}

/** Streaming SHA-256 over the full file. Size cap stops the read early. */
export async function streamSha256(
  url: string,
  sizeCapBytes: number = 256 * 1024 * 1024,
): Promise<{ sha256: string | null; bytesRead: number; capped: boolean }> {
  try {
    const res = await fetchWithTimeout(url, {}, STREAM_FETCH_TIMEOUT_MS);
    if (!res.ok || !res.body) return { sha256: null, bytesRead: 0, capped: false };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    let capped = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > sizeCapBytes) { capped = true; try { await reader.cancel(); } catch { /* ignore */ } break; }
      chunks.push(value);
    }
    if (capped) return { sha256: null, bytesRead, capped: true };
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { merged.set(c, pos); pos += c.byteLength; }
    const digest = await crypto.subtle.digest("SHA-256", merged);
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return { sha256: hex, bytesRead, capped: false };
  } catch {
    return { sha256: null, bytesRead: 0, capped: false };
  }
}