export function shouldResyncAsset(input: {
  isNew: boolean;
  existingSourceModifiedAt: string | null;
  providerModifiedAt: string | null;
  hasFileMetadata: boolean;
  hasMediaMetadata: boolean;
}): boolean {
  if (input.isNew) return true;

  const missingMetadata = !input.hasFileMetadata || !input.hasMediaMetadata;
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
  hasQueueJob: boolean;
}): boolean {
  if (!input.hasQueueJob || !input.queueStatus) return false;

  if (input.queueStatus === "running" && input.persistedStage === "completed") {
    return true;
  }

  return input.queueStatus === "pending" && input.indexed > 0 && input.indexed >= input.discovered;
}