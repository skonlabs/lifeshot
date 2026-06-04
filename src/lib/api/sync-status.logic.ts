export function shouldResyncAsset(input: {
  isNew: boolean;
  mediaType?: string | null;
  existingSourceModifiedAt: string | null;
  providerModifiedAt: string | null;
  hasFileMetadata: boolean;
  hasMediaMetadata: boolean;
  hasPreviewMetadata?: boolean;
  hasAiReadyMetadata?: boolean;
  hasOrganizationSignals?: boolean;
  hasVideoMetadata?: boolean;
  hasDocumentMetadata?: boolean;
  hasAudioMetadata?: boolean;
}): boolean {
  if (input.isNew) return true;

  const baseMetadataMissing =
    !input.hasFileMetadata ||
    !input.hasMediaMetadata ||
    !input.hasAiReadyMetadata ||
    !input.hasOrganizationSignals;

  const needsPreview = input.mediaType === "photo" || input.mediaType === "video" || input.mediaType === "document";
  const previewMissing = needsPreview && !input.hasPreviewMetadata;
  const typeSpecificMissing =
    (input.mediaType === "video" && !input.hasVideoMetadata) ||
    (input.mediaType === "document" && !input.hasDocumentMetadata) ||
    (input.mediaType === "audio" && !input.hasAudioMetadata);

  const missingMetadata = baseMetadataMissing || previewMissing || typeSpecificMissing;
  if (missingMetadata) return true;

  return !input.existingSourceModifiedAt || (
    input.providerModifiedAt !== null && input.providerModifiedAt !== input.existingSourceModifiedAt
  );
}

export function isStaleSyncQueueState(input: {
  queueStatus: string | null;
  persistedStage: string | null;
  indexed: number;
  discovered: number;
  hasMore?: boolean;
  hasQueueJob: boolean;
}): boolean {
  if (!input.hasQueueJob || !input.queueStatus) return false;

  if (input.queueStatus === "running" && input.persistedStage === "completed") {
    return true;
  }

  return input.queueStatus === "pending" && input.persistedStage === "completed";
}