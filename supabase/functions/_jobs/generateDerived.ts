// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import { providers } from "./mocks.ts";
import type { JobContext } from "../_pipeline/runner.ts";

const SIZES = [
  { name: "thumb",   width: 256,  height: 256,  kind: "thumb"   as const },
  { name: "preview", width: 1024, height: 1024, kind: "preview" as const },
];

export async function generateDerived(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { asset_id } = ctx.payload as { asset_id: string };
  const { data: asset } = await sb.from("assets").select("id, user_id, thumbnail_url, preview_url").eq("id", asset_id).single();
  if (!asset) throw new Error("not found: asset");

  const written: Array<{ name: string; path: string; mime: string; blurhash?: string }> = [];
  for (const sz of SIZES) {
    const r = await providers.renderer.render({
      sourceUrl: asset.preview_url ?? asset.thumbnail_url, width: sz.width, height: sz.height, kind: sz.kind,
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

  return { asset_id, derivatives: written.length };
}