// deno-lint-ignore-file no-explicit-any
/**
 * EXIF / GPS / XMP / IPTC extraction via exifr (pure JS, Deno-compatible
 * via npm: specifier). Returns null on parse failure — never throws.
 *
 * exifr is bundled at edge load time. We use the full builder so XMP/IPTC
 * segments are parsed; we cap workspace at 384 KB upstream so the parse
 * runtime is bounded.
 */
import exifr from "npm:exifr@7.1.3";

export interface ExtractedExif {
  // Camera
  cameraMake?: string;
  cameraModel?: string;
  exifMake?: string;
  exifModel?: string;
  lensMake?: string;
  lensModel?: string;
  // Exposure
  iso?: number;
  aperture?: number;
  fNumber?: number;
  shutterSpeed?: string;
  exposureTime?: string;
  exposureMode?: string;
  focalLength?: number;
  focalLength35mm?: number;
  flash?: string;
  whiteBalance?: string;
  meteringMode?: string;
  software?: string;
  imageUniqueId?: string;
  orientation?: string;
  // Timestamps
  exifCaptureTime?: string;
  exifOriginalTime?: string;
  exifDigitizedTime?: string;
  timezoneOffset?: string;
  // Rights
  artist?: string;
  copyright?: string;
  imageDescription?: string;
}

export interface ExtractedGps {
  latitude?: number;
  longitude?: number;
  altitude?: number;
  gpsTimestamp?: string;
  direction?: number;
  speed?: number;
}

export interface ExtractedMedia {
  width?: number;
  height?: number;
  orientation?: string;
  colorSpace?: string;
  hasAlpha?: boolean;
}

export interface ExtractedXmpIptc {
  xmpTitle?: string;
  xmpDescription?: string;
  xmpCreator?: string;
  xmpRights?: string;
  xmpKeywords?: string[];
  xmpRating?: number;
  iptcCaption?: string;
  iptcHeadline?: string;
  iptcKeywords?: string[];
  iptcByline?: string;
  iptcCity?: string;
  iptcState?: string;
  iptcCountry?: string;
  raw?: Record<string, unknown>;
}

export interface FullExifResult {
  exif: ExtractedExif | null;
  gps: ExtractedGps | null;
  media: ExtractedMedia | null;
  xmpIptc: ExtractedXmpIptc | null;
}

function toIso(v: unknown): string | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

function toNum(v: unknown): number | undefined {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (isFinite(n)) return n;
  }
  return undefined;
}

function toStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.slice(0, 1024);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function toStrArr(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.map((x) => toStr(x)).filter(Boolean) as string[];
    return out.length ? out : undefined;
  }
  if (typeof v === "string") return v.split(/[,;]\s*/).filter(Boolean);
  return undefined;
}

/**
 * Parse a head-range buffer. Works for JPEG, HEIC (limited), TIFF, PNG (XMP),
 * WebP, and most camera RAW front-matter.
 */
export async function extractExifFromBytes(bytes: Uint8Array): Promise<FullExifResult> {
  let parsed: any = null;
  try {
    parsed = await exifr.parse(bytes, {
      tiff: true, ifd0: true, exif: true, gps: true, interop: true,
      xmp: true, iptc: true, icc: false, jfif: true,
      mergeOutput: true, sanitize: true, reviveValues: true,
      translateKeys: true, translateValues: true,
    });
  } catch {
    parsed = null;
  }
  return buildResult(parsed);
}

/** Diagnostic: returns the raw merged exifr output. */
export async function extractExifFromBytesRaw(bytes: Uint8Array): Promise<Record<string, unknown> | null> {
  try {
    return await exifr.parse(bytes, {
      tiff: true, ifd0: true, exif: true, gps: true, interop: true,
      xmp: true, iptc: true, icc: false, jfif: true,
      mergeOutput: true, sanitize: true, reviveValues: true,
      translateKeys: false, translateValues: false,
    });
  } catch {
    return null;
  }
}

