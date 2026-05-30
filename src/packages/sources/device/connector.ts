import type { ProviderId, SourceConnector } from "../types";

/**
 * Device connector factory — STUB.
 * Real implementation lives in the LifeShot mobile app (Expo MediaLibrary)
 * and posts batches to /api/v1/sources/device-ingest.
 */
export function deviceConnector(id: "ios_device" | "android_device"): SourceConnector {
  const display = id === "ios_device" ? "iPhone / iPad" : "Android";
  return {
    id: id as ProviderId,
    displayName: display,
    capabilities: () => ({
      hasDelta: true,
      hasWebhook: false,
      hasThumbnails: true,
      hasOriginals: true,
      thumbnailCachePolicy: "long",
      originalAccess: "device-only",
      supportsAlbums: true,
      supportsVideo: true,
    }),
    async startOAuth() {
      throw new Error(`${display} is connected from the LifeShot mobile app`);
    },
    async completeOAuth() {
      throw new Error("device connector uses app-side ingest");
    },
    async refreshToken() {},
    async listAssets() {
      return { assets: [] };
    },
    async getThumbnail() {
      throw new Error("device thumbnails uploaded by app");
    },
    async disconnect() {},
  };
}