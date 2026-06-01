/**
 * Path redaction + hashing helpers used by the scans API and worker layer.
 * Local absolute paths are never stored; only:
 *   - SHA-256 hash (for dedup/incremental sync)
 *   - last 2 segments (for human-readable display)
 */

export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function redactPath(absolutePath: string | null | undefined): string | null {
  if (!absolutePath) return null;
  const norm = absolutePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return ".../" + parts.slice(-2).join("/");
}

export async function normalizedPathHash(absolutePath: string): Promise<string> {
  const norm = absolutePath.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  return sha256Hex(norm);
}