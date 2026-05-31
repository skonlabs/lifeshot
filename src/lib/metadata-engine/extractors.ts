/**
 * Browser-side extractors. All run on the user's machine on the File
 * object — original bytes never leave the browser. Each extractor is
 * defensive: failure returns null fields, never throws past its scope.
 */
import type {
  FileSystemMetadata, MediaMetadata, HashMetadata, ExifMetadata, GpsMetadata,
  DocumentMetadata, AudioMetadata, VideoMetadata,
} from "../../../packages/core/metadata/types";

export async function sha256Hex(input: string | Uint8Array | ArrayBuffer): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function streamingSha256(file: File): Promise<string | null> {
  try {
    // For files <= 32MB: single buffer; larger: stream via ReadableStream.
    if (file.size <= 32 * 1024 * 1024) {
      const buf = await file.arrayBuffer();
      return sha256Hex(buf);
    }
    // Streaming path: incremental digest is not in WebCrypto — fall back
    // to chunked buffer concat with a max budget; if file is huge skip.
    if (file.size > 1_000 * 1024 * 1024) return null; // skip >1GB
    const chunkSize = 8 * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const slice = file.slice(offset, offset + chunkSize);
      chunks.push(new Uint8Array(await slice.arrayBuffer()));
    }
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { merged.set(c, pos); pos += c.byteLength; }
    return sha256Hex(merged.buffer);
  } catch {
    return null;
  }
}

export async function quickHash(file: File): Promise<string | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
    return `qh1:${file.size}:${await sha256Hex(head.buffer)}`;
  } catch { return null; }
}

export function extractFileSystem(file: File, opts: {
  relativePath: string;
  absolutePathRedacted: string;
  normalizedAbsolutePathHash: string;
  rootPathHash: string;
  folderDepth: number;
  classification: { extension: string | null; normalizedExtension: string | null; mediaType: string };
}): FileSystemMetadata {
  const dot = file.name.lastIndexOf(".");
  return {
    absolutePathRedacted: opts.absolutePathRedacted,
    normalizedAbsolutePathHash: opts.normalizedAbsolutePathHash,
    relativePath: opts.relativePath,
    parentFolderPath: opts.relativePath.split("/").slice(0, -1).join("/") || null,
    rootPathHash: opts.rootPathHash,
    folderDepth: opts.folderDepth,
    filename: file.name,
    filenameWithoutExtension: dot > 0 ? file.name.slice(0, dot) : file.name,
    extension: opts.classification.extension,
    normalizedExtension: opts.classification.normalizedExtension,
    detectedFileType: opts.classification.mediaType,
    fileSizeBytes: file.size,
    modifiedAtFilesystem: new Date(file.lastModified).toISOString(),
    isHidden: file.name.startsWith("."),
    isSymlink: false,
    scanDiscoveredAt: new Date().toISOString(),
  };
}

export async function extractImageDimensions(file: File): Promise<MediaMetadata | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const md: MediaMetadata = {
      width: bitmap.width,
      height: bitmap.height,
      aspectRatio: bitmap.height ? bitmap.width / bitmap.height : null,
      hasVideo: false,
      hasAudio: false,
      thumbnailPossible: true,
      previewPossible: true,
      aiProcessingPossible: true,
    };
    bitmap.close();
    return md;
  } catch { return null; }
}

export async function extractVideoMeta(file: File): Promise<{ media: MediaMetadata; video: VideoMetadata } | null> {
  return await new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const el = document.createElement("video");
      el.preload = "metadata";
      el.muted = true;
      const cleanup = () => { URL.revokeObjectURL(url); el.src = ""; };
      el.onloadedmetadata = () => {
        const media: MediaMetadata = {
          width: el.videoWidth || null,
          height: el.videoHeight || null,
          aspectRatio: el.videoHeight ? el.videoWidth / el.videoHeight : null,
          durationMs: Math.round((el.duration || 0) * 1000) || null,
          hasVideo: true,
          hasAudio: true,
          thumbnailPossible: true,
        };
        const video: VideoMetadata = { raw: {} };
        cleanup();
        resolve({ media, video });
      };
      el.onerror = () => { cleanup(); resolve(null); };
      el.src = url;
    } catch { resolve(null); }
  });
}

/**
 * Tiny EXIF parser (JPEG only, just the fields we need).
 * Returns null on unsupported formats — full exifr is bundled later if needed.
 */
export async function extractExifLite(file: File): Promise<{ exif: ExifMetadata | null; gps: GpsMetadata | null }> {
  try {
    if (!file.type.includes("jpeg") && !file.name.toLowerCase().match(/\.(jpe?g)$/)) {
      return { exif: null, gps: null };
    }
    const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    // Validate SOI
    if (head[0] !== 0xff || head[1] !== 0xd8) return { exif: null, gps: null };
    let i = 2;
    while (i < head.length - 4) {
      if (head[i] !== 0xff) break;
      const marker = head[i + 1];
      const len = (head[i + 2] << 8) | head[i + 3];
      if (marker === 0xe1) {
        // APP1 — could be EXIF
        const segStart = i + 4;
        // "Exif\0\0"
        if (head[segStart] === 0x45 && head[segStart + 1] === 0x78) {
          // Just record presence; full parse would need a library.
          // We expose modifiedAt as a fallback captureTime upstream.
          return {
            exif: { software: "lifeshot:lite", exifCaptureTime: new Date(file.lastModified).toISOString() },
            gps: null,
          };
        }
      }
      i += 2 + len;
    }
    return { exif: null, gps: null };
  } catch { return { exif: null, gps: null }; }
}

export async function extractAudioMeta(file: File): Promise<AudioMetadata | null> {
  return await new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const el = document.createElement("audio");
      el.preload = "metadata";
      const cleanup = () => { URL.revokeObjectURL(url); el.src = ""; };
      el.onloadedmetadata = () => {
        const md: AudioMetadata = {
          durationMs: Math.round((el.duration || 0) * 1000) || null,
          raw: {},
        };
        cleanup();
        resolve(md);
      };
      el.onerror = () => { cleanup(); resolve(null); };
      el.src = url;
    } catch { resolve(null); }
  });
}

export async function extractDocumentMeta(file: File): Promise<DocumentMetadata | null> {
  // Browser-only minimal extraction: PDF page count via byte signature,
  // wordCount/pageCount filled by background job server-side. Return shell.
  try {
    return {
      docTitle: file.name,
      docCreatedAt: new Date(file.lastModified).toISOString(),
      raw: {},
    };
  } catch { return null; }
}