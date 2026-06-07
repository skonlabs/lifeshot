// deno-lint-ignore-file no-explicit-any
import { ConnectorPermanentError, type AssetRecord, type ConnectorContext, type SourceCapabilities, type SourceConnector } from "./types.ts";
import { STORAGE_BUCKETS } from "../_pipeline/clients.ts";

const CAPS: SourceCapabilities = {
  kind: "export_import",
  authMethod: "manual",
  supportsDelta: false, supportsWebhook: false,
  canCacheThumbnail: true, canCachePreview: true,
  hasExif: true, hasLocation: true, hasFaceMeta: false, supportsVideo: true,
  rateLimitPerMin: 9999, paginationModel: "cursor", originalAccessModel: "extract",
  consentRequirements: ["cache_originals"], policyRisk: "low", runsWhere: "server", priority: "P0",
  fallbackStrategy: "manual_retry",
};

/**
 * Export/Import — accepts user-uploaded zip exports (Google Takeout, etc.).
 * The connector parses ingest_uploads rows of kind 'export_zip' whose payload
 * has been pre-parsed by ingestExportZip (or contains an `assets` array of
 * AssetRecord items for tests).
 */
export const exportImportFactory = (_ctx: ConnectorContext, _supabase: any): SourceConnector => {
  // ingest_uploads was dropped in B-NUKE. Takeout zip ingestion is offline
  // until a replacement (e.g. direct storage-bucket scan) is built.
  async function readZips(_cursor: string | null) {
    return { items: [] as AssetRecord[], nextCursor: null as string | null };
  }
  return {
    capabilities: CAPS, getCapabilities: () => CAPS,
    authenticate: async () => {}, refreshToken: async () => {},
    listAssets: async (cursor) => readZips(cursor),
    countSelectionStats: async () => ({ folder_count: 0, photo: 0, video: 0, document: 0, audio: 0, other: 0 }),
    getDeltaChanges: async (cursor) => {
      const r = await readZips(cursor);
      return { items: r.items, deleted: [], nextCursor: r.nextCursor };
    },
    getAssetMetadata: async () => { throw new ConnectorPermanentError("not addressable"); },
    getThumbnail: async () => { throw new ConnectorPermanentError("not addressable"); },
    getPreview: async () => { throw new ConnectorPermanentError("not addressable"); },
    getOriginalAccessToken: async () => null,
    listAlbums: async () => [],
    disconnect: async () => { await supabase.from("source_accounts").update({ status: "disconnected" }).eq("id", ctx.source_account_id); },
    revoke: async () => { await supabase.from("source_accounts").update({ status: "revoked" }).eq("id", ctx.source_account_id); },
  };
};

export { STORAGE_BUCKETS };