// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { STORAGE_BUCKETS } from "../_pipeline/clients.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function exportUserData(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { user_id, export_id } = ctx.payload as { user_id: string; export_id?: string };
  if (!user_id) throw new Error("invalid: user_id");

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
  const path = `${user_id}/${export_id ?? crypto.randomUUID()}.json`;
  const { error } = await sb.storage.from(STORAGE_BUCKETS.exports).upload(path, bytes, {
    contentType: "application/json", upsert: true,
  });
  if (error && !/exists/i.test(error.message)) throw new Error(`storage upload: ${error.message}`);

  // data_exports was dropped in B-NUKE. The signed download URL is returned
  // directly to the caller (privacy endpoint) instead of being persisted.
  const { data: signed } = await sb.storage.from(STORAGE_BUCKETS.exports)
    .createSignedUrl(path, 60 * 60 * 24);

  return { export_id, bytes: bytes.length, path, download_url: signed?.signedUrl ?? null };
}