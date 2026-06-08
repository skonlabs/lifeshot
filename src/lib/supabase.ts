import { createClient, type Session } from "@supabase/supabase-js";

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

let cachedSession: Session | null = null;
let authReady = false;
let authBootstrapPromise: Promise<Session | null> | null = null;

export function getCachedSession() {
  return cachedSession;
}

export function isAuthReady() {
  return authReady;
}

export function syncSessionCache(session: Session | null) {
  cachedSession = session;
  authReady = true;
}

export async function restoreSessionOnce(): Promise<Session | null> {
  if (authReady) return cachedSession;

  if (!authBootstrapPromise) {
    authBootstrapPromise = supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (error) throw error;
        syncSessionCache(data.session);
        return data.session;
      })
      .finally(() => {
        authBootstrapPromise = null;
      });
  }

  return authBootstrapPromise;
}