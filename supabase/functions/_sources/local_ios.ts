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
  // ingest_uploads was dropped in the B-NUKE consolidation. The iOS device
  // pipeline (which inserted device-side batches into that table) is offline
  // until a replacement is built. The connector returns no items so the rest
  // of the syncSource path stays no-op safe.
  async function readBatch(_cursor: string | null): Promise<{ items: AssetRecord[]; nextCursor: string | null }> {
    return { items: [], nextCursor: null };
  }

  return {
    capabilities: CAPS,
    getCapabilities: () => CAPS,
    authenticate: async () => { /* device-paired token validated at upload time */ },
    refreshToken: async () => { /* no-op */ },
    listAssets: async (cursor) => readBatch(cursor),
    countSelectionStats: async () => ({ folder_count: 0, photo: 0, video: 0, document: 0, audio: 0, other: 0 }),
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