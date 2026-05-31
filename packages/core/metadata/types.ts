/**
 * Universal Metadata Extraction & Indexing Engine — Canonical Types
 *
 * Shared across:
 *   • browser scan runner       (src/lib/metadata-engine/)
 *   • scans edge function       (supabase/functions/scans/)
 *   • shared persistence helpers (supabase/functions/_metadata/)
 *
 * All schemas are Zod-validated at trust boundaries (HTTP, DB write).
 */
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

export const UuidSchema = z.string().uuid();
export const Iso8601Schema = z.string().datetime({ offset: true });

export const ExtractionStatusSchema = z.enum([
  "pending", "partial", "complete", "error", "skipped", "unsupported",
]);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

export const SourceKindSchema = z.enum([
  "local_folder", "local_ios", "local_android",
  "external_drive", "nas", "desktop_folder",
  "google_photos", "dropbox", "onedrive", "icloud_photos",
  "amazon_photos", "export_import",
  "whatsapp_export", "facebook_export", "instagram_export",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const MediaTypeSchema = z.enum([
  "photo", "video", "document", "audio", "other",
]);
export type MediaType = z.infer<typeof MediaTypeSchema>;

export const ScanModeSchema = z.enum(["full", "incremental", "resume"]);
export type ScanMode = z.infer<typeof ScanModeSchema>;

export const ScanStatusSchema = z.enum([
  "pending", "running", "paused", "cancelled", "completed", "failed",
]);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

export const ScanPhaseSchema = z.enum([
  "queued", "discovering", "extracting", "hashing",
  "uploading", "finalizing", "completed", "cancelled", "failed",
]);
export type ScanPhase = z.infer<typeof ScanPhaseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Source capabilities
// ─────────────────────────────────────────────────────────────────────────────

export const SourceCapabilitiesSchema = z.object({
  kind: SourceKindSchema,
  supportsRecursiveListing: z.boolean(),
  supportsFolders: z.boolean(),
  supportsHashing: z.boolean(),
  supportsPerceptualHash: z.boolean(),
  supportsIncrementalCursor: z.boolean(),
  supportsResume: z.boolean(),
  supportsCancellation: z.boolean(),
  supportsRangeReads: z.boolean(),
  supportsThumbnailURL: z.boolean(),
  supportsDownload: z.boolean(),
  requiresOAuth: z.boolean(),
  notes: z.string().optional(),
});
export type SourceCapabilities = z.infer<typeof SourceCapabilitiesSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Scan request / session / checkpoint / error / progress
// ─────────────────────────────────────────────────────────────────────────────

export const ScanRequestSchema = z.object({
  sourceKind: SourceKindSchema,
  sourceAccountId: UuidSchema.nullable().optional(),
  rootPathOrSourceRef: z.string().min(1).max(2048),
  scanMode: ScanModeSchema.default("full"),
  includeHidden: z.boolean().default(false),
  followSymlinks: z.boolean().default(false),
  maxDepth: z.number().int().min(1).max(64).nullable().optional(),
  enableHashing: z.boolean().default(true),
  enablePerceptualHash: z.boolean().default(true),
  enableVideoFingerprint: z.boolean().default(false),
  enableDocumentTextExtraction: z.boolean().default(false),
  enableOcrPreparation: z.boolean().default(false),
  enableAiEnrichment: z.boolean().default(false),
  enableFaceProcessing: z.boolean().default(false),
  aiProcessingConsent: z.boolean().default(false),
  faceProcessingConsent: z.boolean().default(false),
  batchSize: z.number().int().min(1).max(1000).default(200),
  concurrency: z.number().int().min(1).max(16).default(4),
  familyId: UuidSchema.nullable().optional(),
});
export type ScanRequest = z.infer<typeof ScanRequestSchema>;

export const ScanSessionSchema = ScanRequestSchema.extend({
  id: UuidSchema,
  userId: UuidSchema,
  status: ScanStatusSchema,
  phase: ScanPhaseSchema,
  discoveredFiles: z.number().int().nonnegative(),
  supportedFiles: z.number().int().nonnegative(),
  processedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  errorFiles: z.number().int().nonnegative(),
  currentPathRedacted: z.string().nullable().optional(),
  startedAt: Iso8601Schema.nullable().optional(),
  completedAt: Iso8601Schema.nullable().optional(),
  cancelledAt: Iso8601Schema.nullable().optional(),
  createdAt: Iso8601Schema,
  updatedAt: Iso8601Schema,
});
export type ScanSession = z.infer<typeof ScanSessionSchema>;

export const ScanProgressSchema = z.object({
  scanId: UuidSchema,
  status: ScanStatusSchema,
  phase: ScanPhaseSchema,
  discoveredFiles: z.number().int().nonnegative(),
  supportedFiles: z.number().int().nonnegative(),
  processedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  errorFiles: z.number().int().nonnegative(),
  currentPathRedacted: z.string().nullable().optional(),
  percentComplete: z.number().min(0).max(100).nullable().optional(),
  startedAt: Iso8601Schema.nullable().optional(),
  updatedAt: Iso8601Schema,
  cancellationRequested: z.boolean(),
});
export type ScanProgress = z.infer<typeof ScanProgressSchema>;

export const ScanCheckpointSchema = z.object({
  id: UuidSchema.optional(),
  scanId: UuidSchema,
  userId: UuidSchema,
  checkpointType: z.enum(["auto", "manual", "cancel", "pause"]).default("auto"),
  directoryQueue: z.array(z.string()).default([]),
  providerCursor: z.string().nullable().optional(),
  lastProcessedPath: z.string().nullable().optional(),
  lastProcessedSourceAssetId: z.string().nullable().optional(),
  batchSequence: z.number().int().nonnegative().default(0),
  currentPhase: ScanPhaseSchema.optional(),
  checkpointPayload: z.record(z.unknown()).default({}),
});
export type ScanCheckpoint = z.infer<typeof ScanCheckpointSchema>;

export const ScanErrorCodeSchema = z.enum([
  "permission_denied", "not_found", "unreadable",
  "unsupported_format", "corrupt_file", "too_large",
  "extraction_failed", "hash_failed",
  "network_error", "rate_limited", "timeout",
  "validation_failed", "internal",
]);
export type ScanErrorCode = z.infer<typeof ScanErrorCodeSchema>;

export const ScanErrorStageSchema = z.enum([
  "traversal", "classification", "filesystem_metadata",
  "image_metadata", "exif", "xmp_iptc", "gps",
  "video_metadata", "document_metadata", "audio_metadata",
  "hashing", "perceptual_hash", "preview",
  "search_document", "persistence", "unknown",
]);
export type ScanErrorStage = z.infer<typeof ScanErrorStageSchema>;

export const ScanErrorSchema = z.object({
  scanId: UuidSchema,
  sourceAccountId: UuidSchema.nullable().optional(),
  sourceAssetId: z.string().nullable().optional(),
  filePathRedacted: z.string().nullable().optional(),
  errorCode: ScanErrorCodeSchema,
  errorMessage: z.string().max(2000),
  errorStage: ScanErrorStageSchema,
  isFatal: z.boolean().default(false),
  rawError: z.record(z.unknown()).nullable().optional(),
});
export type ScanError = z.infer<typeof ScanErrorSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Raw source asset (from connector listing) → canonical record
// ─────────────────────────────────────────────────────────────────────────────

export const RawSourceAssetMetadataSchema = z.object({
  mime: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  modifiedAt: Iso8601Schema.nullable().optional(),
  createdAt: Iso8601Schema.nullable().optional(),
  webUrl: z.string().url().nullable().optional(),
  downloadUrl: z.string().url().nullable().optional(),
  thumbnailUrl: z.string().url().nullable().optional(),
  etag: z.string().nullable().optional(),
  revisionId: z.string().nullable().optional(),
  contentHash: z.string().nullable().optional(),
});
export type RawSourceAssetMetadata = z.infer<typeof RawSourceAssetMetadataSchema>;

export const RawSourceAssetSchema = z.object({
  sourceKind: SourceKindSchema,
  sourceAccountId: UuidSchema.nullable().optional(),
  sourceAssetId: z.string().min(1),
  sourceUri: z.string().nullable().optional(),
  relativePath: z.string().nullable().optional(),
  absolutePathRedacted: z.string().nullable().optional(),
  normalizedAbsolutePathHash: z.string().nullable().optional(),
  filename: z.string(),
  extension: z.string().nullable().optional(),
  metadata: RawSourceAssetMetadataSchema.default({}),
});
export type RawSourceAsset = z.infer<typeof RawSourceAssetSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Extractor outputs (mirror DB tables)
// ─────────────────────────────────────────────────────────────────────────────

export const FileSystemMetadataSchema = z.object({
  absolutePathRedacted: z.string().nullable().optional(),
  normalizedAbsolutePathHash: z.string().nullable().optional(),
  relativePath: z.string().nullable().optional(),
  parentFolderPath: z.string().nullable().optional(),
  rootPathHash: z.string().nullable().optional(),
  folderDepth: z.number().int().nullable().optional(),
  filename: z.string().nullable().optional(),
  filenameWithoutExtension: z.string().nullable().optional(),
  extension: z.string().nullable().optional(),
  normalizedExtension: z.string().nullable().optional(),
  detectedFileType: z.string().nullable().optional(),
  fileSizeBytes: z.number().int().nullable().optional(),
  createdAtFilesystem: Iso8601Schema.nullable().optional(),
  modifiedAtFilesystem: Iso8601Schema.nullable().optional(),
  accessedAtFilesystem: Iso8601Schema.nullable().optional(),
  inode: z.string().nullable().optional(),
  deviceId: z.string().nullable().optional(),
  permissionsReadable: z.boolean().nullable().optional(),
  permissionsWritable: z.boolean().nullable().optional(),
  isHidden: z.boolean().nullable().optional(),
  isSymlink: z.boolean().nullable().optional(),
  symlinkTargetRedacted: z.string().nullable().optional(),
  scanDiscoveredAt: Iso8601Schema.nullable().optional(),
});
export type FileSystemMetadata = z.infer<typeof FileSystemMetadataSchema>;

export const MediaMetadataSchema = z.object({
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  aspectRatio: z.number().nullable().optional(),
  orientation: z.string().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  frameRate: z.number().nullable().optional(),
  bitDepth: z.number().int().nullable().optional(),
  colorProfile: z.string().nullable().optional(),
  colorSpace: z.string().nullable().optional(),
  hasAlpha: z.boolean().nullable().optional(),
  hasAudio: z.boolean().nullable().optional(),
  hasVideo: z.boolean().nullable().optional(),
  pageCount: z.number().int().nullable().optional(),
  wordCount: z.number().int().nullable().optional(),
  slideCount: z.number().int().nullable().optional(),
  sheetCount: z.number().int().nullable().optional(),
  encoding: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  thumbnailPossible: z.boolean().nullable().optional(),
  previewPossible: z.boolean().nullable().optional(),
  aiProcessingPossible: z.boolean().nullable().optional(),
  ocrPossible: z.boolean().nullable().optional(),
});
export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

export const ExifMetadataSchema = z.object({
  exifMake: z.string().nullable().optional(),
  exifModel: z.string().nullable().optional(),
  cameraMake: z.string().nullable().optional(),
  cameraModel: z.string().nullable().optional(),
  lensMake: z.string().nullable().optional(),
  lensModel: z.string().nullable().optional(),
  focalLength: z.number().nullable().optional(),
  focalLength35mm: z.number().nullable().optional(),
  aperture: z.number().nullable().optional(),
  fNumber: z.number().nullable().optional(),
  shutterSpeed: z.string().nullable().optional(),
  exposureTime: z.string().nullable().optional(),
  exposureMode: z.string().nullable().optional(),
  iso: z.number().int().nullable().optional(),
  flash: z.string().nullable().optional(),
  whiteBalance: z.string().nullable().optional(),
  meteringMode: z.string().nullable().optional(),
  software: z.string().nullable().optional(),
  imageUniqueId: z.string().nullable().optional(),
  orientation: z.string().nullable().optional(),
  exifCaptureTime: Iso8601Schema.nullable().optional(),
  exifOriginalTime: Iso8601Schema.nullable().optional(),
  exifDigitizedTime: Iso8601Schema.nullable().optional(),
  timezoneOffset: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  copyright: z.string().nullable().optional(),
  imageDescription: z.string().nullable().optional(),
});
export type ExifMetadata = z.infer<typeof ExifMetadataSchema>;

export const GpsMetadataSchema = z.object({
  gpsLatitude: z.number().min(-90).max(90).nullable().optional(),
  gpsLongitude: z.number().min(-180).max(180).nullable().optional(),
  gpsAltitude: z.number().nullable().optional(),
  gpsTimestamp: Iso8601Schema.nullable().optional(),
  gpsDirection: z.number().nullable().optional(),
  gpsSpeed: z.number().nullable().optional(),
  locationSource: z.string().nullable().optional(),
  locationConfidence: z.number().min(0).max(1).nullable().optional(),
  geohash: z.string().nullable().optional(),
  reverseGeocodedCity: z.string().nullable().optional(),
  reverseGeocodedState: z.string().nullable().optional(),
  reverseGeocodedCountry: z.string().nullable().optional(),
  reverseGeocodedCountryCode: z.string().length(2).nullable().optional(),
  placeName: z.string().nullable().optional(),
  timezoneFromLocation: z.string().nullable().optional(),
});
export type GpsMetadata = z.infer<typeof GpsMetadataSchema>;

export const XmpIptcMetadataSchema = z.object({
  xmpTitle: z.string().nullable().optional(),
  xmpDescription: z.string().nullable().optional(),
  xmpCreator: z.string().nullable().optional(),
  xmpRights: z.string().nullable().optional(),
  xmpKeywords: z.array(z.string()).nullable().optional(),
  xmpRating: z.number().int().min(0).max(5).nullable().optional(),
  iptcCaption: z.string().nullable().optional(),
  iptcHeadline: z.string().nullable().optional(),
  iptcKeywords: z.array(z.string()).nullable().optional(),
  iptcByline: z.string().nullable().optional(),
  iptcCredit: z.string().nullable().optional(),
  iptcSource: z.string().nullable().optional(),
  iptcCity: z.string().nullable().optional(),
  iptcState: z.string().nullable().optional(),
  iptcCountry: z.string().nullable().optional(),
  iptcSubjectCodes: z.array(z.string()).nullable().optional(),
  raw: z.record(z.unknown()).default({}),
});
export type XmpIptcMetadata = z.infer<typeof XmpIptcMetadataSchema>;

export const VideoMetadataSchema = z.object({
  videoCodec: z.string().nullable().optional(),
  videoBitrate: z.number().int().nullable().optional(),
  audioCodec: z.string().nullable().optional(),
  audioBitrate: z.number().int().nullable().optional(),
  audioChannels: z.number().int().nullable().optional(),
  audioSampleRate: z.number().int().nullable().optional(),
  rotation: z.number().int().nullable().optional(),
  hasHdr: z.boolean().nullable().optional(),
  containerFormat: z.string().nullable().optional(),
  raw: z.record(z.unknown()).default({}),
});
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;

export const DocumentMetadataSchema = z.object({
  docTitle: z.string().nullable().optional(),
  docAuthor: z.string().nullable().optional(),
  docSubject: z.string().nullable().optional(),
  docKeywords: z.array(z.string()).nullable().optional(),
  docProducer: z.string().nullable().optional(),
  docCreatorTool: z.string().nullable().optional(),
  pageCount: z.number().int().nullable().optional(),
  wordCount: z.number().int().nullable().optional(),
  language: z.string().nullable().optional(),
  hasTextLayer: z.boolean().nullable().optional(),
  isEncrypted: z.boolean().nullable().optional(),
  docCreatedAt: Iso8601Schema.nullable().optional(),
  docModifiedAt: Iso8601Schema.nullable().optional(),
  raw: z.record(z.unknown()).default({}),
});
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;

export const AudioMetadataSchema = z.object({
  title: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  album: z.string().nullable().optional(),
  albumArtist: z.string().nullable().optional(),
  composer: z.string().nullable().optional(),
  genre: z.string().nullable().optional(),
  trackNumber: z.number().int().nullable().optional(),
  discNumber: z.number().int().nullable().optional(),
  year: z.number().int().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  bitrate: z.number().int().nullable().optional(),
  sampleRate: z.number().int().nullable().optional(),
  channels: z.number().int().nullable().optional(),
  codec: z.string().nullable().optional(),
  hasCoverArt: z.boolean().nullable().optional(),
  raw: z.record(z.unknown()).default({}),
});
export type AudioMetadata = z.infer<typeof AudioMetadataSchema>;

export const HashMetadataSchema = z.object({
  fileHashSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  quickHash: z.string().nullable().optional(),
  partialHash: z.string().nullable().optional(),
  perceptualHashImage: z.string().nullable().optional(),
  videoFingerprint: z.string().nullable().optional(),
  audioFingerprint: z.string().nullable().optional(),
  textHash: z.string().nullable().optional(),
  hashAlgorithm: z.string().nullable().optional(),
  hashStatus: z.enum(["pending","partial","complete","error","skipped"]).default("pending"),
  hashError: z.string().nullable().optional(),
  hashCreatedAt: Iso8601Schema.nullable().optional(),
});
export type HashMetadata = z.infer<typeof HashMetadataSchema>;

export const PreviewMetadataSchema = z.object({
  blurhash: z.string().nullable().optional(),
  dominantColor: z.string().nullable().optional(),
  palette: z.array(z.string()).nullable().optional(),
  thumbnailGenerated: z.boolean().default(false),
  previewGenerated: z.boolean().default(false),
  thumbnailCacheKey: z.string().nullable().optional(),
  previewCacheKey: z.string().nullable().optional(),
});
export type PreviewMetadata = z.infer<typeof PreviewMetadataSchema>;

export const AiReadyMetadataSchema = z.object({
  aiProcessingPossible: z.boolean().default(false),
  aiProcessingConsent: z.boolean().default(false),
  ocrPossible: z.boolean().default(false),
  ocrStatus: ExtractionStatusSchema.default("pending"),
  captionStatus: ExtractionStatusSchema.default("pending"),
  labelsStatus: ExtractionStatusSchema.default("pending"),
  embeddingStatus: ExtractionStatusSchema.default("pending"),
  faceProcessingPossible: z.boolean().default(false),
  faceProcessingConsent: z.boolean().default(false),
});
export type AiReadyMetadata = z.infer<typeof AiReadyMetadataSchema>;

export const OrganizationSignalsSchema = z.object({
  folderTokens: z.array(z.string()).nullable().optional(),
  filenameTokens: z.array(z.string()).nullable().optional(),
  dateHint: z.string().nullable().optional(),  // YYYY-MM-DD
  yearHint: z.number().int().nullable().optional(),
  monthHint: z.number().int().min(1).max(12).nullable().optional(),
  eventHint: z.string().nullable().optional(),
  albumHint: z.string().nullable().optional(),
  tripHint: z.string().nullable().optional(),
  peopleHint: z.array(z.string()).nullable().optional(),
  duplicateStatus: z.string().nullable().optional(),
  duplicateGroupId: UuidSchema.nullable().optional(),
});
export type OrganizationSignals = z.infer<typeof OrganizationSignalsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Asset source reference (denormalized writer input)
// ─────────────────────────────────────────────────────────────────────────────

export const AssetSourceReferenceSchema = z.object({
  sourceAccountId: UuidSchema.nullable().optional(),
  sourceKind: SourceKindSchema,
  sourceProvider: z.string().nullable().optional(),
  sourceAssetId: z.string().min(1),
  sourceUri: z.string().nullable().optional(),
  sourceRelativePath: z.string().nullable().optional(),
  providerRevisionId: z.string().nullable().optional(),
  providerEtag: z.string().nullable().optional(),
  providerContentHash: z.string().nullable().optional(),
  providerThumbnailUrl: z.string().nullable().optional(),
  providerWebUrl: z.string().nullable().optional(),
  providerDownloadUrl: z.string().nullable().optional(),
  sourceCreatedAt: Iso8601Schema.nullable().optional(),
  sourceModifiedAt: Iso8601Schema.nullable().optional(),
  sourceUploadedAt: Iso8601Schema.nullable().optional(),
});
export type AssetSourceReference = z.infer<typeof AssetSourceReferenceSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Canonical metadata record — produced by extractor pipeline, consumed by
// /v1/scans/:id/batch ingest endpoint. One per discovered file.
// ─────────────────────────────────────────────────────────────────────────────

export const CanonicalMetadataRecordSchema = z.object({
  // identification
  mediaType: MediaTypeSchema,
  mimeType: z.string().nullable().optional(),
  captureTime: Iso8601Schema.nullable().optional(),
  captureTimeConfidence: z.number().min(0).max(1).nullable().optional(),
  timezone: z.string().nullable().optional(),

  // source lineage (required — drives idempotent upsert key)
  source: AssetSourceReferenceSchema,

  // extractor outputs (all optional — partial extraction is fine)
  fileSystem: FileSystemMetadataSchema.optional(),
  media:      MediaMetadataSchema.optional(),
  exif:       ExifMetadataSchema.optional(),
  gps:        GpsMetadataSchema.optional(),
  xmpIptc:    XmpIptcMetadataSchema.optional(),
  video:      VideoMetadataSchema.optional(),
  document:   DocumentMetadataSchema.optional(),
  audio:      AudioMetadataSchema.optional(),
  hashes:     HashMetadataSchema.optional(),
  preview:    PreviewMetadataSchema.optional(),
  aiReady:    AiReadyMetadataSchema.optional(),
  organization: OrganizationSignalsSchema.optional(),

  // server re-generates the canonical search_document; client may include a draft
  searchDocumentDraft: z.string().nullable().optional(),

  // per-record extraction failures (non-fatal — go into scan_errors)
  extractionErrors: z.array(z.object({
    stage: ScanErrorStageSchema,
    code: ScanErrorCodeSchema,
    message: z.string().max(1000),
  })).default([]),
});
export type CanonicalMetadataRecord = z.infer<typeof CanonicalMetadataRecordSchema>;

export const CanonicalAssetSchema = CanonicalMetadataRecordSchema.extend({
  id: UuidSchema,
  userId: UuidSchema,
});
export type CanonicalAsset = z.infer<typeof CanonicalAssetSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Metadata batch (HTTP wire format for /v1/scans/:id/batch)
// ─────────────────────────────────────────────────────────────────────────────

export const MetadataBatchSchema = z.object({
  scanId: UuidSchema,
  batchSequence: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(128),
  records: z.array(CanonicalMetadataRecordSchema).min(1).max(1000),
  progress: z.object({
    discoveredFiles: z.number().int().nonnegative(),
    supportedFiles: z.number().int().nonnegative(),
    skippedDelta: z.number().int().nonnegative().default(0),
    currentPathRedacted: z.string().nullable().optional(),
    phase: ScanPhaseSchema.optional(),
  }).optional(),
  errors: z.array(ScanErrorSchema.omit({ scanId: true })).default([]),
});
export type MetadataBatch = z.infer<typeof MetadataBatchSchema>;

export const BatchSummarySchema = z.object({
  scanId: UuidSchema,
  batchSequence: z.number().int().nonnegative(),
  assetsUpserted: z.number().int().nonnegative(),
  assetsSkipped: z.number().int().nonnegative(),
  errorsRecorded: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Connector interface (shared with existing supabase/functions/_sources/*)
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceConnector {
  getCapabilities(): SourceCapabilities;
  listAssets(params: {
    cursor?: string | null;
    pageSize?: number;
    signal?: AbortSignal;
  }): AsyncIterable<{ page: RawSourceAsset[]; nextCursor: string | null }>;
  extractMetadata?(asset: RawSourceAsset): Promise<CanonicalMetadataRecord>;
}

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`Not implemented: ${method}`);
    this.name = "NotImplementedError";
  }
}
