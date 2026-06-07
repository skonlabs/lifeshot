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
  }
  // asset_file_metadata path-hash lookup was removed when that table was
  // dropped in the B-NUKE consolidation. Local/browser scans without a
  // source_account_id now always create a new asset (idempotency handled by
  // checksum_hash dedup downstream).

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
    filename: rec.fileSystem?.filename ?? null,
    relative_path: rec.fileSystem?.relativePath ?? null,
    parent_folder_path: rec.fileSystem?.parentFolderPath ?? null,
    checksum_hash: rec.hashes?.fileHashSha256 ?? null,
    perceptual_hash: rec.hashes?.perceptualHashImage ?? null,
    video_fingerprint: rec.hashes?.videoFingerprint ?? null,
    device_make: rec.exif?.cameraMake ?? rec.exif?.exifMake ?? null,
    device_model: rec.exif?.cameraModel ?? rec.exif?.exifModel ?? null,
    status: "ingested",
  }).select("id").single();
  if (error) throw new Error(`insert assets: ${error.message}`);
  // Location data lives in asset_gps (canonical store); insert if coords present.
  if (rec.gps?.gpsLatitude != null && rec.gps?.gpsLongitude != null) {
    await svc.from("asset_gps").upsert({
      asset_id: created!.id,
      user_id: userId,
      gps_latitude: rec.gps.gpsLatitude,
      gps_longitude: rec.gps.gpsLongitude,
      location_source: "canonical_record",
    }, { onConflict: "asset_id" });
  }
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
    // asset_file_metadata dropped → filename / paths now on `assets` directly.
    await svc.from("assets").update({
      filename: f.filename ?? null,
      relative_path: f.relativePath ?? null,
      parent_folder_path: f.parentFolderPath ?? null,
      file_size_bytes: f.fileSizeBytes ?? null,
    }).eq("id", assetId);
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
  // asset_xmp_iptc was dropped in B-NUKE; XMP/IPTC fields are no longer persisted.
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
    // asset_hashes dropped → sha256 / phash / video_fingerprint live on assets.
    const patch: Record<string, unknown> = {};
    if (h.fileHashSha256) patch.checksum_hash = h.fileHashSha256;
    if (h.perceptualHashImage) patch.perceptual_hash = h.perceptualHashImage;
    if (h.videoFingerprint) patch.video_fingerprint = h.videoFingerprint;
    if (Object.keys(patch).length) await svc.from("assets").update(patch).eq("id", assetId);
  }
  if (rec.preview) {
    const p = rec.preview;
    // asset_preview_metadata dropped → blurhash/thumbnail cache key live on
    // assets + asset_media_metadata.
    const tk = p.thumbnailCacheKey ?? null;
    const pk = p.previewCacheKey ?? null;
    await upsertOne(svc, "asset_media_metadata", {
      ...base,
      blurhash: p.blurhash ?? null,
      dominant_color: p.dominantColor ?? null,
      palette: p.palette ?? null,
      thumbnail_url: tk && /^https?:\/\//.test(tk) ? tk : null,
      thumbnail_storage_path: tk && !/^https?:\/\//.test(tk) ? tk : null,
      preview_url: pk && /^https?:\/\//.test(pk) ? pk : null,
      preview_storage_path: pk && !/^https?:\/\//.test(pk) ? pk : null,
    });
  }
  // asset_ai_ready_metadata was dropped → status is derived live from privacy_settings.
  if (rec.organization) {
    const o = rec.organization;
    // asset_organization_signals dropped → tokens live on assets.
    const patch: Record<string, unknown> = {};
    if (o.folderTokens) patch.folder_tokens = o.folderTokens;
    if (o.filenameTokens) patch.filename_tokens = o.filenameTokens;
    if (o.duplicateGroupId) patch.duplicate_group_id = o.duplicateGroupId;
    if (Object.keys(patch).length) await svc.from("assets").update(patch).eq("id", assetId);
  }

  // Search document: write directly to assets.search_content (trigger refreshes tsv).
  const doc = generateSearchDocument(rec);
  await svc.from("assets").update({ search_content: doc }).eq("id", assetId);
}

export async function ingestBatch(
  svc: Svc,
  userId: string,
  scanId: string,
  sourceAccountId: string | null,
  batch: MetadataBatch,
): Promise<BatchSummary> {
  const start = Date.now();

  // scan_batches/scan_sessions/scan_errors were dropped in B-NUKE. The scans
  // edge function now only routes batches into ingest; per-batch dedup is
  // delegated to job_ledger via job idempotency keys upstream.

  let upserted = 0;
  let skipped = 0;
  let errors = 0;
  for (const rec of batch.records) {
    try {
      const { assetId } = await findOrCreateAsset(svc, userId, rec, sourceAccountId);
      await writeSourceRef(svc, userId, assetId, rec, sourceAccountId);
      await writeMetadataRows(svc, userId, assetId, rec);
      upserted++;
      errors += (rec.extractionErrors ?? []).length;
    } catch (e) {
      skipped++;
      errors++;
      console.warn("persistence error", { source_asset_id: rec.source.sourceAssetId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  errors += (batch.errors ?? []).length;

  return {
    scanId, batchSequence: batch.batchSequence,
    assetsUpserted: upserted, assetsSkipped: skipped,
    errorsRecorded: errors, durationMs: Date.now() - start,
  };
}