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
export const exportImportFactory = (ctx: ConnectorContext, supabase: any): SourceConnector => {
  async function readZips(cursor: string | null) {
    let q = supabase.from("ingest_uploads")
      .select("id, payload, storage_path, status, created_at")
      .eq("user_id", ctx.user_id).eq("kind", "export_zip")
      .in("status", ["pending", "parsed"])
      .order("created_at", { ascending: true }).limit(20);
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