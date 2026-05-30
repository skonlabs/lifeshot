// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/** Compute checksum + perceptual hash if bytes available; else use provider hash. */
export async function hashAsset(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  const { data: asset } = await sb.from("assets").select("id, checksum_hex, perceptual_hash, provider_asset_id, thumbnail_url").eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");

  // Deterministic stub hash if missing: sha-256 of provider_asset_id
  let checksum = asset.checksum_hex;
  if (!checksum) {
    const enc = new TextEncoder().encode(asset.provider_asset_id);
    const digest = await crypto.subtle.digest("SHA-256", enc);
    checksum = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const phash = asset.perceptual_hash ?? checksum.slice(0, 16);

  await sb.from("assets").update({ checksum_hex: checksum, perceptual_hash: phash }).eq("id", asset_id);

  // Look for dup group via phash
  const { data: dups } = await sb.from("assets")
    .select("id").eq("perceptual_hash", phash).neq("id", asset_id).limit(10);
  if (dups && dups.length > 0) {
    await enqueueJob("dedupGroup", { userId: ctx.userId, payload: { phash, asset_id }, idempotencyKey: `dedup:${phash}` });
  }
  return { asset_id, checksum, phash };
}