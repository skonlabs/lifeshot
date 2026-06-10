import { describe, expect, it } from "vitest";

import { isStaleSyncQueueState, shouldResyncAsset } from "./sync-status.logic";

describe("shouldResyncAsset", () => {
  it("re-syncs new assets", () => {
    expect(shouldResyncAsset({
      isNew: true,
      mediaType: "photo",
      existingSourceModifiedAt: null,
      providerModifiedAt: null,
      hasFileMetadata: false,
      hasMediaMetadata: false,
      hasPreviewMetadata: false,
      hasAiReadyMetadata: false,
      hasOrganizationSignals: false,
    })).toBe(true);
  });

  it("re-syncs when metadata rows are missing", () => {
    expect(shouldResyncAsset({
      isNew: false,
      mediaType: "photo",
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-01T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: false,
      hasPreviewMetadata: false,
      hasAiReadyMetadata: false,
      hasOrganizationSignals: false,
    })).toBe(true);
  });

  it("re-syncs unchanged photos when preview or AI rows are missing", () => {
    expect(shouldResyncAsset({
      isNew: false,
      mediaType: "photo",
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-01T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: true,
      hasPreviewMetadata: false,
      hasPreviewContent: false,
      hasAiReadyMetadata: true,
      hasAiEnrichment: false,
      hasOrganizationSignals: true,
      hasLocationMetadata: false,
    })).toBe(true);
  });

  it("re-syncs unchanged photos when preview row exists but has no actual thumbnail or preview content", () => {
    expect(shouldResyncAsset({
      isNew: false,
      mediaType: "photo",
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-01T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: true,
      hasPreviewMetadata: true,
      hasPreviewContent: false,
      hasAiReadyMetadata: true,
      hasAiEnrichment: true,
      hasOrganizationSignals: true,
      hasLocationMetadata: true,
    })).toBe(true);
  });

  it("re-syncs unchanged photos when AI enrichment or location metadata is missing", () => {
    expect(shouldResyncAsset({
      isNew: false,
      mediaType: "photo",
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-01T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: true,
      hasPreviewMetadata: true,
      hasPreviewContent: true,
      hasAiReadyMetadata: true,
      hasAiEnrichment: false,
      hasOrganizationSignals: true,
      hasLocationMetadata: false,
    })).toBe(true);
  });

  it("re-syncs unchanged audio when the audio metadata row is missing", () => {
    expect(shouldResyncAsset({
      isNew: false,
      mediaType: "audio",
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-01T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: true,
      hasPreviewMetadata: false,
      hasPreviewContent: false,
      hasAiReadyMetadata: true,
      hasAiEnrichment: true,
      hasOrganizationSignals: true,
      hasLocationMetadata: true,
      hasAudioMetadata: false,
    })).toBe(true);
  });

  it("re-syncs when timestamp changed", () => {
    expect(shouldResyncAsset({
      isNew: false,
      mediaType: "photo",
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-02T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: true,
      hasPreviewMetadata: true,
      hasPreviewContent: true,
      hasAiReadyMetadata: true,
      hasAiEnrichment: true,
      hasOrganizationSignals: true,
      hasLocationMetadata: true,
    })).toBe(true);
  });

  it("skips unchanged assets with complete metadata", () => {
    expect(shouldResyncAsset({
      isNew: false,
      mediaType: "photo",
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-01T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: true,
      hasPreviewMetadata: true,
      hasPreviewContent: true,
      hasAiReadyMetadata: true,
      hasAiEnrichment: true,
      hasOrganizationSignals: true,
      hasLocationMetadata: true,
    })).toBe(false);
  });

  it("does not treat omitted optional legacy flags as missing metadata", () => {
    expect(shouldResyncAsset({
      isNew: false,
      mediaType: "photo",
      existingSourceModifiedAt: "2026-06-01T00:00:00Z",
      providerModifiedAt: "2026-06-01T00:00:00Z",
      hasFileMetadata: true,
      hasMediaMetadata: true,
      hasPreviewMetadata: true,
      hasPreviewContent: true,
      hasAiEnrichment: true,
      hasLocationMetadata: true,
    })).toBe(false);
  });
});

describe("isStaleSyncQueueState", () => {
  it("does not treat a queued pending job as stale just because counts match", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "pending",
      persistedStage: "queued",
      indexed: 427,
      discovered: 427,
      hasMore: false,
      hasQueueJob: true,
    })).toBe(false);
  });

  it("treats a running job with completed stage as stale", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "running",
      persistedStage: "completed",
      indexed: 427,
      discovered: 427,
      hasMore: false,
      hasQueueJob: true,
    })).toBe(true);
  });

  it("keeps genuine in-flight jobs active", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "running",
      persistedStage: "indexing",
      indexed: 120,
      discovered: 427,
      hasMore: true,
      hasQueueJob: true,
    })).toBe(false);
  });

  it("keeps a freshly queued force sync active when current job progress is still zero", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "pending",
      persistedStage: "queued",
      indexed: 0,
      discovered: 1,
      hasMore: true,
      hasQueueJob: true,
    })).toBe(false);
  });

  it("keeps chained pending jobs active while more pages remain", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "pending",
      persistedStage: "queued",
      indexed: 427,
      discovered: 427,
      hasMore: true,
      hasQueueJob: true,
    })).toBe(false);
  });

  it("keeps processing-only runs active after listing finishes", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "running",
      persistedStage: "processing",
      indexed: 136,
      discovered: 427,
      hasMore: false,
      hasQueueJob: true,
    })).toBe(false);
  });

  it("treats queue rows marked completed as non-stale terminal state", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "completed",
      persistedStage: "completed",
      indexed: 427,
      discovered: 427,
      hasMore: false,
      hasQueueJob: true,
    })).toBe(false);
  });

  it("treats pending jobs as stale only when the persisted stage is terminal", () => {
    expect(isStaleSyncQueueState({
      queueStatus: "pending",
      persistedStage: "completed",
      indexed: 427,
      discovered: 427,
      hasMore: false,
      hasQueueJob: true,
    })).toBe(true);
  });
});