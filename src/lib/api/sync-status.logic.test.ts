import { describe, expect, it } from "vitest";

import { isStaleSyncQueueState, shouldResyncAsset } from "./sync-status.logic";

describe("shouldResyncAsset", () => {
  it("re-syncs new assets", () => {
    expect(shouldResyncAsset({
      isNew: true,
      existingSourceModifiedAt: null,
      providerModifiedAt: null,
      hasFileMetadata: false,
      hasMediaMetadata: false,
    })).toBe(true);
  });

  it("re-syncs when metadata rows are missing", () => {
    expect(shouldResyncAsset({
      isNew: false,
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-01T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: false,
    })).toBe(true);
  });

  it("re-syncs when timestamp changed", () => {
    expect(shouldResyncAsset({
      isNew: false,
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-02T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: true,
    })).toBe(true);
  });

  it("skips unchanged assets with complete metadata", () => {
    expect(shouldResyncAsset({
      isNew: false,
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-01T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: true,
    })).toBe(false);
  });
});

describe("isStaleSyncQueueState", () => {
  it("treats a pending job as stale when indexing already reached discovered total", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "pending",
      persistedStage: "queued",
      indexed: 427,
      discovered: 427,
      hasQueueJob: true,
    })).toBe(true);
  });

  it("treats a running job with completed stage as stale", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "running",
      persistedStage: "completed",
      indexed: 427,
      discovered: 427,
      hasQueueJob: true,
    })).toBe(true);
  });

  it("keeps genuine in-flight jobs active", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "running",
      persistedStage: "indexing",
      indexed: 120,
      discovered: 427,
      hasQueueJob: true,
    })).toBe(false);
  });
});