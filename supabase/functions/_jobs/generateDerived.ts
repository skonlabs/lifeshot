// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import { getConnector } from "../_sources/registry.ts";
import type { JobContext } from "../_pipeline/runner.ts";

const SIZES = [
  { name: "thumb",   width: 256,  height: 256,  kind: "thumb"   as const },
  { name: "preview", width: 1024, height: 1024, kind: "preview" as const },
];

/** Resolve a fresh signed/temporary source URL for the asset.
 *  Falls back through: proxy_cache_key → thumbnail_cache_key → connector.getOriginalAccessToken */
async function resolveSourceUrl(asset: any, sb: any): Promise<string | undefined> {
  if (asset.proxy_cache_key) return asset.proxy_cache_key;
  if (asset.thumbnail_cache_key) return asset.thumbnail_cache_key;

  // No cached URL — ask the connector for a fresh signed URL.
  const { data: ref } = await sb.from("asset_source_refs")
    .select("source_account_id, source_asset_id, source_kind")
    .eq("asset_id", asset.id)
    .order("is_primary", { ascending: false })
    .limit(1).maybeSingle();
  if (!ref?.source_account_id || !ref?.source_asset_id) return undefined;

  let providerKind = ref.source_kind;
  if (!providerKind) {
    const { data: acct } = await sb.from("source_accounts")
      .select("provider_kind").eq("id", ref.source_account_id).single();
    providerKind = acct?.provider_kind;
  }
  if (!providerKind) return undefined;

  try {
    const conn = getConnector(providerKind, {
      source_account_id: ref.source_account_id,
      user_id: asset.user_id,
      provider_kind: providerKind,
    }, sb);
    const token = await conn.getOriginalAccessToken(ref.source_asset_id);
    if (token?.url) {
      // Cache the URL back on the asset so subsequent jobs can use it.
      await sb.from("assets").update({ proxy_cache_key: token.url }).eq("id", asset.id);
      return token.url;
    }
  } catch (e) {
    console.warn("generateDerived: getOriginalAccessToken failed", String((e as Error)?.message ?? e));
  }
  return undefined;
}

export async function generateDerived(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  const { data: asset } = await sb.from("assets")
    .select("id, user_id, thumbnail_cache_key, proxy_cache_key").eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");

  const sourceUrl = await resolveSourceUrl(asset, sb);
  if (!sourceUrl) {
    console.warn("generateDerived: no source URL for asset", asset_id);
    return { asset_id, derivatives: 0, skipped: true };
  }

  const written: Array<{ name: string; path: string; mime: string; blurhash?: string }> = [];
  for (const sz of SIZES) {
    const r = await providers.renderer.render({
      sourceUrl,
      width: sz.width, height: sz.height, kind: sz.kind,
    });
    const path = `${asset.user_id}/${asset_id}/${sz.name}.${r.mime.split("/")[1] ?? "bin"}`;
    const { error } = await sb.storage.from(STORAGE_BUCKETS.derived).upload(path, r.bytes, {
      contentType: r.mime, upsert: true,
    });
    if (error && !/exists/i.test(error.message)) throw new Error(`storage upload: ${error.message}`);
    written.push({ name: sz.name, path, mime: r.mime, blurhash: r.blurhash });
  }

  await sb.from("asset_derivatives").upsert(written.map((w) => ({
    asset_id, kind: w.name, storage_bucket: STORAGE_BUCKETS.derived, storage_path: w.path,
    mime_type: w.mime, blurhash: w.blurhash ?? null,
  })), { onConflict: "asset_id,kind" });

  const thumb = written.find((item) => item.name === "thumb") ?? null;
  const preview = written.find((item) => item.name === "preview") ?? null;

  await sb.from("asset_preview_metadata").upsert({
    asset_id,
    user_id: asset.user_id,
    blurhash: thumb?.blurhash ?? preview?.blurhash ?? null,
    thumbnail_generated: !!thumb,
    preview_generated: !!preview,
    thumbnail_cache_key: thumb ? `${asset.user_id}/${asset_id}/${thumb.name}.${thumb.mime.split("/")[1] ?? "bin"}` : null,
    preview_cache_key: preview ? `${asset.user_id}/${asset_id}/${preview.name}.${preview.mime.split("/")[1] ?? "bin"}` : null,
  }, { onConflict: "asset_id" });

  await sb.from("assets").update({
    thumbnail_cache_key: thumb?.path ?? asset.thumbnail_cache_key ?? null,
    proxy_cache_key: preview?.path ?? asset.proxy_cache_key ?? null,
  }).eq("id", asset_id);

  return { asset_id, derivatives: written.length };
}
