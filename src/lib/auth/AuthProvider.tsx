import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

interface AuthCtx {
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const qc = useQueryClient();

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (sessionData.session) {
        // Validate the session against the auth server. If the session was
        // revoked server-side (session_not_found / JWT issues), clear the
        // stale tokens from localStorage so sign-in can proceed cleanly.
        const { error } = await supabase.auth.getUser();
        if (error) {
          try { await supabase.auth.signOut({ scope: "local" } as never); } catch { /* ignore */ }
          if (!mounted) return;
          setSession(null);
          setLoading(false);
          return;
        }
      }
      if (!mounted) return;
      setSession(sessionData.session);
      setLoading(false);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      router.invalidate();
      qc.invalidateQueries();
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [router, qc]);

  return (
    <Ctx.Provider
      value={{
        user: session?.user ?? null,
        session,
        isAuthenticated: !!session,
        loading,
        signOut: async () => {
          await supabase.auth.signOut();
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}