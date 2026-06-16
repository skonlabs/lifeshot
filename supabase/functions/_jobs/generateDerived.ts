// deno-lint-ignore-file no-explicit-any
/**
 * generateDerived — generates and stores thumbnail + preview derivatives.
 *
 * Strategy:
 *  1. Try to get thumbnail URL from the connector (getThumbnail / getPreview).
 *  2. Download those bytes and upload to Supabase Storage.
 *  3. Fall back to fetching the source URL bytes directly.
 *
 * We deliberately do NOT use the mock renderer for thumbnails — it produces
 * a 1x1 PNG that overwrites the real thumbnail URL with a grey pixel.
 * If no bytes can be obtained, we preserve any existing thumbnail_cache_key.
 */
import { ensureBuckets, serviceClient } from "../_pipeline/clients.ts";
import { STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { getConnector } from "../_sources/registry.ts";
import type { JobContext } from "../_pipeline/runner.ts";

interface DerivedResult {
  kind: "thumb" | "preview";
  path: string;
  mime: string;
  bytes_written: number;
  blurhash?: string | null;
}

async function fetchBytes(url: string, maxBytes = 4 * 1024 * 1024): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/jpeg";
    const buf = await res.arrayBuffer();
    // Do not slice — a truncated JPEG is a corrupt file that Rekognition and
    // image decoders will reject. Return null so the caller falls back.
    if (buf.byteLength > maxBytes) {
      console.warn(`fetchBytes: response too large (${buf.byteLength} bytes > ${maxBytes}), skipping`);
      return null;
    }
    return { bytes: new Uint8Array(buf), mime };
  } catch {
    return null;
  }
}

function isBucketMissing(error?: { message?: string | null } | null): boolean {
  const message = error?.message?.toLowerCase() ?? "";
  return message.includes("bucket not found") || message.includes("not found");
}

