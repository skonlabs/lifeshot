// deno-lint-ignore-file no-explicit-any
/**
 * Batch persistence for the Universal Metadata Engine.
 * Idempotent upsert keyed on (source_account_id, source_asset_id).
 * One canonical asset row + N specialized metadata rows + source_ref.
 */
import type { SupabaseClient } from "../_shared/deps.ts";
import type {
  CanonicalMetadataRecord,
  MetadataBatch,
  BatchSummary,
} from "../../../packages/core/metadata/types.ts";
import { generateSearchDocument } from "./search-document.ts";

type Svc = SupabaseClient;

function mediaTypeToAssetType(t: string): string {
  if (t === "photo") return "photo";
  if (t === "video") return "video";
  if (t === "audio") return "audio";
  if (t === "document") return "document";
  return "other";
}

async function findOrCreateAsset(
  svc: Svc,
  userId: string,
  rec: CanonicalMetadataRecord,
  sourceAccountId: string | null,
): Promise<{ assetId: string; created: boolean }> {
  if (sourceAccountId) {
    const { data: ref } = await svc.from("asset_source_refs")
      .select("asset_id")
      .eq("source_account_id", sourceAccountId)
      .eq("source_asset_id", rec.source.sourceAssetId)
      .maybeSingle();
    if (ref?.asset_id) return { assetId: ref.asset_id as string, created: false };
  } else if (rec.fileSystem?.normalizedAbsolutePathHash) {
    const { data: existing } = await svc.from("asset_file_metadata")
      .select("asset_id")
      .eq("user_id", userId)
      .eq("normalized_absolute_path_hash", rec.fileSystem.normalizedAbsolutePathHash)
      .maybeSingle();
    if (existing?.asset_id) return { assetId: existing.asset_id as string, created: false };
  }

  const { data: created, error } = await svc.from("assets").insert({
    user_id: userId,
    media_type: mediaTypeToAssetType(rec.mediaType),
    mime_type: rec.mimeType ?? null,
    capture_time: rec.captureTime ?? null,
    timezone: rec.timezone ?? null,
    width: rec.media?.width ?? null,
    height: rec.media?.height ?? null,
    duration_ms: rec.media?.durationMs ?? null,
    file_size_bytes: rec.fileSystem?.fileSizeBytes ?? null,
    checksum_hash: rec.hashes?.fileHashSha256 ?? null,
    perceptual_hash: rec.hashes?.perceptualHashImage ?? null,
    location_lat: rec.gps?.gpsLatitude ?? null,
    location_lng: rec.gps?.gpsLongitude ?? null,
    device_make: rec.exif?.cameraMake ?? rec.exif?.exifMake ?? null,
    device_model: rec.exif?.cameraModel ?? rec.exif?.exifModel ?? null,
    status: "ingested",
  }).select("id").single();
  if (error) throw new Error(`insert assets: ${error.message}`);
  return { assetId: created!.id as string, created: true };
}

async function writeSourceRef(svc: Svc, userId: string, assetId: string, rec: CanonicalMetadataRecord, sourceAccountId: string | null) {
  const src = rec.source;
  await svc.from("asset_source_refs").upsert({
    asset_id: assetId,
    source_account_id: sourceAccountId,
    source_asset_id: src.sourceAssetId,
    user_id: userId,
    source_kind: src.sourceKind,
    source_provider: src.sourceProvider ?? null,
    source_uri: src.sourceUri ?? null,
    source_relative_path: src.sourceRelativePath ?? null,
    provider_revision_id: src.providerRevisionId ?? null,
    provider_etag: src.providerEtag ?? null,
    provider_content_hash: src.providerContentHash ?? null,
    provider_thumbnail_url: src.providerThumbnailUrl ?? null,
    provider_web_url: src.providerWebUrl ?? null,
    provider_download_url: src.providerDownloadUrl ?? null,
    source_created_at: src.sourceCreatedAt ?? null,
    source_modified_at: src.sourceModifiedAt ?? null,
    source_uploaded_at: src.sourceUploadedAt ?? null,
    source_last_seen_at: new Date().toISOString(),
    is_primary: true,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "source_account_id,source_asset_id" });
}

async function upsertOne(svc: Svc, table: string, row: Record<string, any>) {
  const cleaned = Object.fromEntries(Object.entries(row).filter(([_, v]) => v !== undefined));
  if (Object.keys(cleaned).length <= 2) return; // only asset_id + user_id
  const { error } = await svc.from(table).upsert(cleaned, { onConflict: "asset_id" });
  if (error) console.warn(`upsert ${table} failed:`, error.message);
}