function buildResult(parsed: any): FullExifResult {
  if (!parsed || typeof parsed !== "object") {
    return { exif: null, gps: null, media: null, xmpIptc: null };
  }

  const exif: ExtractedExif = {
    cameraMake: toStr(parsed.Make),
    cameraModel: toStr(parsed.Model),
    exifMake: toStr(parsed.Make),
    exifModel: toStr(parsed.Model),
    lensMake: toStr(parsed.LensMake),
    lensModel: toStr(parsed.LensModel ?? parsed.Lens),
    iso: toNum(parsed.ISO ?? parsed.ISOSpeedRatings),
    aperture: toNum(parsed.ApertureValue ?? parsed.FNumber),
    fNumber: toNum(parsed.FNumber),
    shutterSpeed: toStr(parsed.ShutterSpeedValue ?? parsed.ShutterSpeed ?? parsed.ExposureTime),
    exposureTime: toStr(parsed.ExposureTime),
    exposureMode: toStr(parsed.ExposureMode ?? parsed.ExposureProgram),
    focalLength: toNum(parsed.FocalLength),
    focalLength35mm: toNum(parsed.FocalLengthIn35mmFormat),
    flash: toStr(parsed.Flash),
    whiteBalance: toStr(parsed.WhiteBalance),
    meteringMode: toStr(parsed.MeteringMode),
    software: toStr(parsed.Software),
    imageUniqueId: toStr(parsed.ImageUniqueID),
    orientation: toStr(parsed.Orientation),
    exifCaptureTime: toIso(parsed.DateTimeOriginal ?? parsed.CreateDate ?? parsed.DateTime),
    exifOriginalTime: toIso(parsed.DateTimeOriginal),
    exifDigitizedTime: toIso(parsed.CreateDate),
    timezoneOffset: toStr(parsed.OffsetTimeOriginal ?? parsed.OffsetTime),
    artist: toStr(parsed.Artist),
    copyright: toStr(parsed.Copyright),
    imageDescription: toStr(parsed.ImageDescription ?? parsed.Description),
  };
  const hasExif = Object.values(exif).some((v) => v != null);

  // exifr normally synthesizes parsed.latitude / parsed.longitude as decimals
  // when GPS is present. Some JPEGs (or older exifr code paths) leave only
  // the raw IFD arrays — handle both.
  const dms = (v: unknown): number | undefined => {
    if (Array.isArray(v) && v.length >= 3) {
      const d = Number(v[0]), m = Number(v[1]), s = Number(v[2]);
      if (Number.isFinite(d) && Number.isFinite(m) && Number.isFinite(s)) return d + m / 60 + s / 3600;
    }
    return undefined;
  };
  let gpsLat = toNum(parsed.latitude);
  let gpsLng = toNum(parsed.longitude);
  if (gpsLat == null) {
    gpsLat = toNum(parsed.GPSLatitude) ?? dms(parsed.GPSLatitude);
    if (gpsLat != null && /S/i.test(String(parsed.GPSLatitudeRef ?? ""))) gpsLat = -gpsLat;
  }
  if (gpsLng == null) {
    gpsLng = toNum(parsed.GPSLongitude) ?? dms(parsed.GPSLongitude);
    if (gpsLng != null && /W/i.test(String(parsed.GPSLongitudeRef ?? ""))) gpsLng = -gpsLng;
  }
  const gps: ExtractedGps = {
    latitude: gpsLat,
    longitude: gpsLng,
    altitude: toNum(parsed.GPSAltitude),
    gpsTimestamp: toIso(parsed.GPSDateStamp ?? parsed.GPSTimeStamp),
    direction: toNum(parsed.GPSImgDirection),
    speed: toNum(parsed.GPSSpeed),
  };
  const hasGps = gps.latitude != null && gps.longitude != null;

  const media: ExtractedMedia = {
    width: toNum(parsed.ImageWidth ?? parsed.ExifImageWidth ?? parsed.PixelXDimension),
    height: toNum(parsed.ImageHeight ?? parsed.ExifImageHeight ?? parsed.PixelYDimension),
    orientation: toStr(parsed.Orientation),
    colorSpace: toStr(parsed.ColorSpace),
  };
  const hasMedia = Object.values(media).some((v) => v != null);

  const xmpIptc: ExtractedXmpIptc = {
    xmpTitle: toStr(parsed.title ?? parsed.Title),
    xmpDescription: toStr(parsed.description ?? parsed.Description),
    xmpCreator: toStr(parsed.creator ?? parsed.Creator),
    xmpRights: toStr(parsed.rights ?? parsed.Rights),
    xmpKeywords: toStrArr(parsed.subject ?? parsed.Keywords),
    xmpRating: toNum(parsed.Rating),
    iptcCaption: toStr(parsed.Caption ?? parsed["Caption-Abstract"]),
    iptcHeadline: toStr(parsed.Headline),
    iptcKeywords: toStrArr(parsed.Keywords),
    iptcByline: toStr(parsed.Byline ?? parsed.By_line),
    iptcCity: toStr(parsed.City),
    iptcState: toStr(parsed.State ?? parsed["Province-State"]),
    iptcCountry: toStr(parsed.Country ?? parsed["Country-PrimaryLocationName"]),
  };
  const hasXmpIptc = Object.values(xmpIptc).some((v) => v != null);

  return {
    exif: hasExif ? exif : null,
    gps: hasGps ? gps : null,
    media: hasMedia ? media : null,
    xmpIptc: hasXmpIptc ? xmpIptc : null,
  };
}