/**
 * File-extension + MIME classification for the browser scan runner.
 * Mirrors the spec's classification matrix.
 */
import type { MediaType } from "../../../packages/core/metadata/types";

const PHOTO_EXT = new Set([
  "jpg","jpeg","png","gif","webp","bmp","tif","tiff","heic","heif",
  "raw","cr2","cr3","nef","arw","dng","orf","rw2","raf","srw","pef",
  "avif","jxl",
]);
const VIDEO_EXT = new Set([
  "mp4","mov","m4v","avi","mkv","wmv","flv","webm","mpg","mpeg","3gp","mts","m2ts","mxf","hevc","insv",
]);
const AUDIO_EXT = new Set([
  "mp3","m4a","aac","flac","wav","ogg","oga","opus","wma","aif","aiff","amr","caf",
]);
const DOCUMENT_EXT = new Set([
  "pdf","doc","docx","odt","rtf","txt","md","pages",
  "xls","xlsx","ods","numbers","csv","tsv",
  "ppt","pptx","odp","key",
  "epub","mobi","azw","azw3","djvu",
  "html","htm","xml","json","yaml","yml",
]);

const IGNORED_NAMES = new Set([
  ".DS_Store","Thumbs.db","desktop.ini",".localized",
]);

export const IGNORED_DIRS = new Set([
  ".git","node_modules",".svn",".hg","__MACOSX",
  "Library","$RECYCLE.BIN",".Trashes","System Volume Information",
  ".cache",".tmp",".thumbnails",
]);

export function classify(filename: string, mime?: string | null): {
  mediaType: MediaType;
  extension: string | null;
  normalizedExtension: string | null;
  ignored: boolean;
} {
  if (IGNORED_NAMES.has(filename) || filename.startsWith("._")) {
    return { mediaType: "other", extension: null, normalizedExtension: null, ignored: true };
  }
  const dot = filename.lastIndexOf(".");
  const extRaw = dot > 0 ? filename.slice(dot + 1) : "";
  const ext = extRaw.toLowerCase();
  let mediaType: MediaType = "other";
  if (PHOTO_EXT.has(ext)) mediaType = "photo";
  else if (VIDEO_EXT.has(ext)) mediaType = "video";
  else if (AUDIO_EXT.has(ext)) mediaType = "audio";
  else if (DOCUMENT_EXT.has(ext)) mediaType = "document";
  else if (mime?.startsWith("image/")) mediaType = "photo";
  else if (mime?.startsWith("video/")) mediaType = "video";
  else if (mime?.startsWith("audio/")) mediaType = "audio";
  else if (mime === "application/pdf") mediaType = "document";
  return {
    mediaType,
    extension: extRaw || null,
    normalizedExtension: ext || null,
    ignored: false,
  };
}

export function isSupported(mediaType: MediaType): boolean {
  return mediaType !== "other";
}