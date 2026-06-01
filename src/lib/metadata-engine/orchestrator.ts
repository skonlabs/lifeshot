/**
 * Browser scan orchestrator — drives traversal, classification, extraction,
 * batching, progress reporting, and idempotent batch POST to /scans/:id/batch.
 * Cancellable via AbortController. Per-file errors never abort the scan.
 */
import type {
  CanonicalMetadataRecord, MetadataBatch, MediaType, ScanError,
} from "../../../packages/core/metadata/types";
import { classify, isSupported } from "./classifier";
import { walk } from "./traverser";
import {
  extractFileSystem, extractImageDimensions, extractVideoMeta,
  extractAudioMeta, extractDocumentMeta, extractExifLite,
  streamingSha256, quickHash, sha256Hex,
} from "./extractors";
import { startScan, sendBatch, finalizeScan } from "./sync-client";

export interface ScanOptions {
  rootHandle: FileSystemDirectoryHandle;
  rootLabel: string;
  enableHashing?: boolean;
  includeHidden?: boolean;
  maxDepth?: number | null;
  batchSize?: number;
  onProgress?: (p: ProgressUpdate) => void;
  signal?: AbortSignal;
}

export interface ProgressUpdate {
  discovered: number;
  supported: number;
  processed: number;
  skipped: number;
  errors: number;
  currentPath: string | null;
  phase: "discovering" | "extracting" | "uploading" | "finalizing" | "completed" | "cancelled" | "failed";
}

function redactPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return ".../" + parts.slice(-2).join("/");
}

