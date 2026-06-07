// deno-lint-ignore-file no-explicit-any
/**
 * hashAsset — streams the cloud asset's bytes through SHA-256 and writes a
 * real content hash to assets.checksum_hash and asset_hashes. Caps the read
 * at SIZE_CAP bytes; above the cap, status='skipped_too_large' is recorded
 * and the asset is left without a full hash (a head-range quick_hash is
 * still written). Never loads files into memory beyond the cap.
 */
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { getConnector } from "../_sources/registry.ts";
import { fetchHeadBytes, streamSha256 } from "../_extractors/fetch-bytes.ts";

const SIZE_CAP = 256 * 1024 * 1024; // 256 MB hard cap on full hashing

async function quickHashFromHead(bytes: Uint8Array, size: number | null): Promise<string> {
  const head = bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1024));
  const tail = bytes.byteLength > 64 * 1024 ? bytes.subarray(Math.max(0, bytes.byteLength - 64 * 1024)) : new Uint8Array();
  const payload = new Uint8Array(head.byteLength + tail.byteLength);
  payload.set(head, 0);
  payload.set(tail, head.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `qh1:${size ?? bytes.byteLength}:${hex}`;
}

export async function hashAsset(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { data: asset } = await sb.from("assets")
    .select("id, user_id, checksum_hash, perceptual_hash, file_size_bytes")
    .eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");

  // Already hashed — nothing to do.
  if (asset.checksum_hash && asset.checksum_hash.length === 64) {
    return { asset_id, status: "already_hashed" };
  }

  const { data: ref } = await sb.from("asset_source_refs")
    .select("source_account_id, source_asset_id")
    .eq("asset_id", asset_id).order("is_primary", { ascending: false }).limit(1).maybeSingle();

  if (!ref?.source_account_id || !ref?.source_asset_id) {
    // No cloud ref — local browser scans should have supplied the hash in the batch payload.
    return { asset_id, status: "no_source_ref" };
  }

  const { data: acct } = await sb.from("source_accounts")
    .select("provider_id, provider_kind").eq("id", ref.source_account_id).single();
  let providerKind: any = acct?.provider_kind;
  if (!providerKind && acct?.provider_id) {
    const { data: pr } = await sb.from("source_providers").select("kind").eq("id", acct.provider_id).single();
    providerKind = pr?.kind;
  }
  if (!providerKind) return { asset_id, status: "no_provider" };

  const conn = getConnector(providerKind, {
    source_account_id: ref.source_account_id, user_id: asset.user_id, provider_kind: providerKind,
  }, sb);

  // Quick hash from head bytes first — always cheap.
  const head = await fetchHeadBytes(conn, ref.source_asset_id, 64 * 1024);
  let quickHash: string | null = null;
  if (head?.bytes?.byteLength) {
    quickHash = await quickHashFromHead(head.bytes, head.totalSize ?? asset.file_size_bytes ?? null);
  }

  // Decide whether to run full hash based on declared/observed size.
  const reportedSize = head?.totalSize ?? asset.file_size_bytes ?? 0;
  let fullHash: string | null = null;
  let hashStatus = "pending";
  let hashError: string | null = null;

  if (reportedSize > 0 && reportedSize <= SIZE_CAP) {
    const token = await conn.getOriginalAccessToken(ref.source_asset_id).catch(() => null);
    if (token?.url) {
      const r = await streamSha256(token.url, SIZE_CAP);
      if (r.sha256) {
        fullHash = r.sha256;
        hashStatus = "complete";
      } else if (r.capped) {
        hashStatus = "skipped_too_large";
      } else {
        hashStatus = "failed";
        hashError = "download or hash failed";
      }
    } else {
      hashStatus = "failed";
      hashError = "no original access url";
    }
  } else if (reportedSize > SIZE_CAP) {
    hashStatus = "skipped_too_large";
  } else {
    hashStatus = "failed";
    hashError = "unknown file size";
  }

  // asset_hashes was dropped in B-NUKE; sha256 + phash now live directly on
  // public.assets. quick_hash is no longer persisted (only used internally
  // for dedup ordering, which uses checksum_hash now).
  if (fullHash) {
    await sb.from("assets").update({ checksum_hash: fullHash }).eq("id", asset_id);
  }

  // Trigger dedup only when we have a real content hash to compare on.
  if (fullHash) {
    const { data: dups } = await sb.from("assets")
      .select("id").eq("checksum_hash", fullHash).neq("id", asset_id).limit(10);
    if (dups && dups.length > 0) {
      await enqueueJob("dedupGroup", {
        userId: ctx.userId,
        payload: { sha256: fullHash, asset_id },
        idempotencyKey: `dedup:${fullHash}`,
      });
    }
  }

  return { asset_id, status: hashStatus, sha256: fullHash, quick: quickHash };
}