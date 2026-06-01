// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

/**
 * indexSearchDocument — builds and persists the full-text search document for
 * an asset into public.asset_search_documents (the table hybrid_search reads).
 *
 * Sources combined:
 *  - AI caption + tags + object labels
 *  - OCR text
 *  - GPS / reverse-geocoded location
 *  - Device make / model
 *  - EXIF camera settings (ISO, aperture, focal length, flash, white balance, etc.)
 *  - XMP/IPTC title, description, keywords
 *  - Filename / folder hints from file metadata
 *  - Media type / MIME type
 *
 * NOTE: The DB trigger trg_search_doc_tsv regenerates search_tsv automatically
 * on every upsert, so this job only needs to build the content text.
 */
export async function indexSearchDocument(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  if (!asset_id) throw new Error("invalid: asset_id");

  const { data: asset } = await sb
    .from("assets")
    .select(
      "id, user_id, capture_time, media_type, mime_type, " +
      "device_make, device_model, width, height, duration_ms",
    )
    .eq("id", asset_id)
    .single();
  if (!asset) throw new Error("not found: asset");

  // Parallel fetch of all enrichment tables.
  const [aiRow, ocrRow, gpsRow, exifRow, xmpRow, fileRow] = await Promise.all([
    sb.from("asset_ai_enrichment").select("caption, tags, objects").eq("asset_id", asset_id).maybeSingle().then((r) => r.data),
    sb.from("asset_ocr").select("text").eq("asset_id", asset_id).maybeSingle().then((r) => r.data),
    sb.from("asset_gps").select(
      "reverse_geocoded_city, reverse_geocoded_state, reverse_geocoded_country, place_name",
    ).eq("asset_id", asset_id).maybeSingle().then((r) => r.data),
    sb.from("asset_exif").select(
      "camera_make, camera_model, exif_make, exif_model, lens_model, " +
      "iso, aperture, f_number, shutter_speed, focal_length, focal_length_35mm, " +
      "flash, white_balance, exposure_mode, software",
    ).eq("asset_id", asset_id).maybeSingle().then((r) => r.data),
    sb.from("asset_xmp_iptc").select(
      "xmp_title, xmp_description, xmp_keywords, iptc_caption, iptc_headline, iptc_keywords",
    ).eq("asset_id", asset_id).maybeSingle().then((r) => r.data),
    sb.from("asset_file_metadata").select("filename, parent_folder_path")
      .eq("asset_id", asset_id).maybeSingle().then((r) => r.data),
  ]);

  const parts: string[] = [];

  // Media type
  if (asset.media_type) parts.push(asset.media_type);
  if (asset.mime_type)  parts.push(asset.mime_type);

  // AI caption + tags + object labels
  if (aiRow?.caption) parts.push(aiRow.caption);
  if (Array.isArray(aiRow?.tags) && aiRow.tags.length) parts.push(aiRow.tags.join(" "));
  if (Array.isArray(aiRow?.objects)) {
    const labels = aiRow.objects
      .map((o: any) => (typeof o === "string" ? o : o?.label))
      .filter(Boolean);
    if (labels.length) parts.push(labels.join(" "));
  }

  // OCR text
  if (ocrRow?.text) parts.push(ocrRow.text);

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

  // XMP / IPTC
  if (xmpRow?.xmp_title)       parts.push(xmpRow.xmp_title);
  if (xmpRow?.xmp_description) parts.push(xmpRow.xmp_description);
  if (xmpRow?.iptc_caption)    parts.push(xmpRow.iptc_caption);
  if (xmpRow?.iptc_headline)   parts.push(xmpRow.iptc_headline);
  const kws = [...(xmpRow?.xmp_keywords ?? []), ...(xmpRow?.iptc_keywords ?? [])];
  if (kws.length) parts.push(kws.join(" "));

  // Filename / folder path
  if (fileRow?.filename)           parts.push(fileRow.filename);
  if (fileRow?.parent_folder_path) parts.push(fileRow.parent_folder_path);

  // Safety cap to avoid exceeding PG tsvector limits.
  const content = parts.filter(Boolean).join(" ").slice(0, 32_000);

  // Write to asset_search_documents — this is the table hybrid_search reads from.
  // The DB trigger trg_search_doc_tsv regenerates search_tsv on every upsert.
  await sb.from("asset_search_documents").upsert(
    { asset_id, user_id: asset.user_id, content },
    { onConflict: "asset_id" },
  );

  return { asset_id, chars: content.length };
}
