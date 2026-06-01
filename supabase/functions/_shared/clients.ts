import { createClient, type SupabaseClient } from "./deps.ts";
import { ENV } from "./env.ts";
import { ApiError } from "./errors.ts";
import type { Context } from "./deps.ts";

// USER client: RLS-enforcing client created with the caller's JWT.
export function getUserClient(c: Context): SupabaseClient {
  const auth = c.req.header("Authorization");
  if (!auth) throw new ApiError("unauthorized", "Missing Authorization header");
  return createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// SERVICE client: bypasses RLS. Only used for documented service-role operations:
//  - token storage in /sources/callback
//  - disconnect_source cascade
//  - delete_account cascade
//  - export_user_data
//  - derived-data deletion
//  - cache/ratelimit/idempotency/job_queue plumbing
export function getServiceClient(): SupabaseClient {
  if (!ENV.SUPABASE_SERVICE_ROLE_KEY) throw new ApiError("internal", "Service key not configured");
  return createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
