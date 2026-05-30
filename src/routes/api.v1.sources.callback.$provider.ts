import { createFileRoute } from "@tanstack/react-router";

/** OAuth callback stub. Real impl exchanges the code via the matching connector. */
export const Route = createFileRoute("/api/v1/sources/callback/$provider")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const url = new URL(request.url);
        const stub = url.searchParams.get("stub");
        const returnTo = url.searchParams.get("return") ?? "/app/sources";
        if (stub) {
          const u = new URL(returnTo, url.origin);
          u.searchParams.set("connected", "stub");
          u.searchParams.set("provider", params.provider);
          return Response.redirect(u.toString(), 302);
        }
        return new Response(`OAuth callback for ${params.provider} — not implemented yet`, {
          status: 501,
        });
      },
    },
  },
});