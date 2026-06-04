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
import { fetchHeadBytes } from "../_extractors/fetch-bytes.ts";
import { extractExifFromBytes } from "../_extractors/exif.ts";

const HEAD_BYTES = 384 * 1024;

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
    .select("id, user_id, media_type, mime_type, capture_time, timezone, location_lat, location_lng, width, height, duration_ms, device_make, device_model, thumbnail_cache_key, proxy_cache_key, status")
    .eq("id", asset_id).single();
  if (error || !asset) throw new Error("not found: asset");

  const { data: ref } = await sb.from("asset_source_refs")
    .select("source_account_id, source_asset_id, source_relative_path, provider_url, source_modified_at, is_primary")
    .eq("asset_id", asset_id).order("is_primary", { ascending: false }).limit(1).maybeSingle();

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

  // file_metadata — always write, even if rel is a provider URL rather than a real path.
  if (rel) {
    await upsertLog(sb, "asset_file_metadata", {
      asset_id, user_id: asset.user_id,
      relative_path: rel,
      parent_folder_path: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null,
      filename,
      filename_without_extension: filename && dot > 0 ? filename.slice(0, dot) : filename,
      extension: filename && dot > 0 ? filename.slice(dot + 1) : null,
      normalized_extension: filename && dot > 0 ? filename.slice(dot + 1).toLowerCase() : null,
      detected_file_type: asset.media_type ?? null,
      modified_at_filesystem: ref?.source_modified_at ?? null,
      scan_discovered_at: new Date().toISOString(),
    }, { onConflict: "asset_id" }, "phase1");

    const orgSignals = inferOrganizationSignals(rel, filename);
    await upsertLog(sb, "asset_organization_signals", {
      asset_id,
      user_id: asset.user_id,
      ...orgSignals,
    }, { onConflict: "asset_id" }, "phase1");
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

  await upsertLog(sb, "asset_preview_metadata", {
    asset_id,
    user_id: asset.user_id,
    thumbnail_generated: Boolean(asset.thumbnail_cache_key),
    preview_generated: Boolean(asset.proxy_cache_key),
    thumbnail_cache_key: asset.thumbnail_cache_key ?? null,
    preview_cache_key: asset.proxy_cache_key ?? null,
  }, { onConflict: "asset_id" }, "phase1-preview");

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

  // For images/videos: write asset_gps if location came from the provider API.
  if ((isImage || isVideo) && asset.location_lat != null && asset.location_lng != null) {
    await upsertLog(sb, "asset_gps", {
      asset_id, user_id: asset.user_id,
      gps_latitude: asset.location_lat,
      gps_longitude: asset.location_lng,
      location_source: "provider_api",
      location_confidence: 0.9,
      geohash: geohashEncode(Number(asset.location_lat), Number(asset.location_lng), 9),
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

  // ai_ready_metadata — always write.
  await upsertLog(sb, "asset_ai_ready_metadata", {
    asset_id, user_id: asset.user_id,
    ai_processing_possible: isImage || isVideo || isDocument,
    ai_processing_consent: true,
    ocr_possible: isImage || isDocument,
    ocr_status: isImage || isDocument ? "pending" : "skipped",
    caption_status: isImage || isVideo || isDocument ? "pending" : "skipped",
    labels_status: isImage || isVideo || isDocument ? "pending" : "skipped",
    embedding_status: "pending",
    face_processing_possible: isImage || isVideo,
    face_processing_consent: true,
  }, { onConflict: "asset_id" }, "phase1");

  // Ensure assets.status reflects at least "normalized".
  await sb.from("assets").update({ status: "normalized" }).eq("id", asset_id).eq("status", "ingested");

  // ── Phase 2: Byte-level EXIF/GPS/XMP extraction ───────────────────────────
  // Isolated in its own try-catch so any connector/network error never prevents
  // phase 1 data (above) from being used by downstream jobs.

  let byteExtractionSuccess = false;

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

        const head = await fetchHeadBytes(conn, ref.source_asset_id, HEAD_BYTES);
        if (head?.bytes?.byteLength) {
          const ex = await extractExifFromBytes(head.bytes);

          if (ex.exif) {
            await upsertLog(sb, "asset_exif", {
              asset_id, user_id: asset.user_id,
              camera_make: ex.exif.cameraMake ?? null,
              camera_model: ex.exif.cameraModel ?? null,
              exif_make: ex.exif.exifMake ?? null,
              exif_model: ex.exif.exifModel ?? null,
              lens_make: ex.exif.lensMake ?? null,
              lens_model: ex.exif.lensModel ?? null,
              lens: ex.exif.lensModel ?? null,
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
            await upsertLog(sb, "asset_xmp_iptc", {
              asset_id, user_id: asset.user_id,
              xmp_title: ex.xmpIptc.xmpTitle ?? null,
              xmp_description: ex.xmpIptc.xmpDescription ?? null,
              xmp_creator: ex.xmpIptc.xmpCreator ?? null,
              xmp_rights: ex.xmpIptc.xmpRights ?? null,
              xmp_keywords: ex.xmpIptc.xmpKeywords ?? null,
              xmp_rating: ex.xmpIptc.xmpRating ?? null,
              iptc_caption: ex.xmpIptc.iptcCaption ?? null,
              iptc_headline: ex.xmpIptc.iptcHeadline ?? null,
              iptc_keywords: ex.xmpIptc.iptcKeywords ?? null,
              iptc_byline: ex.xmpIptc.iptcByline ?? null,
              iptc_city: ex.xmpIptc.iptcCity ?? null,
              iptc_state: ex.xmpIptc.iptcState ?? null,
              iptc_country: ex.xmpIptc.iptcCountry ?? null,
            }, { onConflict: "asset_id" }, "phase2-xmpiptc");
            byteExtractionSuccess = true;
          }

          // Lift EXIF-precise values onto canonical asset row.
          const assetUpdates: Record<string, unknown> = {};
          if (ex.exif?.exifCaptureTime && !asset.capture_time) assetUpdates.capture_time = ex.exif.exifCaptureTime;
          if (ex.gps?.latitude != null && ex.gps?.longitude != null) {
            assetUpdates.location_lat = ex.gps.latitude;
            assetUpdates.location_lng = ex.gps.longitude;
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
  await enqueueJob("enrichAI", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `ai:${asset_id}${forceSuffix}` });
  await enqueueJob("embedAsset", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `embed:${asset_id}${forceSuffix}` });
  await enqueueJob("indexSearchDocument", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `index:${asset_id}${forceSuffix}` });
  await enqueueJob("clusterPlaces", { userId: ctx.userId, payload: { user_id: asset.user_id, asset_id }, idempotencyKey: `places:${asset_id}${forceSuffix}` });
  // Trigger event detection so moments/stories update as assets are normalized.
  // Daily bucket prevents duplicate runs while still re-clustering once per day.
  const today = new Date().toISOString().slice(0, 10);
  await enqueueJob("detectEvents", { userId: ctx.userId, payload: { user_id: asset.user_id }, idempotencyKey: `events:${asset.user_id}:${today}` });

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
          indexed: normalizedCount,
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

  return { asset_id, normalized: true, byteExtraction: byteExtractionSuccess };
}
