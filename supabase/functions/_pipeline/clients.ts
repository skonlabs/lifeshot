// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from "../_shared/deps.ts";

const URL_ = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("PROJECT_URL") ?? "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "";

let _svc: SupabaseClient | null = null;
/** Service-role client. RLS bypassed — EVERY query must filter by tenant. */
export function serviceClient(): SupabaseClient {
  if (!_svc) {
    if (!URL_ || !SRK) throw new Error("SUPABASE_URL/SERVICE_ROLE_KEY not configured");
    _svc = createClient(URL_, SRK, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return _svc;
}

export const STORAGE_BUCKETS = {
  derived: "lifeshot-derived",        // thumbnails, blurhash sidecars, proxies
  uploads: "lifeshot-uploads",        // user-uploaded payloads (zips, device batches)
  exports: "lifeshot-exports",        // /privacy/export bundles
};

export async function ensureBuckets(): Promise<void> {
  const sb = serviceClient();
  for (const name of Object.values(STORAGE_BUCKETS)) {
    const { data } = await sb.storage.getBucket(name);
    if (!data) {
      await sb.storage.createBucket(name, { public: false });
    }
  }
}

/** Wrap any DB query that should be tenant-scoped — throws if the caller omits user_id. */
export function assertTenant(rowOrFilter: Record<string, any>): void {
  if (rowOrFilter.user_id === undefined && rowOrFilter.source_account_id === undefined) {
    throw new Error("tenant scoping required: user_id or source_account_id missing");
  }
}