async function writeMetadataRows(svc: Svc, userId: string, assetId: string, rec: CanonicalMetadataRecord) {
  const base = { asset_id: assetId, user_id: userId };

  if (rec.fileSystem) {
    const f = rec.fileSystem;
    await upsertOne(svc, "asset_file_metadata", {
      ...base,
      absolute_path_redacted: f.absolutePathRedacted,
      normalized_absolute_path_hash: f.normalizedAbsolutePathHash,
      relative_path: f.relativePath,
      parent_folder_path: f.parentFolderPath,
      root_path_hash: f.rootPathHash,
      folder_depth: f.folderDepth,
      filename: f.filename,
      filename_without_extension: f.filenameWithoutExtension,
      extension: f.extension,
      normalized_extension: f.normalizedExtension,
      detected_file_type: f.detectedFileType,
      file_size_bytes: f.fileSizeBytes,
      created_at_filesystem: f.createdAtFilesystem,
      modified_at_filesystem: f.modifiedAtFilesystem,
      accessed_at_filesystem: f.accessedAtFilesystem,
      is_hidden: f.isHidden,
      is_symlink: f.isSymlink,
      scan_discovered_at: f.scanDiscoveredAt,
    });
  }
  if (rec.media) {
    const m = rec.media;
    await upsertOne(svc, "asset_media_metadata", {
      ...base,
      width: m.width, height: m.height, aspect_ratio: m.aspectRatio,
      orientation: m.orientation, duration_ms: m.durationMs, frame_rate: m.frameRate,
      bit_depth: m.bitDepth, color_profile: m.colorProfile, color_space: m.colorSpace,
      has_alpha: m.hasAlpha, has_audio: m.hasAudio, has_video: m.hasVideo,
      page_count: m.pageCount, word_count: m.wordCount, slide_count: m.slideCount,
      sheet_count: m.sheetCount, encoding: m.encoding, language: m.language,
      thumbnail_possible: m.thumbnailPossible, preview_possible: m.previewPossible,
      ai_processing_possible: m.aiProcessingPossible, ocr_possible: m.ocrPossible,
    });
  }
  if (rec.exif) {
    const e = rec.exif;
    await upsertOne(svc, "asset_exif", {
      ...base,
      // Canonical camera identifiers (preferred); exif_make/model kept as aliases.
      camera_make: e.cameraMake ?? e.exifMake ?? null,
      camera_model: e.cameraModel ?? e.exifModel ?? null,
      exif_make: e.exifMake ?? e.cameraMake ?? null,
      exif_model: e.exifModel ?? e.cameraModel ?? null,
      lens_make: e.lensMake, lens_model: e.lensModel, lens: e.lensModel ?? null,
      // Exposure / optics — written so search & dedup can use them.
      iso: (e as any).iso ?? null,
      aperture: (e as any).aperture ?? null,
      f_number: e.fNumber ?? (e as any).aperture ?? null,
      shutter_speed: (e as any).shutterSpeed ?? null,
      exposure_time: e.exposureTime ?? null,
      exposure_mode: e.exposureMode ?? null,
      focal_length: (e as any).focalLength ?? null,
      focal_length_35mm: e.focalLength35mm ?? null,
      flash: (e as any).flash ?? null,
      white_balance: (e as any).whiteBalance ?? null,
      metering_mode: e.meteringMode ?? null,
      software: e.software,
      image_unique_id: e.imageUniqueId, orientation: e.orientation,
      exif_capture_time: e.exifCaptureTime, exif_original_time: e.exifOriginalTime,
      exif_digitized_time: e.exifDigitizedTime, timezone_offset: e.timezoneOffset,
      artist: e.artist, copyright: e.copyright, image_description: e.imageDescription,
    });
  }
  if (rec.gps) {
    const g = rec.gps;
    await upsertOne(svc, "asset_gps", {
      ...base,
      gps_latitude: g.gpsLatitude, gps_longitude: g.gpsLongitude,
      gps_altitude: g.gpsAltitude, gps_timestamp: g.gpsTimestamp,
      gps_direction: g.gpsDirection, gps_speed: g.gpsSpeed,
      location_source: g.locationSource, location_confidence: g.locationConfidence,
      geohash: g.geohash,
      reverse_geocoded_city: g.reverseGeocodedCity,
      reverse_geocoded_state: g.reverseGeocodedState,
      reverse_geocoded_country: g.reverseGeocodedCountry,
      reverse_geocoded_country_code: g.reverseGeocodedCountryCode,
      place_name: g.placeName,
      timezone_from_location: g.timezoneFromLocation,
    });
  }
  if (rec.xmpIptc) {
    const x = rec.xmpIptc;
    await upsertOne(svc, "asset_xmp_iptc", {
      ...base,
      xmp_title: x.xmpTitle, xmp_description: x.xmpDescription,
      xmp_creator: x.xmpCreator, xmp_rights: x.xmpRights,
      xmp_keywords: x.xmpKeywords, xmp_rating: x.xmpRating,
      iptc_caption: x.iptcCaption, iptc_headline: x.iptcHeadline,
      iptc_keywords: x.iptcKeywords, iptc_byline: x.iptcByline,
      iptc_credit: x.iptcCredit, iptc_source: x.iptcSource,
      iptc_city: x.iptcCity, iptc_state: x.iptcState, iptc_country: x.iptcCountry,
      iptc_subject_codes: x.iptcSubjectCodes,
      raw: x.raw ?? {},
    });
  }
  if (rec.video) {
    const v = rec.video;
    await upsertOne(svc, "asset_video_metadata", {
      ...base,
      video_codec: v.videoCodec, video_bitrate: v.videoBitrate,
      audio_codec: v.audioCodec, audio_bitrate: v.audioBitrate,
      audio_channels: v.audioChannels, audio_sample_rate: v.audioSampleRate,
      rotation: v.rotation, has_hdr: v.hasHdr, container_format: v.containerFormat,
      raw: v.raw ?? {},
    });
  }
  if (rec.document) {
    const d = rec.document;
    await upsertOne(svc, "asset_document_metadata", {
      ...base,
      doc_title: d.docTitle, doc_author: d.docAuthor, doc_subject: d.docSubject,
      doc_keywords: d.docKeywords, doc_producer: d.docProducer, doc_creator_tool: d.docCreatorTool,
      page_count: d.pageCount, word_count: d.wordCount, language: d.language,
      has_text_layer: d.hasTextLayer, is_encrypted: d.isEncrypted,
      doc_created_at: d.docCreatedAt, doc_modified_at: d.docModifiedAt,
      raw: d.raw ?? {},
    });
  }
  if (rec.audio) {
    const a = rec.audio;
    await upsertOne(svc, "asset_audio_metadata", {
      ...base,
      title: a.title, artist: a.artist, album: a.album, album_artist: a.albumArtist,
      composer: a.composer, genre: a.genre, track_number: a.trackNumber,
      disc_number: a.discNumber, year: a.year, duration_ms: a.durationMs,
      bitrate: a.bitrate, sample_rate: a.sampleRate, channels: a.channels,
      codec: a.codec, has_cover_art: a.hasCoverArt, raw: a.raw ?? {},
    });
  }
  if (rec.hashes) {
    const h = rec.hashes;
    await upsertOne(svc, "asset_hashes", {
      ...base,
      file_hash_sha256: h.fileHashSha256, quick_hash: h.quickHash, partial_hash: h.partialHash,
      perceptual_hash_image: h.perceptualHashImage, video_fingerprint: h.videoFingerprint,
      audio_fingerprint: h.audioFingerprint, text_hash: h.textHash,
      hash_algorithm: h.hashAlgorithm, hash_status: h.hashStatus,
      hash_error: h.hashError, hash_created_at: h.hashCreatedAt,
    });
  }
  if (rec.preview) {
    const p = rec.preview;
    await upsertOne(svc, "asset_preview_metadata", {
      ...base,
      blurhash: p.blurhash, dominant_color: p.dominantColor, palette: p.palette,
      thumbnail_generated: p.thumbnailGenerated, preview_generated: p.previewGenerated,
      thumbnail_cache_key: p.thumbnailCacheKey, preview_cache_key: p.previewCacheKey,
    });
  }
  if (rec.aiReady) {
    const ai = rec.aiReady;
    await upsertOne(svc, "asset_ai_ready_metadata", {
      ...base,
      ai_processing_possible: ai.aiProcessingPossible,
      ai_processing_consent: ai.aiProcessingConsent,
      ocr_possible: ai.ocrPossible, ocr_status: ai.ocrStatus,
      caption_status: ai.captionStatus, labels_status: ai.labelsStatus,
      embedding_status: ai.embeddingStatus,
      face_processing_possible: ai.faceProcessingPossible,
      face_processing_consent: ai.faceProcessingConsent,
    });
  }
  if (rec.organization) {
    const o = rec.organization;
    await upsertOne(svc, "asset_organization_signals", {
      ...base,
      folder_tokens: o.folderTokens, filename_tokens: o.filenameTokens,
      date_hint: o.dateHint, year_hint: o.yearHint, month_hint: o.monthHint,
      event_hint: o.eventHint, album_hint: o.albumHint, trip_hint: o.tripHint,
      people_hint: o.peopleHint,
      duplicate_status: o.duplicateStatus, duplicate_group_id: o.duplicateGroupId,
    });
  }

  // Search document: prefer server-generated narrative.
  const doc = generateSearchDocument(rec);
  try {
    await svc.from("asset_search_documents").upsert({
      asset_id: assetId,
      user_id: userId,
      document_text: doc,
      updated_at: new Date().toISOString(),
    }, { onConflict: "asset_id" });
  } catch (_e) { /* table may not exist in some envs */ }
}

