/**
 * Source connector contracts shared by the API layer and the worker layer.
 * Connector implementations (server-side, deno) re-export these via
 * supabase/functions/_sources/types.ts to stay deno-native.
 */
export type ProviderKind =
  | "google_photos" | "local_ios" | "local_android" | "export_import"
  | "dropbox" | "onedrive" | "nas" | "external_drive" | "desktop_folder"
  | "icloud" | "amazon_photos";

export type AuthMethod = "oauth2" | "oauth2_pkce" | "device_upload" | "agent" | "manual";
export type PaginationModel = "page_token" | "cursor" | "offset" | "stream" | "none";
export type OriginalAccessModel = "url" | "download" | "on_device" | "extract" | "none";
export type Priority = "P0" | "P1" | "P2" | "HighRisk" | "NotFeasible";
export type RunsWhere = "server" | "client";
export type ConsentScope = "ai_processing" | "face_recognition" | "cache_originals";

export interface SourceCapabilities {
  kind: ProviderKind;
  authMethod: AuthMethod;
  supportsDelta: boolean;
  supportsWebhook: boolean;
  canCacheThumbnail: boolean;
  canCachePreview: boolean;
  hasExif: boolean;
  hasLocation: boolean;
  hasFaceMeta: boolean;
  supportsVideo: boolean;
  rateLimitPerMin: number;
  paginationModel: PaginationModel;
  originalAccessModel: OriginalAccessModel;
  consentRequirements: ConsentScope[];
  policyRisk: "low" | "medium" | "high";
  runsWhere: RunsWhere;
  priority: Priority;
  fallbackStrategy: string;
}

export interface AssetLocation { lat: number; lng: number; accuracy_m?: number }
export interface AssetExifSubset {
  iso?: number; aperture?: number; shutter?: string; focal_mm?: number;
  white_balance?: string; flash?: boolean; orientation?: number;
}
export interface AssetAlbumRef {
  id: string;
  name?: string;
  path?: string;
  selectable?: boolean;
  has_children?: boolean;
}

/** Normalized record emitted by every connector — no originals. */
export interface AssetRecord {
  provider_asset_id: string;
  media_type: "image" | "video";
  mime_type?: string;
  capture_time?: string;           // iso
  upload_time?: string;
  created_time?: string;
  modified_time?: string;
  timezone?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  file_size_bytes?: number;
  checksum_hex?: string;           // when bytes available
  perceptual_hash?: string;
  exif?: AssetExifSubset;
  location?: AssetLocation;
  device_make?: string;
  device_model?: string;
  album_refs?: AssetAlbumRef[];
  thumbnail_url?: string;          // provider-served, signed by caller if cached
  preview_url?: string;
  provider_url?: string;
  raw?: Record<string, unknown>;
}

export interface PageResult { items: AssetRecord[]; nextCursor: string | null }
export interface DeltaResult { items: AssetRecord[]; deleted: string[]; nextCursor: string | null }

export class ConnectorAuthError extends Error {
  constructor(message: string, public readonly retryable = false) { super(message); }
}
export class ConnectorRateLimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds: number) { super(message); }
}
export class ConnectorTransientError extends Error {}
export class ConnectorPermanentError extends Error {}

/**
 * Connector handle bound to one source_account. The factory in the registry
 * builds it from { source_account_id, user_id, supabase service client }.
 */
export interface SourceConnector {
  capabilities: SourceCapabilities;
  authenticate(): Promise<void>;
  refreshToken(): Promise<void>;
  listAssets(cursor: string | null): Promise<PageResult>;
  getAssetMetadata(providerAssetId: string): Promise<AssetRecord>;
  getThumbnail(providerAssetId: string): Promise<{ bytes: Uint8Array; contentType: string } | { url: string }>;
  getPreview(providerAssetId: string): Promise<{ bytes: Uint8Array; contentType: string } | { url: string }>;
  getOriginalAccessToken(providerAssetId: string): Promise<{ url: string; expiresAt: string } | null>;
  listAlbums(parentId?: string | null): Promise<AssetAlbumRef[]>;
  getDeltaChanges(cursor: string | null): Promise<DeltaResult>;
  disconnect(): Promise<void>;
  revoke(): Promise<void>;
  getCapabilities(): SourceCapabilities;
}

export interface ConnectorContext {
  source_account_id: string;
  user_id: string;
  provider_kind: ProviderKind;
}

export type ConnectorFactory = (
  ctx: ConnectorContext,
  // deno-lint-ignore no-explicit-any
  supabase: any,
) => SourceConnector;