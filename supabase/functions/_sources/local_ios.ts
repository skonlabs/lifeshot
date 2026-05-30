// deno-lint-ignore-file no-explicit-any
import { ConnectorPermanentError, type AssetRecord, type ConnectorContext, type SourceCapabilities, type SourceConnector } from "./types.ts";

const CAPS: SourceCapabilities = {
  kind: "local_ios",
  authMethod: "device_upload",
  supportsDelta: true, supportsWebhook: false,
  canCacheThumbnail: true, canCachePreview: true,
  hasExif: true, hasLocation: true, hasFaceMeta: false, supportsVideo: true,
  rateLimitPerMin: 600, paginationModel: "cursor", originalAccessModel: "on_device",
  consentRequirements: ["cache_originals"], policyRisk: "low", runsWhere: "client", priority: "P0",
  fallbackStrategy: "export_import",
};

/**
 * Server-side handle for the iOS device connector. The actual asset enumeration
 * happens on-device (the iOS app posts batches to /sources/devices/batch which
 * lands rows in ingest_uploads.payload). The server connector reads pending
 * batches and emits AssetRecord items.
 */
export const localIosFactory = (ctx: ConnectorContext, supabase: any): SourceConnector => {
  async function readBatch(cursor: string | null): Promise<{ items: AssetRecord[]; nextCursor: string | null }> {
    let q = supabase.from("ingest_uploads")
      .select("id, payload, created_at")
      .eq("source_account_id", ctx.source_account_id)
      .eq("status", "pending").eq("kind", "device_batch")
      .order("created_at", { ascending: true }).limit(50);
    if (cursor) q = q.gt("created_at", cursor);
    const { data, error } = await q;
    if (error) throw new ConnectorPermanentError(error.message);
    const items: AssetRecord[] = [];
    let last: string | null = cursor;
    for (const row of (data ?? [])) {
      const assets = (row.payload?.assets ?? []) as AssetRecord[];
      items.push(...assets);
      last = row.created_at;
      await supabase.from("ingest_uploads").update({ status: "processed" }).eq("id", row.id);
    }
    return { items, nextCursor: data && data.length ? last : null };
  }

  return {
    capabilities: CAPS,
    getCapabilities: () => CAPS,
    authenticate: async () => { /* device-paired token validated at upload time */ },
    refreshToken: async () => { /* no-op */ },
    listAssets: async (cursor) => readBatch(cursor),
    getDeltaChanges: async (cursor) => {
      const r = await readBatch(cursor);
      return { items: r.items, deleted: [], nextCursor: r.nextCursor };
    },
    getAssetMetadata: async () => { throw new ConnectorPermanentError("on_device only"); },
    getThumbnail: async () => { throw new ConnectorPermanentError("on_device only"); },
    getPreview: async () => { throw new ConnectorPermanentError("on_device only"); },
    getOriginalAccessToken: async () => null,
    listAlbums: async () => [],
    disconnect: async () => { await supabase.from("source_accounts").update({ status: "disconnected" }).eq("id", ctx.source_account_id); },
    revoke: async () => { await supabase.from("source_accounts").update({ status: "revoked" }).eq("id", ctx.source_account_id); },
  };
};