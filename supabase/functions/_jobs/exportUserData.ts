// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function exportUserData(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, export_id } = ctx.payload as { user_id: string; export_id: string };
  if (!user_id || !export_id) throw new Error("invalid: user_id/export_id");

  const [profile, assets, sources, families] = await Promise.all([
    sb.from("user_profiles").select("*").eq("user_id", user_id).maybeSingle(),
    sb.from("assets").select("*").eq("user_id", user_id).limit(50000),
    sb.from("source_accounts").select("*").eq("user_id", user_id),
    sb.from("family_members").select("*").eq("user_id", user_id),
  ]);
  const bundle = {
    schema: "lifeshot.export/v1", generated_at: new Date().toISOString(),
    user: profile.data ?? null,
    assets: assets.data ?? [], sources: sources.data ?? [], families: families.data ?? [],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const path = `${user_id}/${export_id}.json`;
  const { error } = await sb.storage.from(STORAGE_BUCKETS.exports).upload(path, bytes, {
    contentType: "application/json", upsert: true,
  });
  if (error && !/exists/i.test(error.message)) throw new Error(`storage upload: ${error.message}`);

  await sb.from("data_exports").update({
    status: "ready", storage_bucket: STORAGE_BUCKETS.exports, storage_path: path,
    bytes: bytes.length, ready_at: new Date().toISOString(),
  }).eq("id", export_id);

  return { export_id, bytes: bytes.length, path };
}