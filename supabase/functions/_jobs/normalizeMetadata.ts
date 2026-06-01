// deno-lint-ignore-file no-explicit-any
/**
 * normalizeMetadata — downloads a head-range of bytes from the cloud source
 * (Dropbox/OneDrive/etc.) and extracts EXIF, GPS, XMP/IPTC, basic media
 * metadata via exifr. Persists results into asset_exif, asset_gps,
 * asset_xmp_iptc, asset_media_metadata, asset_file_metadata, and lifts
 * canonical fields onto the assets row. Fans out to hash / derived /
 * embed / index regardless of extraction outcome.
 */
import { serviceClient } from "../_pipeline/clients.ts";
import { enqueueJob } from "../_pipeline/enqueuer.ts";
import type { JobContext } from "../_pipeline/runner.ts";
import { getConnector } from "../_sources/registry.ts";
import { fetchHeadBytes } from "../_extractors/fetch-bytes.ts";
import { extractExifFromBytes } from "../_extractors/exif.ts";

const HEAD_BYTES = 384 * 1024;

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

export async function normalizeMetadata(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id, source_account_id } = ctx.payload as { asset_id: string; source_account_id?: string };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { data: asset, error } = await sb.from("assets")
    .select("id, user_id, media_type, mime_type, capture_time, timezone, location_lat, location_lng, width, height, device_make, device_model, status")
    .eq("id", asset_id).single();
  if (error || !asset) throw new Error("not found: asset");

  const { data: ref } = await sb.from("asset_source_refs")
    .select("source_account_id, source_asset_id, source_relative_path, provider_url, source_modified_at, is_primary")
    .eq("asset_id", asset_id).order("is_primary", { ascending: false }).limit(1).maybeSingle();

  let extractedAny = false;

  if (ref?.source_account_id && ref?.source_asset_id) {
    const { data: acct } = await sb.from("source_accounts")
      .select("provider_id, provider_kind").eq("id", ref.source_account_id).single();
    let providerKind: any = acct?.provider_kind;
    if (!providerKind && acct?.provider_id) {
      const { data: pr } = await sb.from("source_providers").select("kind").eq("id", acct.provider_id).single();
      providerKind = pr?.kind;
    }

    if (providerKind) {
      try {
        const conn = getConnector(providerKind, {
          source_account_id: ref.source_account_id, user_id: asset.user_id, provider_kind: providerKind,
        }, sb);
        const mime = asset.mime_type ?? "";
        const isImage = mime.startsWith("image/") || asset.media_type === "photo";
        const isVideo = mime.startsWith("video/") || asset.media_type === "video";
        const isAudio = mime.startsWith("audio/") || asset.media_type === "audio";
        const isDocument = asset.media_type === "document" ||
          ["application/pdf", "application/msword",
           "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
           "application/vnd.ms-excel", "application/vnd.odf+xml"].includes(mime);

        if (isImage) {
          const head = await fetchHeadBytes(conn, ref.source_asset_id, HEAD_BYTES);
          if (head?.bytes?.byteLength) {
            const ex = await extractExifFromBytes(head.bytes);

            if (ex.exif) {
              await sb.from("asset_exif").upsert({
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
              }, { onConflict: "asset_id" });
              extractedAny = true;
            }

            if (ex.gps?.latitude != null && ex.gps?.longitude != null) {
              const lat = ex.gps.latitude, lng = ex.gps.longitude;
              await sb.from("asset_gps").upsert({
                asset_id, user_id: asset.user_id,
                gps_latitude: lat, gps_longitude: lng,
                gps_altitude: ex.gps.altitude ?? null,
                gps_timestamp: ex.gps.gpsTimestamp ?? null,
                gps_direction: ex.gps.direction ?? null,
                gps_speed: ex.gps.speed ?? null,
                location_source: "exif",
                location_confidence: 0.95,
                geohash: geohashEncode(lat, lng, 9),
              }, { onConflict: "asset_id" });
              extractedAny = true;
            }

            if (ex.media) {
              const w = ex.media.width ?? asset.width ?? null;
              const h = ex.media.height ?? asset.height ?? null;
              await sb.from("asset_media_metadata").upsert({
                asset_id, user_id: asset.user_id,
                width: w, height: h,
                aspect_ratio: w && h ? Number(w) / Number(h) : null,
                orientation: ex.media.orientation ?? null,
                color_space: ex.media.colorSpace ?? null,
                has_alpha: ex.media.hasAlpha ?? null,
                has_audio: false, has_video: false, // images never have separate video/audio streams
                thumbnail_possible: true, preview_possible: true,
                ai_processing_possible: true, ocr_possible: true,
              }, { onConflict: "asset_id" });
              extractedAny = true;
            }

            if (ex.xmpIptc) {
              await sb.from("asset_xmp_iptc").upsert({
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
              }, { onConflict: "asset_id" });
              extractedAny = true;
            }

            // Lift extracted values onto canonical asset row.
            const updates: Record<string, unknown> = { status: "normalized" };
            if (ex.exif?.exifCaptureTime && !asset.capture_time) updates.capture_time = ex.exif.exifCaptureTime;
            if (ex.gps?.latitude != null && ex.gps?.longitude != null) {
              updates.location_lat = ex.gps.latitude;
              updates.location_lng = ex.gps.longitude;
            }
            if (ex.media?.width && !asset.width) updates.width = ex.media.width;
            if (ex.media?.height && !asset.height) updates.height = ex.media.height;
            if (ex.exif?.cameraMake && !asset.device_make) updates.device_make = ex.exif.cameraMake;
            if (ex.exif?.cameraModel && !asset.device_model) updates.device_model = ex.exif.cameraModel;
            if (ex.exif?.timezoneOffset && !asset.timezone) updates.timezone = ex.exif.timezoneOffset;
            await sb.from("assets").update(updates).eq("id", asset_id);
          }
        }

        // Video: write has_video=true into media_metadata and stub video_metadata row.
        // Full codec/framerate data is not extractable from a 384KB head range without
        // a dedicated ffprobe-style parser; we record what we can infer from the MIME type.
        if (isVideo) {
          await sb.from("asset_media_metadata").upsert({
            asset_id, user_id: asset.user_id,
            width: asset.width ?? null, height: asset.height ?? null,
            aspect_ratio: asset.width && asset.height ? Number(asset.width) / Number(asset.height) : null,
            has_video: true,
            has_audio: true, // conservative default; no byte-level audio detection without ffprobe
            has_alpha: false,
            thumbnail_possible: true, preview_possible: true,
            ai_processing_possible: true, ocr_possible: false,
          }, { onConflict: "asset_id" });
          await sb.from("asset_video_metadata").upsert({
            asset_id, user_id: asset.user_id,
            container_format: mime.split("/")[1] ?? null,
            raw: {},
          }, { onConflict: "asset_id" });
          // Lift duration onto asset row if already stored (e.g. from cloud provider metadata).
          await sb.from("assets").update({ status: "normalized" }).eq("id", asset_id);
          extractedAny = true;
        }

        // Audio: write has_audio into media_metadata.
        if (isAudio) {
          await sb.from("asset_media_metadata").upsert({
            asset_id, user_id: asset.user_id,
            has_video: false, has_audio: true, has_alpha: false,
            thumbnail_possible: false, preview_possible: false,
            ai_processing_possible: false, ocr_possible: false,
          }, { onConflict: "asset_id" });
          await sb.from("assets").update({ status: "normalized" }).eq("id", asset_id);
          extractedAny = true;
        }

        // Document: write document_metadata stub with what we can infer.
        // Full page count / author requires OCR; ocrAsset will populate further.
        if (isDocument) {
          await sb.from("asset_media_metadata").upsert({
            asset_id, user_id: asset.user_id,
            has_video: false, has_audio: false, has_alpha: false,
            thumbnail_possible: mime === "application/pdf",
            preview_possible: true,
            ai_processing_possible: true, ocr_possible: true,
          }, { onConflict: "asset_id" });
          await sb.from("asset_document_metadata").upsert({
            asset_id, user_id: asset.user_id,
            raw: {},
          }, { onConflict: "asset_id" });
          await sb.from("assets").update({ status: "normalized" }).eq("id", asset_id);
          extractedAny = true;
        }

        // File-system shell metadata (filename / extension / parent folder) for every cloud asset.
        const rel = (ref.source_relative_path || ref.provider_url || "") as string;
        if (rel && source_account_id) {
          // Write the current filename into the running sync job so the UI can
          // show which file is being processed.
          const currentFile = rel.split("/").filter(Boolean).pop() ?? rel;
          // Don't filter by status="running" — the syncSource job may already
          // be "completed" (listed first page) by the time we run here.
          const { data: runningJob } = await sb.from("source_sync_jobs")
            .select("id, stats")
            .eq("source_account_id", source_account_id)
            .order("created_at", { ascending: false })
            .limit(1).maybeSingle();
          if (runningJob) {
            const merged = {
              ...(typeof runningJob.stats === "object" && runningJob.stats !== null ? runningJob.stats as Record<string, unknown> : {}),
              current_file: currentFile,
            };
            await sb.from("source_sync_jobs").update({ stats: merged }).eq("id", runningJob.id);
          }
        }
        if (rel) {
          const filename = rel.split("/").filter(Boolean).pop() ?? null;
          const dot = filename ? filename.lastIndexOf(".") : -1;
          await sb.from("asset_file_metadata").upsert({
            asset_id, user_id: asset.user_id,
            relative_path: rel,
            parent_folder_path: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null,
            filename,
            filename_without_extension: filename && dot > 0 ? filename.slice(0, dot) : filename,
            extension: filename && dot > 0 ? filename.slice(dot + 1) : null,
            normalized_extension: filename && dot > 0 ? filename.slice(dot + 1).toLowerCase() : null,
            detected_file_type: asset.media_type ?? null,
            modified_at_filesystem: ref.source_modified_at ?? null,
            scan_discovered_at: new Date().toISOString(),
          }, { onConflict: "asset_id" });
          extractedAny = true;
        }
      } catch (e) {
        console.error("normalizeMetadata extract failed", { asset_id, error: String((e as Error)?.message ?? e) });
      }
    }
  }

  if (!extractedAny) {
    await sb.from("assets").update({ status: "normalized", timezone: asset.timezone ?? "UTC" }).eq("id", asset_id);
  }

  await enqueueJob("hashAsset", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `hash:${asset_id}` });
  await enqueueJob("generateDerived", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `derived:${asset_id}` });
  await enqueueJob("embedAsset", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `embed:${asset_id}` });
  await enqueueJob("indexSearchDocument", { userId: ctx.userId, payload: { asset_id }, idempotencyKey: `index:${asset_id}` });

  return { asset_id, normalized: true, extracted: extractedAny };
}