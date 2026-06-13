// deno-lint-ignore-file no-explicit-any
/**
 * normalizeMetadata — extracts and persists metadata for every asset type.
 *
 * Two separate phases:
 *  1. Provider-agnostic writes (file_metadata, org_signals, ai_ready_metadata,
 *     asset_media_metadata, stub exif/gps from API fields) — always run even
 *     when connector fails, using data already on the assets + refs rows.
 *  2. Byte-level EXIF/GPS/XMP extraction via exifr — only for connectors that
 *     support range-fetch, best-effort inside its own isolated try-catch.
 */
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import { nudgeWorkerDrain as wakeWorkerDrain } from "../_pipeline/worker-wake.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { getConnector } from "../_sources/registry.ts";
import { fetchAllBytes, fetchHeadBytes } from "../_extractors/fetch-bytes.ts";
import { extractExifFromBytes, extractExifFromBytesRaw } from "../_extractors/exif.ts";

// Many JPEGs (esp. iPhone) place an embedded thumbnail BEFORE the GPS IFD,
// pushing GPS past the first 384 KB. Bump to 2 MB so the first pass catches
// GPS in the vast majority of files; if still missing we retry up to 8 MB.
const HEAD_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES_RETRY = 8 * 1024 * 1024;
const FULL_EXIF_FETCH_CAP = 32 * 1024 * 1024;

async function nudgeWorkerDrain() {
  await wakeWorkerDrain({ batch: 4, budgetMs: 50_000 });
}

async function nudgeNormalizeDrain() {
  await wakeWorkerDrain({ batch: 12, budgetMs: 50_000, lanes: ["ingest"] });
}