export async function generateDerived(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  await ensureBuckets();
  const { asset_id } = ctx.payload as { asset_id: string };
  const { data: asset } = await sb.from("assets")
    .select("id, user_id, media_type, mime_type, thumbnail_cache_key, proxy_cache_key")
    .eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");

  const isImage = (asset.media_type === "photo" || asset.media_type === "image") || (asset.mime_type ?? "").startsWith("image/");
  const isVideo = asset.media_type === "video" || (asset.mime_type ?? "").startsWith("video/");

  // Only generate derivatives for visual media.
  if (!isImage && !isVideo) {
    return { asset_id, derivatives: 0, skipped: "non-visual" };
  }

  const { data: ref } = await sb.from("asset_source_refs")
    .select("source_account_id, source_asset_id, source_kind")
    .eq("asset_id", asset_id)
    .order("is_primary", { ascending: false })
    .limit(1).maybeSingle();

  let providerKind: string | null = ref?.source_kind ?? null;
  if (!providerKind && ref?.source_account_id) {
    const { data: acct } = await sb.from("source_accounts")
      .select("provider_kind").eq("id", ref.source_account_id).single();
    providerKind = acct?.provider_kind ?? null;
  }

  const written: DerivedResult[] = [];

  // ── Thumbnail ──────────────────────────────────────────────────────────────
  let thumbBytes: { bytes: Uint8Array; mime: string } | null = null;
  const thumbBlurhash: string | null = null;

  // 1. Try connector.getThumbnail() — providers like Google Photos serve
  //    ready-made resized versions at w512-h512 without needing original access.
  if (providerKind && ref?.source_asset_id && ref?.source_account_id) {
    try {
      const conn = getConnector(providerKind, {
        source_account_id: ref.source_account_id,
        user_id: asset.user_id,
        provider_kind: providerKind,
      }, sb);
      const thumb = await conn.getThumbnail(ref.source_asset_id).catch(() => null);
      if (thumb?.url) {
        thumbBytes = await fetchBytes(thumb.url, 2 * 1024 * 1024);
      }
    } catch (e) {
      console.warn("generateDerived: getThumbnail failed", String((e as Error)?.message ?? e));
    }
  }

  // 2. Fall back to existing thumbnail_cache_key (if it's a URL, download it).
  if (!thumbBytes && asset.thumbnail_cache_key && /^https?:\/\//.test(asset.thumbnail_cache_key)) {
    thumbBytes = await fetchBytes(asset.thumbnail_cache_key, 2 * 1024 * 1024);
  }

  // 3. Last resort: when there's no thumbnail URL at all, fetch the preview
  //    URL and use it as the thumbnail too. This unblocks assets where the
  //    listing step only populated `proxy_cache_key` (the original/full-res
  //    URL) without a separate small thumbnail — common for Dropbox, OneDrive
  //    and any source that doesn't expose a dedicated thumbnail endpoint.
  if (!thumbBytes && asset.proxy_cache_key && /^https?:\/\//.test(asset.proxy_cache_key)) {
    thumbBytes = await fetchBytes(asset.proxy_cache_key, 2 * 1024 * 1024);
  }

  if (thumbBytes) {
    const ext = thumbBytes.mime.split("/")[1]?.split("+")[0] ?? "jpg";
    const path = `${asset.user_id}/${asset_id}/thumb.${ext}`;
    let { error } = await sb.storage.from(STORAGE_BUCKETS.derived).upload(path, thumbBytes.bytes, {
      contentType: thumbBytes.mime, upsert: true,
    });
    if (isBucketMissing(error)) {
      await ensureBuckets();
      error = (await sb.storage.from(STORAGE_BUCKETS.derived).upload(path, thumbBytes.bytes, {
        contentType: thumbBytes.mime, upsert: true,
      })).error;
    }
    if (!error || /exists/i.test(error.message ?? "")) {
      written.push({ kind: "thumb", path, mime: thumbBytes.mime, bytes_written: thumbBytes.bytes.byteLength, blurhash: thumbBlurhash });
    } else {
      console.error("generateDerived: thumb upload error", { asset_id, error: error.message });
    }
  }

  // ── Preview (larger) ───────────────────────────────────────────────────────
  let previewBytes: { bytes: Uint8Array; mime: string } | null = null;

  if (providerKind && ref?.source_asset_id && ref?.source_account_id) {
    try {
      const conn = getConnector(providerKind, {
        source_account_id: ref.source_account_id,
        user_id: asset.user_id,
        provider_kind: providerKind,
      }, sb);
      const preview = await conn.getPreview(ref.source_asset_id).catch(() => null);
      if (preview?.url) {
        previewBytes = await fetchBytes(preview.url, 8 * 1024 * 1024);
      }
    } catch (e) {
      console.warn("generateDerived: getPreview failed", String((e as Error)?.message ?? e));
    }
  }

  // Fallback 1: proxy_cache_key as HTTP URL
  if (!previewBytes && asset.proxy_cache_key && /^https?:\/\//.test(asset.proxy_cache_key)) {
    previewBytes = await fetchBytes(asset.proxy_cache_key, 8 * 1024 * 1024);
  }

  // Fallback 2: proxy_cache_key as a storage path in the derived bucket
  // (set by a previous generateDerived run that generated preview successfully)
  if (!previewBytes && asset.proxy_cache_key && !/^https?:\/\//.test(asset.proxy_cache_key)) {
    const { data: signed } = await sb.storage
      .from(STORAGE_BUCKETS.derived)
      .createSignedUrl(asset.proxy_cache_key, 60);
    if (signed?.signedUrl) {
      previewBytes = await fetchBytes(signed.signedUrl, 8 * 1024 * 1024);
    }
  }

  // Fallback 3: use the thumbnail bytes as the preview if nothing better is available.
  // Better than no preview at all — enrichAI can at least run face detection.
  if (!previewBytes && thumbBytes) {
    previewBytes = thumbBytes;
  }

  if (previewBytes) {
    const ext = previewBytes.mime.split("/")[1]?.split("+")[0] ?? "jpg";
    const path = `${asset.user_id}/${asset_id}/preview.${ext}`;
    let { error } = await sb.storage.from(STORAGE_BUCKETS.derived).upload(path, previewBytes.bytes, {
      contentType: previewBytes.mime, upsert: true,
    });
    if (isBucketMissing(error)) {
      await ensureBuckets();
      error = (await sb.storage.from(STORAGE_BUCKETS.derived).upload(path, previewBytes.bytes, {
        contentType: previewBytes.mime, upsert: true,
      })).error;
    }
    if (!error || /exists/i.test(error.message ?? "")) {
      written.push({ kind: "preview", path, mime: previewBytes.mime, bytes_written: previewBytes.bytes.byteLength });
    } else {
      console.error("generateDerived: preview upload error", { asset_id, error: error.message });
    }
  }

  if (written.length === 0) {
    // No storage derivatives generated. Persist provider-served URLs on
    // asset_media_metadata so enrichAI / ocrAsset can still resolve them.
    const thumbKey = asset.thumbnail_cache_key ?? asset.proxy_cache_key ?? null;
    const previewKey = asset.proxy_cache_key ?? null;
    await sb.from("asset_media_metadata").upsert({
      asset_id, user_id: asset.user_id,
      thumbnail_url: thumbKey && /^https?:\/\//.test(thumbKey) ? thumbKey : null,
      thumbnail_storage_path: thumbKey && !/^https?:\/\//.test(thumbKey) ? thumbKey : null,
      preview_url: previewKey && /^https?:\/\//.test(previewKey) ? previewKey : null,
      preview_storage_path: previewKey && !/^https?:\/\//.test(previewKey) ? previewKey : null,
    }, { onConflict: "asset_id" });
    // Only reuse provider-served URLs when they are actual HTTP URLs.
    // Storage paths (no http:// prefix) cannot be resolved by enrichAI via
    // signDerivative because they live in a different bucket — returning early
    // here would leave previewImageUrl permanently null.
    const thumbIsUrl = asset.thumbnail_cache_key && /^https?:\/\//.test(asset.thumbnail_cache_key);
    const previewIsUrl = asset.proxy_cache_key && /^https?:\/\//.test(asset.proxy_cache_key);
    if (thumbIsUrl || previewIsUrl) {
      return {
        asset_id,
        derivatives: 0,
        thumbnail: Boolean(thumbIsUrl),
        preview: Boolean(previewIsUrl),
        reused_provider_urls: true,
      };
    }
    throw new Error("retryable: no thumbnail or preview bytes available");
  }

  const thumb = written.find((w) => w.kind === "thumb");
  const preview = written.find((w) => w.kind === "preview");

  // Persist thumbnail/preview paths + jsonb derivatives on asset_media_metadata.
  const derivatives = written.map((w) => ({
    kind: w.kind, storage_bucket: STORAGE_BUCKETS.derived,
    storage_path: w.path, mime_type: w.mime, blurhash: w.blurhash ?? null,
  }));
  // Only update storage paths for derivatives we actually generated — do not
  // null out a path we didn't regenerate, as that would destroy the reference
  // to a previously-stored file and cause "no fetchable image" on the next run.
  const mmPayload: Record<string, unknown> = {
    asset_id, user_id: asset.user_id,
    blurhash: thumb?.blurhash ?? preview?.blurhash ?? null,
    derivatives,
    thumbnails: derivatives,
  };
  if (thumb)    mmPayload.thumbnail_storage_path = thumb.path;
  if (preview)  mmPayload.preview_storage_path   = preview.path;
  const { error: mmErr } = await sb.from("asset_media_metadata").upsert(mmPayload, { onConflict: "asset_id" });
  if (mmErr) console.error("generateDerived: asset_media_metadata upsert failed", { asset_id, error: mmErr.message });

  // Update asset row — only overwrite if we have storage-backed paths now.
  const assetUpdate: Record<string, unknown> = {};
  if (thumb) assetUpdate.thumbnail_cache_key = thumb.path;
  if (preview) assetUpdate.proxy_cache_key = preview.path;
  if (Object.keys(assetUpdate).length > 0) {
    await sb.from("assets").update(assetUpdate).eq("id", asset_id);
  }

  return { asset_id, derivatives: written.length, thumb: !!thumb, preview: !!preview };
}
