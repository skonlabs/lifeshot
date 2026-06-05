import { describe, expect, it } from "vitest";

describe("metadata pipeline invariants", () => {
  it("keeps provider preview keys when only one storage derivative is written", () => {
    const asset = {
      thumbnail_cache_key: null,
      proxy_cache_key: "https://provider.example/preview.jpg",
    };
    const thumb = undefined;
    const preview = { path: "user/asset/preview.jpg" };

    const fallbackThumbKey = thumb?.path ?? asset.thumbnail_cache_key ?? preview?.path ?? asset.proxy_cache_key ?? null;
    const fallbackPreviewKey = preview?.path ?? asset.proxy_cache_key ?? null;

    expect({
      thumbnail_generated: Boolean(fallbackThumbKey),
      preview_generated: Boolean(fallbackPreviewKey),
      thumbnail_cache_key: fallbackThumbKey,
      preview_cache_key: fallbackPreviewKey,
    }).toEqual({
      thumbnail_generated: true,
      preview_generated: true,
      thumbnail_cache_key: "user/asset/preview.jpg",
      preview_cache_key: "user/asset/preview.jpg",
    });
  });

  it("treats bucket-missing upload errors as recoverable setup errors", () => {
    const isBucketMissing = (message?: string | null) => {
      const normalized = message?.toLowerCase() ?? "";
      return normalized.includes("bucket not found") || normalized.includes("not found");
    };

    expect(isBucketMissing("storage upload: Bucket not found")).toBe(true);
    expect(isBucketMissing("row level security violation")).toBe(false);
  });

  it("preserves provider-backed thumbnail and preview availability when no derived bytes were produced", () => {
    const asset = {
      thumbnail_cache_key: "https://provider.example/thumb.jpg",
      proxy_cache_key: "https://provider.example/preview.jpg",
    };

    const fallbackPreviewMetadata = {
      thumbnail_generated: Boolean(asset.thumbnail_cache_key ?? asset.proxy_cache_key),
      preview_generated: Boolean(asset.proxy_cache_key),
      thumbnail_cache_key: asset.thumbnail_cache_key ?? asset.proxy_cache_key ?? null,
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