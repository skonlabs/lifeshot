// deno-lint-ignore-file no-explicit-any
import type { ConnectorContext, ConnectorFactory, ProviderKind, SourceCapabilities, SourceConnector } from "./types.ts";

function buildStub(kind: ProviderKind, overrides: Partial<SourceCapabilities> = {}): ConnectorFactory {
  const caps: SourceCapabilities = {
    kind, authMethod: "oauth2", supportsDelta: false, supportsWebhook: false,
    canCacheThumbnail: false, canCachePreview: false, hasExif: false, hasLocation: false,
    hasFaceMeta: false, supportsVideo: false, rateLimitPerMin: 60, paginationModel: "none",
    originalAccessModel: "none", consentRequirements: [], policyRisk: "medium",
    runsWhere: "server", priority: "P2", fallbackStrategy: "export_import",
    ...overrides,
  };
  return (ctx: ConnectorContext, supabase: any): SourceConnector => ({
    capabilities: caps,
    getCapabilities: () => caps,
    authenticate: async () => {},
    refreshToken: async () => {},
    listAssets: async () => ({ items: [], nextCursor: null }),
    getDeltaChanges: async () => ({ items: [], deleted: [], nextCursor: null }),
    getAssetMetadata: async () => { throw new Error(`${kind}: not implemented (stub)`); },
    getThumbnail: async () => { throw new Error(`${kind}: not implemented (stub)`); },
    getPreview: async () => { throw new Error(`${kind}: not implemented (stub)`); },
    getOriginalAccessToken: async () => null,
    listAlbums: async () => [],
    disconnect: async () => { await supabase.from("source_accounts").update({ status: "disconnected" }).eq("id", ctx.source_account_id); },
    revoke: async () => { await supabase.from("source_accounts").update({ status: "revoked" }).eq("id", ctx.source_account_id); },
  });
}

export const dropboxFactory        = buildStub("dropbox",        { authMethod: "oauth2", priority: "P1" });
export const onedriveFactory       = buildStub("onedrive",       { authMethod: "oauth2", priority: "P1" });
export const nasFactory            = buildStub("nas",            { authMethod: "manual", runsWhere: "client", priority: "P1" });
export const externalDriveFactory  = buildStub("external_drive", { authMethod: "manual", runsWhere: "client", priority: "P2" });
export const desktopFolderFactory  = buildStub("desktop_folder", { authMethod: "agent",  runsWhere: "client", priority: "P1" });
export const icloudFactory         = buildStub("icloud",         { authMethod: "oauth2", priority: "HighRisk", policyRisk: "high" });
export const amazonPhotosFactory   = buildStub("amazon_photos",  { authMethod: "oauth2", priority: "HighRisk", policyRisk: "high" });
export const localAndroidFactory   = buildStub("local_android",  { authMethod: "device_upload", runsWhere: "client", priority: "P0" });