/**
 * Browser Supabase client.
 * Uses the user's external Supabase project (NOT Lovable Cloud).
 * Publishable key is safe in client bundles — RLS protects data.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://vohevknnbvpaooletyts.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_8DJ7KPaQ8JdG9-ZOqa30uw_pkc4pLpX";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  _client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: typeof window !== "undefined",
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
    },
  });
  return _client;
}

export const supabase = getSupabase();