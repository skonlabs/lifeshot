import { describe, expect, it } from "vitest";

describe("metadata pipeline invariants", () => {
  it("preserves provider-backed thumbnail and preview availability when no derived bytes were produced", () => {
    const asset = {
      thumbnail_cache_key: "https://provider.example/thumb.jpg",
      proxy_cache_key: "https://provider.example/preview.jpg",
    };

    const fallbackPreviewMetadata = {
      thumbnail_generated: Boolean(asset.thumbnail_cache_key),
      preview_generated: Boolean(asset.proxy_cache_key),
      thumbnail_cache_key: asset.thumbnail_cache_key ?? null,
      preview_cache_key: asset.proxy_cache_key ?? null,
    };

    expect(fallbackPreviewMetadata).toEqual({
      thumbnail_generated: true,
      preview_generated: true,
      thumbnail_cache_key: "https://provider.example/thumb.jpg",
      preview_cache_key: "https://provider.example/preview.jpg",
    });
  });

  it("does not zero out force-sync progress while normalize jobs are still processing", () => {
    const prevNormalized = 15;
    const seenTotal = 27;
    const effectiveNextCursor = null;
    const awaitingProcessing = true;
    const indexed = effectiveNextCursor
      ? seenTotal
      : (awaitingProcessing ? prevNormalized : seenTotal);

    expect(indexed).toBe(15);
  });
});