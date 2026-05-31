import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Search = {
  connect_provider?: string;
};

export const Route = createFileRoute("/oauth-bridge")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    connect_provider: typeof s.connect_provider === "string" ? s.connect_provider : undefined,
  }),
  component: OAuthBridge,
});

function OAuthBridge() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [status, setStatus] = useState("Preparing secure sign-in…");

  const tokens = useMemo(() => {
    if (typeof window === "undefined") return { accessToken: null, refreshToken: null };
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    const params = new URLSearchParams(hash);
    return {
      accessToken: params.get("access_token"),
      refreshToken: params.get("refresh_token"),
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!search.connect_provider || !tokens.accessToken || !tokens.refreshToken) {
        setStatus("Missing session details. Please close this window and try again.");
        return;
      }

      const { error } = await supabase.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });

      if (cancelled) return;

      if (error) {
        setStatus("Could not restore your session. Please sign in again and retry.");
        return;
      }

      setStatus("Opening Google Photos…");
      navigate({
        to: "/sources",
        search: {
          connect_provider: search.connect_provider,
          oauth_bridge: "1",
        },
        replace: true,
      });
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [navigate, search.connect_provider, tokens.accessToken, tokens.refreshToken]);

  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      {status}
    </div>
  );
}