import type { SourceConnector, SourceCapabilities } from "../types";

/**
 * Google Photos connector — STUB.
 * Full OAuth + Library API implementation is wired in the next slice.
 * Caching policy: thumbnails MUST NOT be persisted (Google TOS).
 * baseUrl is short-lived (~1h); we cache the URL, not the bytes.
 */
export const googlePhotosConnector: SourceConnector = {
  id: "google_photos",
  displayName: "Google Photos",

  capabilities(): SourceCapabilities {
    return {
      hasDelta: false,
      hasWebhook: false,
      hasThumbnails: true,
      hasOriginals: true,
      thumbnailCachePolicy: "none",
      originalAccess: "short-lived",
      supportsAlbums: true,
      supportsVideo: true,
      ratePerMin: 100,
    };
  },

  async startOAuth(_userId, returnTo) {
    // TODO: real Google OAuth (scope: photoslibrary.readonly)
    const state = crypto.randomUUID();
    const redirectUrl =
      `/api/v1/sources/callback/google_photos?stub=1&state=${state}&return=${encodeURIComponent(returnTo)}`;
    return { redirectUrl, state };
  },

  async completeOAuth() {
    throw new Error("google_photos OAuth not yet implemented");
  },

  async refreshToken() {
    throw new Error("not implemented");
  },

  async listAssets() {
    return { assets: [] };
  },

  async getThumbnail() {
    throw new Error("not implemented");
  },

  async disconnect() {
    // revoke + delete tokens handled by source.functions disconnect flow
  },
};