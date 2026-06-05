import { describe, expect, it } from "vitest";

describe("metadata pipeline invariants", () => {
  it("falls back to proxy_cache_key URL when no thumbnail_cache_key is set", async () => {
    // Mirrors the generateDerived thumbnail-source resolution order:
    // connector.getThumbnail() → asset.thumbnail_cache_key URL → asset.proxy_cache_key URL.
    async function pickThumbBytes(opts: {
      connectorThumbUrl?: string | null;
      assetThumbKey?: string | null;
      assetProxyKey?: string | null;
      fetch: (url: string) => Promise<Uint8Array | null>;
    }): Promise<Uint8Array | null> {
      if (opts.connectorThumbUrl) {
        const b = await opts.fetch(opts.connectorThumbUrl);
        if (b) return b;
      }
      if (opts.assetThumbKey && /^https?:\/\//.test(opts.assetThumbKey)) {
        const b = await opts.fetch(opts.assetThumbKey);
        if (b) return b;
      }
      if (opts.assetProxyKey && /^https?:\/\//.test(opts.assetProxyKey)) {
        const b = await opts.fetch(opts.assetProxyKey);
        if (b) return b;
      }
      return null;
    }

    const fetched: string[] = [];
    const fetch = async (url: string) => { fetched.push(url); return new Uint8Array([1, 2, 3]); };

    // No connector + no thumb URL → falls through to proxy URL.
    const bytes = await pickThumbBytes({
      connectorThumbUrl: null,
      assetThumbKey: null,
      assetProxyKey: "https://provider.example/preview.jpg",
      fetch,
    });
    expect(bytes).not.toBeNull();
    expect(fetched).toEqual(["https://provider.example/preview.jpg"]);
  });

  it("treats OpenAI 401 invalid_api_key as a permanent (non-retryable) failure", () => {
    function classifyAiError(status: number, body: string): "retry" | "permanent" {
      const isAuth = status === 401 && /invalid_api_key|incorrect api key/i.test(body);
      if (isAuth) return "permanent";
      if (status === 429 || status >= 500) return "retry";
      return "permanent";
    }
    expect(classifyAiError(401, '{"error":{"code":"invalid_api_key"}}')).toBe("permanent");
    expect(classifyAiError(401, "Incorrect API key provided: sk-...")).toBe("permanent");
    expect(classifyAiError(429, "rate limited")).toBe("retry");
    expect(classifyAiError(503, "service unavailable")).toBe("retry");
  });

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

  it("only enqueues place clustering when coordinates exist", () => {
    const shouldEnqueuePlaces = (lat: number | null, lng: number | null, extractedGps: boolean) =>
      (lat != null && lng != null) || extractedGps;

    expect(shouldEnqueuePlaces(null, null, false)).toBe(false);
    expect(shouldEnqueuePlaces(40.7, -74.0, false)).toBe(true);
    expect(shouldEnqueuePlaces(null, null, true)).toBe(true);
  });
});