import { createClient } from "@supabase/supabase-js";

// Publishable key — safe to expose in client code. RLS protects all data.
export const SUPABASE_URL = "https://vohevknnbvpaooletyts.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_8DJ7KPaQ8JdG9-ZOqa30uw_pkc4pLpX";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});