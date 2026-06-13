// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/**
 * indexSearchDocument — builds the FTS document for an asset and writes it to
 * public.assets.search_content. The DB trigger trg_assets_search_tsv keeps
 * search_tsv in sync. OCR now lives on asset_ai_enrichment and filename/folder
 * live directly on assets.
 */
export async function indexSearchDocument(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { data: asset } = await sb
    .from("assets")
    .select(
      "id, user_id, capture_time, media_type, mime_type, " +
      "device_make, device_model, width, height, duration_ms, " +
      "filename, parent_folder_path",
    )
    .eq("id", asset_id)
    .single();
  if (!asset) throw new Error("not found: asset");

  const [aiRow, gpsRow, exifRow] = await Promise.all([
    sb.from("asset_ai_enrichment").select("caption, tags, ocr_text")
      .eq("asset_id", asset_id).maybeSingle().then((r) => r.data),
    sb.from("asset_gps").select(
      "reverse_geocoded_city, reverse_geocoded_state, reverse_geocoded_country, place_name",
    ).eq("asset_id", asset_id).maybeSingle().then((r) => r.data),
    sb.from("asset_exif").select(
      "camera_make, camera_model, exif_make, exif_model, lens_model, " +
      "iso, aperture, f_number, shutter_speed, focal_length, focal_length_35mm, " +
      "flash, white_balance, exposure_mode, software",
    ).eq("asset_id", asset_id).maybeSingle().then((r) => r.data),
  ]);

  const parts: string[] = [];

  // Media type
  if (asset.media_type) parts.push(asset.media_type);
  if (asset.mime_type)  parts.push(asset.mime_type);

  // AI caption + tags + object labels
  if (aiRow?.caption) parts.push(aiRow.caption);
  // tags is now jsonb (array); handle both jsonb array and legacy text[] formats.
  const tagsArr = Array.isArray(aiRow?.tags) ? aiRow.tags : [];
  if (tagsArr.length) parts.push(tagsArr.join(" "));

  // OCR text (now on asset_ai_enrichment.ocr_text)
  if (aiRow?.ocr_text) parts.push(aiRow.ocr_text);

  // Location
  if (gpsRow?.place_name)               parts.push(gpsRow.place_name);
  if (gpsRow?.reverse_geocoded_city)    parts.push(gpsRow.reverse_geocoded_city);
  if (gpsRow?.reverse_geocoded_state)   parts.push(gpsRow.reverse_geocoded_state);
  if (gpsRow?.reverse_geocoded_country) parts.push(gpsRow.reverse_geocoded_country);

  // Camera device
  const cameraMake  = exifRow?.camera_make ?? exifRow?.exif_make ?? asset.device_make;
  const cameraModel = exifRow?.camera_model ?? exifRow?.exif_model ?? asset.device_model;
  if (cameraMake)  parts.push(cameraMake);
  if (cameraModel) parts.push(cameraModel);

  // EXIF camera settings — enables "f/2.8", "ISO 400", "50mm", "flash" searches.
  if (exifRow?.lens_model)      parts.push(`Lens ${exifRow.lens_model}`);
  if (exifRow?.iso != null)     parts.push(`ISO ${exifRow.iso}`);
  const fnum = exifRow?.f_number ?? exifRow?.aperture;
  if (fnum != null)             parts.push(`f/${Number(fnum).toFixed(1)}`);
  if (exifRow?.shutter_speed)   parts.push(exifRow.shutter_speed);
  if (exifRow?.focal_length != null)    parts.push(`${exifRow.focal_length}mm`);
  if (exifRow?.focal_length_35mm != null) parts.push(`${exifRow.focal_length_35mm}mm`);
  if (exifRow?.flash)           parts.push(exifRow.flash);
  if (exifRow?.white_balance)   parts.push(exifRow.white_balance);
  if (exifRow?.exposure_mode)   parts.push(exifRow.exposure_mode);
  if (exifRow?.software)        parts.push(exifRow.software);

  // Filename / folder path (now on assets directly)
  if (asset.filename)           parts.push(asset.filename);
  if (asset.parent_folder_path) parts.push(asset.parent_folder_path);

  // Safety cap to avoid exceeding PG tsvector limits.
  const content = parts.filter(Boolean).join(" ").slice(0, 32_000);

  // Write directly to assets.search_content; trg_assets_search_tsv regenerates
  // search_tsv on update.
  await sb.from("assets").update({ search_content: content }).eq("id", asset_id);

  return { asset_id, chars: content.length };
}
