import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

type Search = {
  error?: string;
  detail?: string;
  connected?: string;
  provider?: string;
};

export const Route = createFileRoute("/oauth-popup")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    error: typeof s.error === "string" ? s.error : undefined,
    detail: typeof s.detail === "string" ? s.detail : undefined,
    connected: typeof s.connected === "string" ? s.connected : undefined,
    provider: typeof s.provider === "string" ? s.provider : undefined,
  }),
  component: OAuthPopup,
});

function OAuthPopup() {
  const search = Route.useSearch();
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const opener = window.opener as Window | null;
      if (opener && opener !== window) {
        opener.postMessage(
          {
            type: "pmp:oauth",
            error: search.error ?? null,
            detail: search.detail ?? null,
            connected: search.connected ?? null,
            provider: search.provider ?? null,
          },
          "*",
        );
      }
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => {
      try { window.close(); } catch { /* ignore */ }
    }, 50);
    return () => clearTimeout(t);
  }, [search.error, search.detail, search.connected, search.provider]);

  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      {search.error ? "Connection failed. You can close this window." : "Connected. You can close this window."}
    </div>
  );
}