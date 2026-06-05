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
import { serviceClient } from "../_pipeline/clients.ts";
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
    return { bytes: new Uint8Array(buf.slice(0, maxBytes)), mime };
  } catch {
    return null;
  }
}

export async function generateDerived(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
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

  if (thumbBytes) {
    const ext = thumbBytes.mime.split("/")[1]?.split("+")[0] ?? "jpg";
    const path = `${asset.user_id}/${asset_id}/thumb.${ext}`;
    const { error } = await sb.storage.from(STORAGE_BUCKETS.derived).upload(path, thumbBytes.bytes, {
      contentType: thumbBytes.mime, upsert: true,
    });
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

  if (!previewBytes && asset.proxy_cache_key && /^https?:\/\//.test(asset.proxy_cache_key)) {
    previewBytes = await fetchBytes(asset.proxy_cache_key, 8 * 1024 * 1024);
  }

  if (previewBytes) {
    const ext = previewBytes.mime.split("/")[1]?.split("+")[0] ?? "jpg";
    const path = `${asset.user_id}/${asset_id}/preview.${ext}`;
    const { error } = await sb.storage.from(STORAGE_BUCKETS.derived).upload(path, previewBytes.bytes, {
      contentType: previewBytes.mime, upsert: true,
    });
    if (!error || /exists/i.test(error.message ?? "")) {
      written.push({ kind: "preview", path, mime: previewBytes.mime, bytes_written: previewBytes.bytes.byteLength });
    } else {
      console.error("generateDerived: preview upload error", { asset_id, error: error.message });
    }
  }

  if (written.length === 0) {
    // No storage derivatives generated. Still write asset_preview_metadata so
    // enrichAI / ocrAsset can find the provider-served URL via this table.
    // Preserve existing thumbnail_cache_key on the asset row unchanged.
    await sb.from("asset_preview_metadata").upsert({
      asset_id,
      user_id: asset.user_id,
      thumbnail_generated: Boolean(asset.thumbnail_cache_key),
      preview_generated: Boolean(asset.proxy_cache_key),
      thumbnail_cache_key: asset.thumbnail_cache_key ?? null,
      preview_cache_key: asset.proxy_cache_key ?? null,
    }, { onConflict: "asset_id" });
    if (asset.thumbnail_cache_key || asset.proxy_cache_key) {
      return {
        asset_id,
        derivatives: 0,
        thumbnail: Boolean(asset.thumbnail_cache_key),
        preview: Boolean(asset.proxy_cache_key),
        reused_provider_urls: true,
      };
    }
    throw new Error("retryable: no thumbnail or preview bytes available");
  }

  // Persist derivative records.
  const { error: derivErr } = await sb.from("asset_derivatives").upsert(
    written.map((w) => ({
      asset_id,
      kind: w.kind,
      storage_bucket: STORAGE_BUCKETS.derived,
      storage_path: w.path,
      mime_type: w.mime,
      blurhash: w.blurhash ?? null,
    })),
    { onConflict: "asset_id,kind" },
  );
  if (derivErr) console.error("generateDerived: asset_derivatives upsert failed", { asset_id, error: derivErr.message });

  const thumb = written.find((w) => w.kind === "thumb");
  const preview = written.find((w) => w.kind === "preview");

  const { error: prevErr } = await sb.from("asset_preview_metadata").upsert({
    asset_id,
    user_id: asset.user_id,
    blurhash: thumb?.blurhash ?? preview?.blurhash ?? null,
    thumbnail_generated: !!thumb,
    preview_generated: !!preview,
    thumbnail_cache_key: thumb?.path ?? null,
    preview_cache_key: preview?.path ?? null,
  }, { onConflict: "asset_id" });
  if (prevErr) console.error("generateDerived: asset_preview_metadata upsert failed", { asset_id, error: prevErr.message });

  // Update asset row — only overwrite if we have storage-backed paths now.
  const assetUpdate: Record<string, unknown> = {};
  if (thumb) assetUpdate.thumbnail_cache_key = thumb.path;
  if (preview) assetUpdate.proxy_cache_key = preview.path;
  if (Object.keys(assetUpdate).length > 0) {
    await sb.from("assets").update(assetUpdate).eq("id", asset_id);
  }

  return { asset_id, derivatives: written.length, thumb: !!thumb, preview: !!preview };
}
