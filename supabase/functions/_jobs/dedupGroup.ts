// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/**
 * dedupGroup — stamps assets sharing the same checksum_hash or perceptual_hash
 * with a deterministic duplicate_group_id (UUID v5-style derived from the hash).
 *
 * The duplicate_groups / duplicate_group_members tables were dropped in the
 * B-NUKE consolidation; the live `/duplicates` endpoint now aggregates groups
 * directly off `assets.duplicate_group_id`.
 */

async function hashToUuid(prefix: string, hash: string): Promise<string> {
  // Derive a stable UUID-shaped string from the hash so repeated dedupGroup
  // calls land on the same group_id without needing a lookup table.
  const buf = new TextEncoder().encode(`${prefix}:${hash}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  const hex = Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function dedupGroup(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const payload = ctx.payload as { sha256?: string; phash?: string; asset_id?: string };
  const results: Record<string, unknown> = {};

  async function stamp(signal: "sha256" | "phash", value: string, column: "checksum_hash" | "perceptual_hash") {
    const { data: members } = await sb.from("assets")
      .select("id").eq(column, value).limit(500);
    if (!members || members.length < 2) return { members: members?.length ?? 0 };
    const groupId = await hashToUuid(signal, value);
    await sb.from("assets").update({ duplicate_group_id: groupId })
      .in("id", members.map((m: any) => m.id));
    return { group_id: groupId, members: members.length };
  }

  if (payload.sha256) results.sha256 = await stamp("sha256", payload.sha256, "checksum_hash");
  if (payload.phash)  results.phash  = await stamp("phash",  payload.phash,  "perceptual_hash");
  if (!payload.sha256 && !payload.phash) {
    throw new Error("invalid: payload must include sha256 or phash");
  }
  return results;
}
