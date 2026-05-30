// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/** Compute checksum + perceptual hash if bytes available; else use provider hash. */
export async function hashAsset(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  const { data: asset } = await sb.from("assets")
    .select("id, checksum_hash, perceptual_hash").eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");
  let checksum = asset.checksum_hash as string | null;
  if (!checksum) {
    const enc = new TextEncoder().encode(asset_id);
    const digest = await crypto.subtle.digest("SHA-256", enc);
    checksum = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const phash = asset.perceptual_hash ?? checksum.slice(0, 16);
  await sb.from("assets").update({ checksum_hash: checksum, perceptual_hash: phash }).eq("id", asset_id);

  // Look for dup group via phash
  const { data: dups } = await sb.from("assets")
    .select("id").eq("perceptual_hash", phash).neq("id", asset_id).limit(10);
  if (dups && dups.length > 0) {
    await enqueueJob("dedupGroup", { userId: ctx.userId, payload: { phash, asset_id }, idempotencyKey: `dedup:${phash}` });
  }
  return { asset_id, checksum, phash };
}