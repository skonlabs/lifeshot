// deno-lint-ignore-file no-explicit-any
/**
 * Server-side narrative search-document generator for the Universal
 * Metadata Engine. Produces a single human-readable text blob that
 * powers FTS and gives downstream AI a clean text view of the asset.
 */
import type { CanonicalMetadataRecord } from "../../../packages/core/metadata/types.ts";

export function generateSearchDocument(rec: CanonicalMetadataRecord): string {
  const lines: string[] = [];
  const fs = rec.fileSystem;
  const media = rec.media;
  const exif = rec.exif;
  const gps = rec.gps;
  const xmp = rec.xmpIptc;
  const doc = rec.document;
  const audio = rec.audio;
  const org = rec.organization;

  if (fs?.filename) lines.push(`File: ${fs.filename}`);
  if (fs?.relativePath) lines.push(`Path: ${fs.relativePath}`);
  if (rec.mediaType) lines.push(`Type: ${rec.mediaType}`);
  if (rec.mimeType) lines.push(`Mime: ${rec.mimeType}`);
  if (rec.captureTime) lines.push(`Captured: ${rec.captureTime}`);

  if (media?.width && media?.height) lines.push(`Dimensions: ${media.width}x${media.height}`);
  if (media?.durationMs) lines.push(`Duration: ${Math.round(media.durationMs / 1000)}s`);
  if (media?.pageCount) lines.push(`Pages: ${media.pageCount}`);

  if (exif?.cameraMake || exif?.cameraModel) {
    lines.push(`Camera: ${[exif.cameraMake, exif.cameraModel].filter(Boolean).join(" ")}`);
  }
  if (exif?.lensModel) lines.push(`Lens: ${exif.lensModel}`);
  // Exposure settings — enables searches like "ISO 400", "f/2.8", "50mm", "flash on".
  if ((exif as any)?.iso != null)         lines.push(`ISO ${(exif as any).iso}`);
  const fnum = (exif as any)?.fNumber ?? (exif as any)?.aperture;
  if (fnum != null)                       lines.push(`f/${Number(fnum).toFixed(1)}`);
  if ((exif as any)?.shutterSpeed)        lines.push((exif as any).shutterSpeed);
  if ((exif as any)?.focalLength != null) lines.push(`${(exif as any).focalLength}mm`);
  if (exif?.focalLength35mm != null)      lines.push(`${exif.focalLength35mm}mm equivalent`);
  if ((exif as any)?.flash)              lines.push(`Flash: ${(exif as any).flash}`);
  if ((exif as any)?.whiteBalance)       lines.push(`White balance: ${(exif as any).whiteBalance}`);
  if (exif?.exposureMode)                lines.push(`Exposure: ${exif.exposureMode}`);

  if (gps?.placeName) lines.push(`Place: ${gps.placeName}`);
  if (gps?.reverseGeocodedCity || gps?.reverseGeocodedCountry) {
    lines.push(`Location: ${[gps.reverseGeocodedCity, gps.reverseGeocodedState, gps.reverseGeocodedCountry].filter(Boolean).join(", ")}`);
  }
  if (gps?.gpsLatitude != null && gps?.gpsLongitude != null) {
    lines.push(`GPS: ${gps.gpsLatitude.toFixed(5)},${gps.gpsLongitude.toFixed(5)}`);
  }

  if (xmp?.xmpTitle) lines.push(`Title: ${xmp.xmpTitle}`);
  if (xmp?.xmpDescription) lines.push(`Description: ${xmp.xmpDescription}`);
  if (xmp?.iptcCaption) lines.push(`Caption: ${xmp.iptcCaption}`);
  const kws = [...(xmp?.xmpKeywords ?? []), ...(xmp?.iptcKeywords ?? [])];
  if (kws.length) lines.push(`Keywords: ${kws.join(", ")}`);

  if (doc?.docTitle) lines.push(`Document title: ${doc.docTitle}`);
  if (doc?.docAuthor) lines.push(`Author: ${doc.docAuthor}`);
  if (doc?.docSubject) lines.push(`Subject: ${doc.docSubject}`);

  if (audio?.title) lines.push(`Track: ${audio.title}`);
  if (audio?.artist) lines.push(`Artist: ${audio.artist}`);
  if (audio?.album) lines.push(`Album: ${audio.album}`);

  if (org?.folderTokens?.length) lines.push(`Folders: ${org.folderTokens.join(" / ")}`);
  if (org?.eventHint) lines.push(`Event: ${org.eventHint}`);
  if (org?.albumHint) lines.push(`Album: ${org.albumHint}`);
  if (org?.tripHint) lines.push(`Trip: ${org.tripHint}`);
  if (org?.peopleHint?.length) lines.push(`People hint: ${org.peopleHint.join(", ")}`);

  return lines.join("\n");
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && t.length <= 64);
}