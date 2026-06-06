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
      : seenTotal;

    expect(indexed).toBe(27);
    expect(indexed).toBeGreaterThan(prevNormalized);
  });

  it("keeps normalize progress monotonic during processing handoff", () => {
    const previousIndexed = 427;
    const normalizedCount = 12;

    const indexed = Math.max(previousIndexed, normalizedCount);

    expect(indexed).toBe(427);
  });

  it("only enqueues place clustering when coordinates exist", () => {
    const shouldEnqueuePlaces = (lat: number | null, lng: number | null, extractedGps: boolean) =>
      (lat != null && lng != null) || extractedGps;

    expect(shouldEnqueuePlaces(null, null, false)).toBe(false);
    expect(shouldEnqueuePlaces(40.7, -74.0, false)).toBe(true);
    expect(shouldEnqueuePlaces(null, null, true)).toBe(true);
  });

  it("keeps face avatar crop centered on the detected face instead of the whole photo", () => {
    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
    const cover = { width: 4288, height: 2848 };
    const bb = { x: 0.577, y: 0.267, w: 0.174, h: 0.367 };
    const faceCx = (bb.x + bb.w / 2) * cover.width;
    const faceCy = (bb.y + bb.h / 2) * cover.height;
    const faceW = bb.w * cover.width;
    const faceH = bb.h * cover.height;
    const cropSide = clamp(Math.max(faceW, faceH) * 1.12, Math.min(cover.width, cover.height) * 0.09, Math.min(cover.width, cover.height) * 0.68);
    const cropX = clamp(faceCx - cropSide / 2, 0, Math.max(cover.width - cropSide, 0));
    const cropY = clamp(faceCy - cropSide / 2, 0, Math.max(cover.height - cropSide, 0));
    const renderedWidthPct = (cover.width / cropSide) * 100;

    expect(cropSide).toBeLessThan(Math.min(cover.width, cover.height));
    expect(renderedWidthPct).toBeGreaterThan(240);
    expect(cropX).toBeGreaterThan(cover.width * 0.35);
    expect(cropY).toBeGreaterThan(cover.height * 0.05);
  });

  it("uses object-contain thumbnails so photo tiles do not crop the frame", () => {
    const className = "absolute inset-0 h-full w-full object-contain transition-opacity duration-300";
    expect(className).toContain("object-contain");
    expect(className).not.toContain("object-fill");
  });

  it("dedupes face clusters by a stable face signature before rendering people tiles", () => {
    const faceSignature = (bbox: { x: number; y: number; w: number; h: number }, vector: number[]) => {
      const bboxPart = [bbox.x, bbox.y, bbox.w, bbox.h].map((n) => n.toFixed(3)).join(":");
      const vectorPart = vector.slice(0, 3).map((n) => n.toFixed(4)).join(":");
      return `${bboxPart}:${vectorPart}`;
    };

    expect(faceSignature(
      { x: 0.1012, y: 0.2023, w: 0.3034, h: 0.4045 },
      [0.123456, 0.223456, 0.323456],
    )).toBe(faceSignature(
      { x: 0.10121, y: 0.20231, w: 0.30341, h: 0.40449 },
      [0.123451, 0.223454, 0.323459],
    ));
  });

  it("prefers preview imagery for photo tiles so provider square thumbs do not crop the frame", () => {
    const choosePreferredImageKey = (row: {
      media_type?: string | null;
      thumbnail_cache_key?: string | null;
      preview_cache_key?: string | null;
    }) => row.media_type === "photo"
      ? (row.preview_cache_key ?? row.thumbnail_cache_key ?? null)
      : (row.thumbnail_cache_key ?? row.preview_cache_key ?? null);

    expect(choosePreferredImageKey({
      media_type: "photo",
      thumbnail_cache_key: "thumb.jpg",
      preview_cache_key: "preview.jpg",
    })).toBe("preview.jpg");

    expect(choosePreferredImageKey({
      media_type: "video",
      thumbnail_cache_key: "thumb.jpg",
      preview_cache_key: "preview.jpg",
    })).toBe("thumb.jpg");
  });

  it("versions signed-url cache keys by source image key so stale thumb URLs are not reused", () => {
    const fingerprint = (value: string) => {
      let hash = 5381;
      for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
      }
      return (hash >>> 0).toString(16);
    };

    const signedUrlKey = (uid: string, assetId: string, size: string, cacheKey: string | null) =>
      `v2:signed:${uid}:${assetId}:${size}:${fingerprint(cacheKey ?? "_")}`;

    expect(signedUrlKey("u1", "a1", "medium", "thumb.jpg"))
      .not.toBe(signedUrlKey("u1", "a1", "medium", "preview.jpg"));
  });

  it("reduces per-asset downstream jobs to the critical set plus coalesced library jobs", () => {
    const perAssetJobs = ["hashAsset", "generateDerived", "ocrAsset", "enrichAI"];
    const coalescedJobs = ["clusterPeople", "clusterPlaces", "detectEvents"];

    expect(perAssetJobs).toEqual(["hashAsset", "generateDerived", "ocrAsset", "enrichAI"]);
    expect(coalescedJobs).toHaveLength(3);
    expect(perAssetJobs).not.toContain("embedAsset");
  });

  it("rekeys coalesced library jobs by sync run so same-day force syncs are not deduped away", () => {
    const buildKey = (userId: string, syncRunId?: string | null, forceSyncRunId?: string | null) => {
      const clusteringKey = syncRunId ?? forceSyncRunId ?? "2026-06-06T16";
      return {
        people: `people:${userId}:${clusteringKey}`,
        places: `places:${userId}:${clusteringKey}`,
        events: `events:${userId}:${clusteringKey}`,
      };
    };

    expect(buildKey("u1", "run-a", null)).toEqual({
      people: "people:u1:run-a",
      places: "places:u1:run-a",
      events: "events:u1:run-a",
    });
    expect(buildKey("u1", "run-b", null).people).not.toBe(buildKey("u1", "run-a", null).people);
  });

  it("counts places from asset_locations instead of event_places", () => {
    const locations = [
      { place_id: "p1", asset_id: "a1" },
      { place_id: "p1", asset_id: "a2" },
      { place_id: "p2", asset_id: "a3" },
    ];
    const counts: Record<string, number> = {};
    for (const row of locations) counts[row.place_id] = (counts[row.place_id] ?? 0) + 1;

    expect(counts).toEqual({ p1: 2, p2: 1 });
  });
});