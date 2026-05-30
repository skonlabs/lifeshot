/**
 * Source Abstraction Layer.
 * Every provider (Google Photos, Dropbox, iOS device, ...) implements
 * SourceConnector. The rest of LifeShot consumes NormalizedAsset only.
 */

export type ProviderId =
  | "google_photos"
  | "dropbox"
  | "onedrive"
  | "ios_device"
  | "android_device"
  | "desktop_folder"
  | "whatsapp_import"
  | "fb_export"
  | "ig_export";

export interface SourceCapabilities {
  hasDelta: boolean;
  hasWebhook: boolean;
  hasThumbnails: boolean;
  hasOriginals: boolean;
  /** "none" = MUST refetch each time; "short" ≤ 24h; "long" can persist. */
  thumbnailCachePolicy: "none" | "short" | "long";
  originalAccess: "direct" | "signed-url" | "short-lived" | "device-only";
  supportsAlbums: boolean;
  supportsVideo: boolean;
  ratePerMin?: number;
}

export interface NormalizedAsset {
  sourceAssetId: string;
  mediaType: "image" | "video" | "live" | "other";
  mimeType?: string;
  captureTime?: string;
  captureTimeConfidence: number;
  width?: number;
  height?: number;
  durationMs?: number;
  fileSizeBytes?: number;
  contentHashSha256?: string;
  perceptualHash?: number;
  exif?: Record<string, unknown>;
  location?: { lat: number; lng: number; confidence: number };
  device?: { make?: string; model?: string };
  albumIds?: string[];
  filename?: string;
}

export interface ListAssetsResult {
  assets: NormalizedAsset[];
  nextCursor?: string;
}

export interface DeltaChange {
  op: "upsert" | "delete";
  asset?: NormalizedAsset;
  sourceAssetId?: string;
}

export interface OAuthStartResult {
  redirectUrl: string;
  state: string;
}

export interface SourceConnector {
  id: ProviderId;
  displayName: string;
  capabilities(): SourceCapabilities;

  startOAuth(userId: string, returnTo: string): Promise<OAuthStartResult>;
  completeOAuth(
    state: string,
    code: string,
  ): Promise<{
    externalAccountId: string;
    displayName: string;
    scopes: string[];
    tokenCiphertext: Uint8Array;
    tokenNonce: Uint8Array;
    expiresAt?: string;
  }>;

  refreshToken(sourceAccountId: string): Promise<void>;

  listAssets(
    sourceAccountId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ListAssetsResult>;

  getDelta?(
    sourceAccountId: string,
    cursor: string,
  ): Promise<{ changes: DeltaChange[]; nextCursor: string }>;

  getThumbnail(
    sourceAccountId: string,
    sourceAssetId: string,
    size: 256 | 512 | 1024,
  ): Promise<{ bytes?: Uint8Array; url?: string; ttlSec?: number }>;

  getOriginalUrl?(
    sourceAccountId: string,
    sourceAssetId: string,
  ): Promise<{ url: string; ttlSec: number }>;

  disconnect(sourceAccountId: string): Promise<void>;
}