export async function runLocalScan(opts: ScanOptions): Promise<{ scanId: string }> {
  const batchSize = opts.batchSize ?? 50;
  const enableHashing = opts.enableHashing ?? true;
  const rootPathHash = await sha256Hex(opts.rootLabel.toLowerCase());

  const { scan } = await startScan({
    sourceKind: "local_folder",
    rootPathOrSourceRef: opts.rootLabel,
    scanMode: "full",
    includeHidden: !!opts.includeHidden,
    followSymlinks: false,
    maxDepth: opts.maxDepth ?? null,
    enableHashing,
    enablePerceptualHash: false,
    enableVideoFingerprint: false,
    enableDocumentTextExtraction: false,
    enableOcrPreparation: false,
    enableAiEnrichment: false,
    enableFaceProcessing: false,
    aiProcessingConsent: false,
    faceProcessingConsent: false,
    batchSize,
    concurrency: 4,
  });
  const scanId: string = scan.id;

  const counters = {
    discovered: 0, supported: 0, processed: 0, skipped: 0, errors: 0,
    currentPath: null as string | null,
  };
  const emit = (phase: ProgressUpdate["phase"]) => {
    opts.onProgress?.({
      discovered: counters.discovered, supported: counters.supported,
      processed: counters.processed, skipped: counters.skipped,
      errors: counters.errors, currentPath: counters.currentPath, phase,
    });
  };

  let batchSequence = 0;
  let pending: CanonicalMetadataRecord[] = [];
  let pendingErrors: Omit<ScanError, "scanId">[] = [];

  const flush = async (final = false) => {
    if (!pending.length && !pendingErrors.length) return;
    const seq = batchSequence++;
    const idem = `scan:${scanId}:b:${seq}`;
    const batch: MetadataBatch = {
      scanId,
      batchSequence: seq,
      idempotencyKey: idem,
      records: pending.length
        ? pending
        : [{
            mediaType: "other" as MediaType,
            source: { sourceKind: "local_folder", sourceAssetId: `__empty_${seq}` },
            extractionErrors: [],
          }],
      progress: {
        discoveredFiles: counters.discovered,
        supportedFiles: counters.supported,
        skippedDelta: 0,
        currentPathRedacted: counters.currentPath,
        phase: final ? "finalizing" : "extracting",
      },
      errors: pendingErrors,
    };
    pending = [];
    pendingErrors = [];
    try {
      await sendBatch(scanId, batch);
    } catch (e) {
      counters.errors++;
      // surface but keep going
      console.error("batch send failed", e);
    }
  };

  emit("discovering");
  try {
    for await (const item of walk(opts.rootHandle, {
      maxDepth: opts.maxDepth ?? null,
      includeHidden: !!opts.includeHidden,
      signal: opts.signal,
    })) {
      if (opts.signal?.aborted) break;
      counters.discovered++;
      counters.currentPath = redactPath(item.relativePath);

      const cls = classify(item.file.name, item.file.type);
      if (cls.ignored) { counters.skipped++; continue; }
      if (!isSupported(cls.mediaType)) { counters.skipped++; continue; }
      counters.supported++;

      try {
        const absPath = `${opts.rootLabel}/${item.relativePath}`;
        const absHash = await sha256Hex(absPath.toLowerCase());
        const fs = extractFileSystem(item.file, {
          relativePath: item.relativePath,
          absolutePathRedacted: redactPath(absPath),
          normalizedAbsolutePathHash: absHash,
          rootPathHash,
          folderDepth: item.folderDepth,
          classification: { extension: cls.extension, normalizedExtension: cls.normalizedExtension, mediaType: cls.mediaType },
        });

        let media: any = null;
        let video: any = null;
        let audio: any = null;
        let document: any = null;
        let exif: any = null;
        let gps: any = null;
        let captureTime: string | null = null;

        if (cls.mediaType === "photo") {
          media = await extractImageDimensions(item.file);
          const r = await extractExifLite(item.file);
          exif = r.exif; gps = r.gps;
          captureTime = exif?.exifCaptureTime ?? new Date(item.file.lastModified).toISOString();
        } else if (cls.mediaType === "video") {
          const r = await extractVideoMeta(item.file);
          media = r?.media ?? null; video = r?.video ?? null;
          captureTime = new Date(item.file.lastModified).toISOString();
        } else if (cls.mediaType === "audio") {
          audio = await extractAudioMeta(item.file);
          media = audio ? { durationMs: audio.durationMs, hasAudio: true, hasVideo: false } : null;
          captureTime = new Date(item.file.lastModified).toISOString();
        } else if (cls.mediaType === "document") {
          document = await extractDocumentMeta(item.file);
          captureTime = new Date(item.file.lastModified).toISOString();
        }

        let hashes: any = null;
        if (enableHashing) {
          const sha = await streamingSha256(item.file);
          const qh = await quickHash(item.file);
          hashes = {
            fileHashSha256: sha,
            quickHash: qh,
            hashAlgorithm: "sha-256",
            hashStatus: sha ? "complete" : "partial",
            hashCreatedAt: new Date().toISOString(),
          };
        }

        const sourceAssetId = `local:${absHash}`;
        const rec: CanonicalMetadataRecord = {
          mediaType: cls.mediaType,
          mimeType: item.file.type || null,
          captureTime,
          source: {
            sourceKind: "local_folder",
            sourceAssetId,
            sourceRelativePath: item.relativePath,
            sourceModifiedAt: new Date(item.file.lastModified).toISOString(),
          },
          fileSystem: fs,
          media: media ?? undefined,
          exif: exif ?? undefined,
          gps: gps ?? undefined,
          video: video ?? undefined,
          audio: audio ?? undefined,
          document: document ?? undefined,
          hashes: hashes ?? undefined,
          organization: {
            folderTokens: item.relativePath.split("/").slice(0, -1).filter(Boolean),
            filenameTokens: item.file.name.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean),
          },
          extractionErrors: [],
        };
        pending.push(rec);

        if (pending.length >= batchSize) {
          emit("uploading");
          await flush();
        }

        counters.processed++;
        if (counters.processed % 10 === 0) emit("extracting");
      } catch (err: any) {
        counters.errors++;
        pendingErrors.push({
          errorCode: "extraction_failed",
          errorMessage: String(err?.message ?? err).slice(0, 1000),
          errorStage: "unknown",
          isFatal: false,
          filePathRedacted: counters.currentPath,
        });
      }
    }

    emit("uploading");
    await flush(true);
    emit("finalizing");
    await finalizeScan(scanId);
    emit(opts.signal?.aborted ? "cancelled" : "completed");
  } catch (e) {
    console.error("scan failed", e);
    emit("failed");
    throw e;
  }

  return { scanId };
}