function geohashEncode(lat: number, lng: number, precision = 9): string {
  const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  let minLat = -90, maxLat = 90, minLng = -180, maxLng = 180;
  let bit = 0, ch = 0, even = true;
  let out = "";
  while (out.length < precision) {
    if (even) {
      const mid = (minLng + maxLng) / 2;
      if (lng >= mid) { ch = (ch << 1) | 1; minLng = mid; } else { ch = ch << 1; maxLng = mid; }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; minLat = mid; } else { ch = ch << 1; maxLat = mid; }
    }
    even = !even;
    if (++bit === 5) { out += BASE32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

function inferMediaFlags(mime: string, mediaType: string | null) {
  const normalizedType = mediaType ?? "other";
  return {
    isImage: mime.startsWith("image/") || normalizedType === "photo",
    isVideo: mime.startsWith("video/") || normalizedType === "video",
    isAudio: mime.startsWith("audio/") || normalizedType === "audio",
    isDocument: normalizedType === "document" || [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/plain",
      "text/csv",
      "application/json",
    ].includes(mime),
  };
}

function inferOrganizationSignals(relativePath: string | null, filename: string | null) {
  const folderParts = (relativePath ?? "")
    .split("/")
    .filter(Boolean)
    .slice(0, -1);
  const filenameTokens = (filename ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  const joined = `${folderParts.join(" ")} ${filenameTokens.join(" ")}`;
  const dateMatch = joined.match(/(20\d{2})[-_/. ]?(0[1-9]|1[0-2])[-_/. ]?(0[1-9]|[12]\d|3[01])?/);
  const yearHint = dateMatch ? Number(dateMatch[1]) : null;
  const monthHint = dateMatch && dateMatch[2] ? Number(dateMatch[2]) : null;
  const dateHint = dateMatch && dateMatch[3]
    ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
    : null;

  return {
    folder_tokens: folderParts,
    filename_tokens: filenameTokens,
    year_hint: yearHint,
    month_hint: monthHint,
    date_hint: dateHint,
    album_hint: folderParts.at(-1) ?? null,
    trip_hint: folderParts.find((segment) => /trip|travel|vacation|holiday/i.test(segment)) ?? null,
    event_hint: folderParts.find((segment) => /wedding|birthday|party|graduation|anniversary|event/i.test(segment)) ?? null,
  };
}

async function upsertLog<T extends Record<string, unknown>>(
  sb: ReturnType<typeof serviceClient>,
  table: string,
  row: T,
  opts: { onConflict: string },
  context: string,
): Promise<boolean> {
  const { error } = await (sb.from(table) as any).upsert(row, opts);
  if (error) {
    console.error(`normalizeMetadata ${context}: ${table} upsert failed`, {
      error: error.message,
      code: error.code,
    });
    return false;
  }
  return true;
}

export async function normalizeMetadata(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id, source_account_id, sync_run_id, force_sync_run_id } = ctx.payload as {
    asset_id: string;
    source_account_id?: string;
    sync_run_id?: string;
    force_sync_run_id?: string;
  };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { data: asset, error } = await sb.from("assets")
    .select("id, user_id, media_type, mime_type, capture_time, timezone, width, height, duration_ms, device_make, device_model, thumbnail_cache_key, proxy_cache_key")
    .eq("id", asset_id).single();
  // Asset row may not be visible yet right after sync enqueues us (commit
  // race). Treat as retryable so the runner uses short backoff, not 24h.
  if (error || !asset) throw new Error("retryable: asset row not visible yet");

  const { data: ref } = await sb.from("asset_source_refs")
    .select("source_account_id, source_asset_id, source_relative_path, provider_url, source_modified_at, is_primary")
    .eq("asset_id", asset_id).order("is_primary", { ascending: false }).limit(1).maybeSingle();

  // Canonical location store. syncSource writes here directly; we read it for
  // backwards-compat with assets that already had a row.
  const { data: gpsRow } = await sb.from("asset_gps")
    .select("gps_latitude, gps_longitude")
    .eq("asset_id", asset_id)
    .maybeSingle();
  const existingLat = gpsRow?.gps_latitude != null ? Number(gpsRow.gps_latitude) : null;
  const existingLng = gpsRow?.gps_longitude != null ? Number(gpsRow.gps_longitude) : null;

  const mime = asset.mime_type ?? "";
  const { isImage, isVideo, isAudio, isDocument } = inferMediaFlags(mime, asset.media_type);

  // ── Phase 1: Provider-agnostic writes ──────────────────────────────────────
  // These use only data already on the assets / asset_source_refs rows and run
  // unconditionally — they are NOT inside the connector try-catch below so a
  // connector error can never silence them.

  const rel = ref ? ((ref.source_relative_path || ref.provider_url || "") as string) : "";
  const filename = rel ? (rel.split("/").filter(Boolean).pop() ?? null) : null;
  const dot = filename ? filename.lastIndexOf(".") : -1;
  const currentFolder = rel
    ? (rel.split("/").filter(Boolean).slice(0, -1).join("/") || "Root")
    : null;

  // Show current filename in the sync-job progress UI.
  if (rel && source_account_id) {
    try {
      const currentFile = filename ?? rel;
      const { data: runningJob } = await sb.from("source_sync_jobs")
        .select("id, stats")
        .eq("source_account_id", source_account_id)
        .order("created_at", { ascending: false })
        .limit(1).maybeSingle();
      if (runningJob) {
        const merged = {
          ...(typeof runningJob.stats === "object" && runningJob.stats !== null ? runningJob.stats as Record<string, unknown> : {}),
          ...(currentFolder ? { current_folder: currentFolder } : {}),
          current_file: currentFile,
        };
        await sb.from("source_sync_jobs").update({ stats: merged }).eq("id", runningJob.id);
      }
    } catch {
      // best-effort progress update
    }
  }

  // file_metadata + organization_signals consolidated onto `assets` in B-NUKE.
  if (rel) {
    const orgSignals = inferOrganizationSignals(rel, filename);
    await sb.from("assets").update({
      filename,
      relative_path: rel,
      parent_folder_path: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null,
      folder_tokens: orgSignals.folder_tokens,
      filename_tokens: orgSignals.filename_tokens,
    }).eq("id", asset_id);
  }

  // asset_media_metadata — write whatever dimensions / flags we already know.
  // For images, this avoids an empty row when EXIF byte-fetch is unavailable.
  const w = asset.width ?? null;
  const h = asset.height ?? null;
  await upsertLog(sb, "asset_media_metadata", {
    asset_id, user_id: asset.user_id,
    width: w, height: h,
    aspect_ratio: w && h ? Number(w) / Number(h) : null,
    has_audio: isAudio || isVideo,
    has_video: isVideo,
    has_alpha: false,
    thumbnail_possible: isImage || isVideo || isDocument,
    preview_possible: isImage || isVideo || isDocument,
    ai_processing_possible: isImage || isVideo || isDocument,
    ocr_possible: isImage || isDocument,
  }, { onConflict: "asset_id" }, "phase1");

  // asset_preview_metadata dropped → cache keys persisted on asset_media_metadata.
  {
    const tk = asset.thumbnail_cache_key ?? null;
    const pk = asset.proxy_cache_key ?? null;
    await upsertLog(sb, "asset_media_metadata", {
      asset_id, user_id: asset.user_id,
      thumbnail_url: tk && /^https?:\/\//.test(tk) ? tk : null,
      thumbnail_storage_path: tk && !/^https?:\/\//.test(tk) ? tk : null,
      preview_url: pk && /^https?:\/\//.test(pk) ? pk : null,
      preview_storage_path: pk && !/^https?:\/\//.test(pk) ? pk : null,
    }, { onConflict: "asset_id" }, "phase1-preview");
  }

  // For images: always write an asset_exif stub so phase 2 can upsert richer
  // data on top. Without this, assets lacking device_make/model still get a row.
  if (isImage) {
    await upsertLog(sb, "asset_exif", {
      asset_id, user_id: asset.user_id,
      camera_make: asset.device_make ?? null,
      camera_model: asset.device_model ?? null,
      exif_make: asset.device_make ?? null,
      exif_model: asset.device_model ?? null,
      exif_capture_time: asset.capture_time ?? null,
      exif_original_time: asset.capture_time ?? null,
    }, { onConflict: "asset_id" }, "phase1");
  }

  // For images/videos with provider-supplied GPS (already in asset_gps from
  // syncSource), ensure geohash is set.
  if ((isImage || isVideo) && existingLat != null && existingLng != null) {
    await upsertLog(sb, "asset_gps", {
      asset_id, user_id: asset.user_id,
      gps_latitude: existingLat,
      gps_longitude: existingLng,
      location_source: "provider_api",
      location_confidence: 0.9,
      geohash: geohashEncode(existingLat, existingLng, 9),
    }, { onConflict: "asset_id" }, "phase1");
  }

  // Type-specific metadata stubs — written now so downstream jobs have
  // something to work with even before phase 2 enrichment completes.
  if (isVideo) {
    await upsertLog(sb, "asset_video_metadata", {
      asset_id, user_id: asset.user_id,
      container_format: mime.split("/")[1] ?? null,
      raw: {},
    }, { onConflict: "asset_id" }, "phase1");
  }
  if (isAudio) {
    await upsertLog(sb, "asset_audio_metadata", {
      asset_id, user_id: asset.user_id,
      duration_ms: (asset as any).duration_ms ?? null,
      raw: {},
    }, { onConflict: "asset_id" }, "phase1");
  }
  if (isDocument) {
    await upsertLog(sb, "asset_document_metadata", {
      asset_id, user_id: asset.user_id,
      doc_title: filename ?? null,
      raw: {},
    }, { onConflict: "asset_id" }, "phase1");
  }

  // asset_ai_ready_metadata dropped — readiness derived live from
  // privacy_settings + media flags by the AI jobs themselves.

  // assets.status was dropped in the schema cleanup — no status write needed.

  // ── Phase 2: Byte-level EXIF/GPS/XMP extraction ───────────────────────────
  // Isolated in its own try-catch so any connector/network error never prevents
  // phase 1 data (above) from being used by downstream jobs.

  let byteExtractionSuccess = false;
  let hasGpsData = existingLat != null && existingLng != null;
  const phase2Diag: Record<string, unknown> = {};

  if (ref?.source_account_id && ref?.source_asset_id && isImage) {
    try {
      const { data: acct } = await sb.from("source_accounts")
        .select("provider_id, provider_kind").eq("id", ref.source_account_id).single();
      let providerKind: any = acct?.provider_kind;
      if (!providerKind && acct?.provider_id) {
        const { data: pr } = await sb.from("source_providers").select("kind").eq("id", acct.provider_id).single();
        providerKind = pr?.kind;
      }

      if (providerKind) {
        const conn = getConnector(providerKind, {
          source_account_id: ref.source_account_id, user_id: asset.user_id, provider_kind: providerKind,
        }, sb);

        let head = await fetchHeadBytes(conn, ref.source_asset_id, HEAD_BYTES);
        console.log("normalizeMetadata phase2 head fetched", { asset_id, bytes: head?.bytes?.byteLength ?? 0 });
        phase2Diag.headBytes = head?.bytes?.byteLength ?? 0;
        phase2Diag.totalSize = head?.totalSize ?? null;
        phase2Diag.providerKind = providerKind;
        if (head?.bytes?.byteLength) {
          let ex = await extractExifFromBytes(head.bytes);
          phase2Diag.parsed1 = { exif: !!ex.exif, gps: !!ex.gps, media: !!ex.media };
          phase2Diag.exExif = ex.exif ? {
            iso: ex.exif.iso, fNumber: ex.exif.fNumber, aperture: ex.exif.aperture,
            exposureTime: ex.exif.exposureTime, focalLength: ex.exif.focalLength,
            cameraMake: ex.exif.cameraMake, exifCaptureTime: ex.exif.exifCaptureTime,
          } : null;
          // Capture the ACTUAL exifr key names (translated) so we can fix mapping.
          try {
            const exifr = (await import("npm:exifr@7.1.3")).default;
            const translated = await exifr.parse(head.bytes, {
              tiff: true, ifd0: true, exif: true, gps: true,
              xmp: true, iptc: true, mergeOutput: true,
              translateKeys: true, translateValues: true, sanitize: true, reviveValues: true,
            });
            phase2Diag.translatedKeys = translated ? Object.keys(translated).slice(0, 60) : null;
            phase2Diag.translatedSample = translated ? {
              ISO: (translated as any).ISO, FNumber: (translated as any).FNumber,
              ExposureTime: (translated as any).ExposureTime, FocalLength: (translated as any).FocalLength,
              Make: (translated as any).Make, Model: (translated as any).Model,
            } : null;
          } catch (e) { phase2Diag.translatedErr = String((e as Error)?.message ?? e); }
          // GPS fallback: if no GPS yet and the file is larger than our first
          // window, fetch up to HEAD_BYTES_RETRY and re-parse. This unblocks
          // GPS extraction for Dropbox-hosted iPhone JPEGs where GPS sits
          // beyond the embedded thumbnail.
          if ((!ex.gps?.latitude || !ex.gps?.longitude) &&
              (head.totalSize == null || head.totalSize > head.bytes.byteLength) &&
              head.bytes.byteLength < HEAD_BYTES_RETRY) {
            const bigger = await fetchHeadBytes(conn, ref.source_asset_id, HEAD_BYTES_RETRY);
            if (bigger?.bytes?.byteLength && bigger.bytes.byteLength > head.bytes.byteLength) {
              console.log("normalizeMetadata phase2 GPS retry with larger range", {
                asset_id, first: head.bytes.byteLength, retry: bigger.bytes.byteLength,
              });
              head = bigger;
              ex = await extractExifFromBytes(head.bytes);
            }
          }
          if ((!ex.gps?.latitude || !ex.gps?.longitude) && providerKind === "dropbox") {
            const token = await conn.getOriginalAccessToken(ref.source_asset_id).catch(() => null);
            if (token?.url) {
              const full = await fetchAllBytes(token.url, FULL_EXIF_FETCH_CAP);
              if (full?.bytes?.byteLength && full.bytes.byteLength > head.bytes.byteLength) {
                console.log("normalizeMetadata phase2 Dropbox full-file GPS fallback", {
                  asset_id,
                  headBytes: head.bytes.byteLength,
                  fullBytes: full.bytes.byteLength,
                });
                head = full;
                ex = await extractExifFromBytes(full.bytes);
                phase2Diag.fullFetched = full.bytes.byteLength;
                phase2Diag.parsed2 = { exif: !!ex.exif, gps: !!ex.gps };
              }
            }
          }
          console.log("normalizeMetadata phase2 exif parsed", {
            asset_id,
            hasExif: !!ex.exif, hasGps: !!ex.gps, hasMedia: !!ex.media,
            gpsLat: ex.gps?.latitude ?? null, gpsLng: ex.gps?.longitude ?? null,
          });

          if (ex.exif) {
            await upsertLog(sb, "asset_exif", {
              asset_id, user_id: asset.user_id,
              camera_make: ex.exif.cameraMake ?? null,
              camera_model: ex.exif.cameraModel ?? null,
              exif_make: ex.exif.exifMake ?? null,
              exif_model: ex.exif.exifModel ?? null,
              lens_make: ex.exif.lensMake ?? null,
              lens_model: ex.exif.lensModel ?? null,
              iso: ex.exif.iso ?? null,
              aperture: ex.exif.aperture ?? null,
              f_number: ex.exif.fNumber ?? null,
              shutter_speed: ex.exif.shutterSpeed ?? null,
              exposure_time: ex.exif.exposureTime ?? null,
              exposure_mode: ex.exif.exposureMode ?? null,
              focal_length: ex.exif.focalLength ?? null,
              focal_length_35mm: ex.exif.focalLength35mm ?? null,
              flash: ex.exif.flash ?? null,
              white_balance: ex.exif.whiteBalance ?? null,
              metering_mode: ex.exif.meteringMode ?? null,
              software: ex.exif.software ?? null,
              image_unique_id: ex.exif.imageUniqueId ?? null,
              orientation: ex.exif.orientation ?? null,
              exif_capture_time: ex.exif.exifCaptureTime ?? null,
              exif_original_time: ex.exif.exifOriginalTime ?? null,
              exif_digitized_time: ex.exif.exifDigitizedTime ?? null,
              timezone_offset: ex.exif.timezoneOffset ?? null,
              artist: ex.exif.artist ?? null,
              copyright: ex.exif.copyright ?? null,
              image_description: ex.exif.imageDescription ?? null,
            }, { onConflict: "asset_id" }, "phase2-exif");
            byteExtractionSuccess = true;
          }

          if (ex.gps?.latitude != null && ex.gps?.longitude != null) {
            const lat = ex.gps.latitude, lng = ex.gps.longitude;
            hasGpsData = true;
            await upsertLog(sb, "asset_gps", {
              asset_id, user_id: asset.user_id,
              gps_latitude: lat, gps_longitude: lng,
              gps_altitude: ex.gps.altitude ?? null,
              gps_timestamp: ex.gps.gpsTimestamp ?? null,
              gps_direction: ex.gps.direction ?? null,
              gps_speed: ex.gps.speed ?? null,
              location_source: "exif",
              location_confidence: 0.95,
              geohash: geohashEncode(lat, lng, 9),
            }, { onConflict: "asset_id" }, "phase2-gps");
            byteExtractionSuccess = true;
            console.log("normalizeMetadata phase2-gps OK", { asset_id, lat, lng });
          } else {
            // No GPS detected — log raw keys so we can see WHY.
            try {
              const raw = await extractExifFromBytesRaw(head.bytes);
              const allKeys = raw ? Object.keys(raw) : [];
              const gpsKeys = allKeys.filter((k) => /gps|latitude|longitude/i.test(k));
              const sample: Record<string, unknown> = {};
              for (const k of gpsKeys) sample[k] = (raw as any)[k];
              console.warn("normalizeMetadata phase2-gps MISSING", {
                asset_id, device: `${asset.device_make}/${asset.device_model}`,
                totalKeys: allKeys.length, gpsKeysFound: gpsKeys, sample,
              });
              phase2Diag.rawTotalKeys = allKeys.length;
              phase2Diag.rawSampleKeys = allKeys.slice(0, 30);
              phase2Diag.rawGpsKeys = gpsKeys;
            } catch (e) {
              console.warn("normalizeMetadata phase2-gps diagnostic failed", String((e as Error)?.message ?? e));
              phase2Diag.rawError = String((e as Error)?.message ?? e);
            }
          }

          // Upgrade asset_media_metadata with EXIF-precise values.
          if (ex.media) {
            const ew = ex.media.width ?? asset.width ?? null;
            const eh = ex.media.height ?? asset.height ?? null;
            await upsertLog(sb, "asset_media_metadata", {
              asset_id, user_id: asset.user_id,
              width: ew, height: eh,
              aspect_ratio: ew && eh ? Number(ew) / Number(eh) : null,
              orientation: ex.media.orientation ?? null,
              color_space: ex.media.colorSpace ?? null,
              has_alpha: ex.media.hasAlpha ?? null,
              has_audio: false, has_video: false,
              thumbnail_possible: true, preview_possible: true,
              ai_processing_possible: true, ocr_possible: true,
            }, { onConflict: "asset_id" }, "phase2-media");
            byteExtractionSuccess = true;
          }

          if (ex.xmpIptc) {
            // Keep parsing XMP/IPTC for diagnostics and future use, but do not
            // persist it in the current schema.
            phase2Diag.xmpIptcDetected = true;
            byteExtractionSuccess = true;
          }

          // Lift EXIF-precise values onto canonical asset row.
          const assetUpdates: Record<string, unknown> = {};
          if (ex.exif?.exifCaptureTime && !asset.capture_time) assetUpdates.capture_time = ex.exif.exifCaptureTime;
          if (ex.gps?.latitude != null && ex.gps?.longitude != null) {
            // GPS lives in asset_gps, not assets — upsert directly.
            await sb.from("asset_gps").upsert({
              asset_id, user_id: asset.user_id,
              gps_latitude: ex.gps.latitude,
              gps_longitude: ex.gps.longitude,
              location_source: "exif",
              location_confidence: 0.95,
              geohash: geohashEncode(Number(ex.gps.latitude), Number(ex.gps.longitude), 9),
            }, { onConflict: "asset_id" });
            hasGpsData = true;
          }
          if (ex.media?.width && !asset.width) assetUpdates.width = ex.media.width;
          if (ex.media?.height && !asset.height) assetUpdates.height = ex.media.height;
          if (ex.exif?.cameraMake && !asset.device_make) assetUpdates.device_make = ex.exif.cameraMake;
          if (ex.exif?.cameraModel && !asset.device_model) assetUpdates.device_model = ex.exif.cameraModel;
          if (ex.exif?.timezoneOffset && !asset.timezone) assetUpdates.timezone = ex.exif.timezoneOffset;
          if (Object.keys(assetUpdates).length > 0) {
            await sb.from("assets").update(assetUpdates).eq("id", asset_id);
          }
        }
      }
    } catch (e) {
      console.error("normalizeMetadata phase2 (byte EXIF) failed", {
        asset_id, error: String((e as Error)?.message ?? e),
      });
    }
  }

  // ── Downstream pipeline ────────────────────────────────────────────────────
  const forceSuffix = force_sync_run_id ? `:force:${force_sync_run_id}` : "";
  await enqueueJob("hashAsset", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `hash:${asset_id}${forceSuffix}` });
  await enqueueJob("generateDerived", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `derived:${asset_id}${forceSuffix}` });
  await enqueueJob("ocrAsset", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `ocr:${asset_id}${forceSuffix}` });
  await enqueueJob("enrichAI", {
    userId: ctx.userId,
    payload: {
      asset_id,
      ...(sync_run_id ? { sync_run_id } : {}),
      ...(force_sync_run_id ? { force_sync_run_id } : {}),
    },
    idempotencyKey: `ai:${asset_id}${forceSuffix}`,
  });
  // indexSearchDocument is enqueued exactly once per asset by enrichAI (or ocrAsset
  // as a fallback) after enrichment data is available — see those handlers.
  // clusterPlaces / detectEvents are coalesced to one run per user
  // per day instead of one run per asset. clusterPeople is queued by enrichAI
  // after face rows are written, so re-enqueueing it here only causes full-user
  // reprocessing and duplicate race windows.
  const clusteringKey = sync_run_id ?? force_sync_run_id ?? new Date().toISOString().slice(0, 13);
  // Always enqueue — clusterPlaces does its own cheap scan and exits early
  // when there is nothing to geocode. The previous `if (hasGpsData)` guard
  // missed cases where GPS arrived on a later asset in the same sync run.
  await enqueueJob("clusterPlaces", { userId: ctx.userId, payload: { user_id: asset.user_id }, idempotencyKey: `places:${asset.user_id}:${clusteringKey}` });
  await enqueueJob("detectEvents", { userId: ctx.userId, payload: { user_id: asset.user_id }, idempotencyKey: `events:${asset.user_id}:${clusteringKey}` });

  if (source_account_id) {
    try {
      const pendingNormalizeRes = await sb.from("job_queue")
        .select("id", { count: "exact", head: true })
        .eq("job_name", "normalizeMetadata")
        .in("status", ["pending", "running"])
        .contains("payload", {
          source_account_id,
          ...(sync_run_id ? { sync_run_id } : {}),
        });
      const pendingNormalize = Math.max((pendingNormalizeRes.count ?? 1) - 1, 0);

      const syncJobQuery = sb.from("source_sync_jobs")
        .select("id, stats, status")
        .eq("source_account_id", source_account_id)
        .order("created_at", { ascending: false })
        .limit(1);
      const syncJobRes = sync_run_id
        ? await syncJobQuery.contains("stats", { sync_run_id }).maybeSingle()
        : await syncJobQuery.maybeSingle();
      const runningJob = syncJobRes.data;
      if (runningJob && runningJob.status !== "cancelled" && runningJob.status !== "failed") {
        const stats = (typeof runningJob.stats === "object" && runningJob.stats !== null)
          ? runningJob.stats as Record<string, unknown>
          : {};
        const processingTotal = Math.max(Number(stats.processing_total ?? stats.discovered ?? 0), Number(stats.normalized ?? 0) + pendingNormalize + 1);
        const normalizedCount = Math.max(processingTotal - pendingNormalize, Number(stats.normalized ?? 0) + 1);
        const complete = processingTotal > 0 && normalizedCount >= processingTotal && stats.has_more !== true;
        const merged = {
          ...stats,
          sync_run_id: sync_run_id ?? stats.sync_run_id,
          normalized: normalizedCount,
          indexed: Math.max(Number(stats.indexed ?? 0), normalizedCount),
          stage: complete ? "completed" : "processing",
          ...(currentFolder ? { current_folder: currentFolder } : {}),
          current_file: filename ?? rel ?? asset_id,
        };
        const nextStatus = complete ? "completed" : "running";
        await sb.from("source_sync_jobs").update({
          status: nextStatus,
          finished_at: complete ? new Date().toISOString() : null,
          stats: merged,
        }).eq("id", runningJob.id);
        if (complete) {
          await sb.from("source_accounts").update({
            last_synced_at: new Date().toISOString(),
            status: "active",
          }).eq("id", source_account_id);
        } else if (pendingNormalize > 0) {
          await nudgeNormalizeDrain();
        }
      } else if (pendingNormalize > 0) {
        await nudgeNormalizeDrain();
      }
    } catch (error) {
      console.error("normalizeMetadata sync progress update failed", {
        asset_id,
        source_account_id,
        sync_run_id,
        error: String((error as Error)?.message ?? error),
      });
    }
  }

  await nudgeWorkerDrain();

  return { asset_id, normalized: true, byteExtraction: byteExtractionSuccess, phase2: phase2Diag };
}
