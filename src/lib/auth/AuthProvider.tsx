import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  getCachedSession,
  isAuthReady,
  supabase,
  syncSessionCache,
} from "@/lib/supabase";

interface AuthCtx {
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => getCachedSession());
  const [loading, setLoading] = useState(() => !isAuthReady());
  const router = useRouter();
  const qc = useQueryClient();

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      syncSessionCache(nextSession);
      setSession(nextSession);
      if (event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        setLoading(false);
      }

      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        void router.invalidate();
      }

      if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        void qc.invalidateQueries();
      }
    });

    return () => {
      subscription.unsubscribe();
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
          await qc.cancelQueries();
          qc.clear();
          const { error } = await supabase.auth.signOut();
          if (error) throw error;
          await router.navigate({ to: "/sign-in", replace: true });
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