export async function ingestBatch(
  svc: Svc,
  userId: string,
  scanId: string,
  sourceAccountId: string | null,
  batch: MetadataBatch,
): Promise<BatchSummary> {
  const start = Date.now();

  // Idempotency: skip if already recorded.
  const { data: existing } = await svc.from("scan_batches")
    .select("id, status, asset_count").eq("scan_id", scanId)
    .eq("idempotency_key", batch.idempotencyKey).maybeSingle();
  if (existing && existing.status === "completed") {
    return {
      scanId, batchSequence: batch.batchSequence,
      assetsUpserted: existing.asset_count ?? 0,
      assetsSkipped: 0, errorsRecorded: 0,
      durationMs: Date.now() - start,
    };
  }

  const { data: batchRow } = await svc.from("scan_batches").upsert({
    scan_id: scanId, user_id: userId, batch_sequence: batch.batchSequence,
    asset_count: batch.records.length, status: "processing",
    idempotency_key: batch.idempotencyKey,
  }, { onConflict: "scan_id,batch_sequence" }).select("id").single();

  let upserted = 0;
  let skipped = 0;
  let errors = 0;
  for (const rec of batch.records) {
    try {
      const { assetId } = await findOrCreateAsset(svc, userId, rec, sourceAccountId);
      await writeSourceRef(svc, userId, assetId, rec, sourceAccountId);
      await writeMetadataRows(svc, userId, assetId, rec);
      upserted++;
      for (const extErr of rec.extractionErrors ?? []) {
        await svc.from("scan_errors").insert({
          scan_id: scanId, user_id: userId,
          source_account_id: sourceAccountId,
          source_asset_id: rec.source.sourceAssetId,
          file_path_redacted: rec.fileSystem?.absolutePathRedacted ?? null,
          error_code: extErr.code, error_message: extErr.message,
          error_stage: extErr.stage, is_fatal: false,
        });
        errors++;
      }
    } catch (e) {
      skipped++;
      errors++;
      await svc.from("scan_errors").insert({
        scan_id: scanId, user_id: userId,
        source_account_id: sourceAccountId,
        source_asset_id: rec.source.sourceAssetId,
        file_path_redacted: rec.fileSystem?.absolutePathRedacted ?? null,
        error_code: "persistence",
        error_message: e instanceof Error ? e.message : String(e),
        error_stage: "persistence", is_fatal: false,
      });
    }
  }

  // Record additional pre-extraction errors from the batch envelope.
  for (const err of batch.errors ?? []) {
    await svc.from("scan_errors").insert({
      scan_id: scanId, user_id: userId,
      source_account_id: err.sourceAccountId ?? sourceAccountId,
      source_asset_id: err.sourceAssetId ?? null,
      file_path_redacted: err.filePathRedacted ?? null,
      error_code: err.errorCode, error_message: err.errorMessage,
      error_stage: err.errorStage, is_fatal: err.isFatal ?? false,
      raw_error: err.rawError ?? null,
    });
    errors++;
  }

  await svc.from("scan_batches").update({
    status: "completed", completed_at: new Date().toISOString(),
  }).eq("id", batchRow!.id);

  // Bump session counters and current path.
  const { data: sess } = await svc.from("scan_sessions")
    .select("processed_files, error_files, skipped_files, discovered_files, supported_files")
    .eq("id", scanId).maybeSingle();
  if (sess) {
    await svc.from("scan_sessions").update({
      processed_files: (sess.processed_files ?? 0) + upserted,
      error_files: (sess.error_files ?? 0) + errors,
      skipped_files: (sess.skipped_files ?? 0) + skipped,
      discovered_files: Math.max(sess.discovered_files ?? 0, batch.progress?.discoveredFiles ?? 0),
      supported_files: Math.max(sess.supported_files ?? 0, batch.progress?.supportedFiles ?? 0),
      current_path_redacted: batch.progress?.currentPathRedacted ?? null,
      phase: batch.progress?.phase ?? "extracting",
      status: "running",
      updated_at: new Date().toISOString(),
    }).eq("id", scanId);
  }

  return {
    scanId, batchSequence: batch.batchSequence,
    assetsUpserted: upserted, assetsSkipped: skipped,
    errorsRecorded: errors, durationMs: Date.now() - start,
  };
}