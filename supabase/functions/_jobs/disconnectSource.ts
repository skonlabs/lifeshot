// deno-lint-ignore-file no-explicit-any
import { serviceClient } from "../_pipeline/clients.ts";
import { getConnector } from "../_sources/registry.ts";
import type { JobContext } from "../_pipeline/runner.ts";

export async function disconnectSource(ctx: JobContext): Promise<unknown> {
  const sb = serviceClient();
  const { source_account_id, revoke = false, purge_cache = false } = ctx.payload as {
    source_account_id: string; revoke?: boolean; purge_cache?: boolean;
  };
  const { data: acct } = await sb.from("source_accounts").select("*").eq("id", source_account_id).single();
  if (!acct) return { skipped: "missing" };
  const conn = getConnector(acct.provider_kind, { source_account_id, user_id: acct.user_id, provider_kind: acct.provider_kind }, sb);
  if (revoke) await conn.revoke(); else await conn.disconnect();
  if (purge_cache) {
    await sb.from("assets").update({ status: "purged", thumbnail_url: null, preview_url: null })
      .eq("source_account_id", source_account_id);
  }
  return { source_account_id, revoked: revoke, purged: purge_cache };
}