import type { SourceConnector } from "../types";

/** Dropbox connector — STUB. v2 API + delta cursor wired in next slice. */
export const dropboxConnector: SourceConnector = {
  id: "dropbox",
  displayName: "Dropbox",
  capabilities: () => ({
    hasDelta: true,
    hasWebhook: true,
    hasThumbnails: true,
    hasOriginals: true,
    thumbnailCachePolicy: "long",
    originalAccess: "short-lived",
    supportsAlbums: false,
    supportsVideo: true,
  }),
  async startOAuth(_u, returnTo) {
    const state = crypto.randomUUID();
    return {
      redirectUrl: `/api/v1/sources/callback/dropbox?stub=1&state=${state}&return=${encodeURIComponent(returnTo)}`,
      state,
    };
  },
  async completeOAuth() {
    throw new Error("dropbox OAuth not yet implemented");
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
  async disconnect() {},
};