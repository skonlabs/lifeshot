// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import { takeSourceToken } from "../_pipeline/ratelimit.ts";
import { getConnector } from "../_sources/registry.ts";
import { ConnectorRateLimitError } from "../_sources/types.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/**
 * syncSource — pull a page of assets from a source_account, upsert assets,
 * enqueue normalizeMetadata for each new/updated, and chain itself if more pages.
 */
export async function syncSource(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { source_account_id, mode = "incremental" } = ctx.payload as { source_account_id: string; mode?: "initial" | "incremental" };
  if (!source_account_id) throw new Error("invalid: source_account_id missing");

  const { data: acct, error } = await sb.from("source_accounts")
    .select("id, user_id, provider_kind, status").eq("id", source_account_id).single();
  if (error || !acct) throw new Error("not found: source_account");
  if (acct.status === "disconnected" || acct.status === "revoked") return { skipped: "disconnected" };

  const conn = getConnector(acct.provider_kind, { source_account_id, user_id: acct.user_id, provider_kind: acct.provider_kind }, sb);
  const caps = conn.getCapabilities();

  if (!(await takeSourceToken(source_account_id, caps.rateLimitPerMin))) {
    await enqueueJob("syncSource", { userId: acct.user_id, payload: ctx.payload, delaySeconds: 60 });
    return { rateLimited: true };
  }

  // Load cursor
  const cursorKind = mode === "initial" ? "list" : (caps.supportsDelta ? "delta" : "list");
  const { data: cur } = await sb.from("source_sync_cursors")
    .select("cursor").eq("source_account_id", source_account_id).eq("kind", cursorKind).maybeSingle();
  const cursor = (cur?.cursor as any)?.token ?? null;

  let page;
  try {
    page = cursorKind === "delta" ? await conn.getDeltaChanges(cursor) : await conn.listAssets(cursor);
  } catch (e) {
    if (e instanceof ConnectorRateLimitError) {
      await enqueueJob("syncSource", { userId: acct.user_id, payload: ctx.payload, delaySeconds: e.retryAfterSeconds });
      return { rateLimited: true };
    }
    throw e;
  }

  // Upsert assets
  const assetRows = page.items.map((a) => ({
    user_id: acct.user_id, source_account_id,
    provider_asset_id: a.provider_asset_id,
    media_type: a.media_type, mime_type: a.mime_type,
    capture_time: a.capture_time, upload_time: a.upload_time,
    width: a.width, height: a.height, duration_ms: a.duration_ms,
    file_size_bytes: a.file_size_bytes, checksum_hash: a.checksum_hex,
    perceptual_hash: a.perceptual_hash,
    location_lat: a.location?.lat ?? null,
    location_lng: a.location?.lng ?? null,
    device_make: a.device_make, device_model: a.device_model,
    thumbnail_cache_key: a.thumbnail_url ?? null,
    proxy_cache_key: a.preview_url ?? null,
    status: "ingested",
  }));
  let upserted: any[] = [];
  if (assetRows.length) {
    const { data, error: upErr } = await sb.from("assets").upsert(assetRows, {
      onConflict: "source_account_id,provider_asset_id",
    }).select("id");
    if (upErr) throw new Error(`upsert assets: ${upErr.message}`);
    upserted = data ?? [];
  }

  // Cascade deletions
  const deleted = ("deleted" in page ? (page as any).deleted : []) as string[];
  if (deleted.length) {
    await sb.from("assets").update({ deleted_state: "deleted", status: "deleted" })
      .eq("source_account_id", source_account_id).in("provider_asset_id", deleted);
  }

  // Save cursor
  await sb.from("source_sync_cursors").upsert({
    source_account_id, kind: cursorKind, cursor: { token: page.nextCursor }, last_sync_at: new Date().toISOString(),
  }, { onConflict: "source_account_id,kind" });

  // Fan-out normalizeMetadata
  for (const row of upserted) {
    await enqueueJob("normalizeMetadata", {
      userId: acct.user_id, payload: { asset_id: row.id },
      idempotencyKey: `normalize:${row.id}`,
    });
  }

  // Chain next page
  if (page.nextCursor) {
    await enqueueJob("syncSource", { userId: acct.user_id, payload: ctx.payload, delaySeconds: 1 });
  } else {
    await sb.from("source_accounts").update({ last_synced_at: new Date().toISOString(), status: "connected" })
      .eq("id", source_account_id);
  }

  return { items: page.items.length, deleted: deleted.length, more: !!page.nextCursor };
}