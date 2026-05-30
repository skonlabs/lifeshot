import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/app/events")({
  head: () => ({ meta: [{ title: "Events — LifeShot" }] }),
  component: () => (
    <div>
      <h1 className="font-display text-4xl text-ink">Events</h1>
      <p className="mt-2 text-foreground/70">Trips, birthdays, gatherings — detected automatically once you have memories indexed.</p>
    </div>
  ),
});
*** Add File: src/routes/_authenticated/app.people.tsx
import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/app/people")({
  head: () => ({ meta: [{ title: "People — LifeShot" }] }),
  component: () => (
    <div>
      <h1 className="font-display text-4xl text-ink">People</h1>
      <p className="mt-2 text-foreground/70">Face clustering is off by default. Enable in Privacy when you're ready.</p>
    </div>
  ),
});
*** Add File: src/routes/_authenticated/app.duplicates.tsx
import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/app/duplicates")({
  head: () => ({ meta: [{ title: "Duplicates — LifeShot" }] }),
  component: () => (
    <div>
      <h1 className="font-display text-4xl text-ink">Duplicates</h1>
      <p className="mt-2 text-foreground/70">We group near-duplicates across sources. Nothing is ever auto-deleted.</p>
    </div>
  ),
});
*** Add File: src/routes/_authenticated/app.family.tsx
import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/app/family")({
  head: () => ({ meta: [{ title: "Family — LifeShot" }] }),
  component: () => (
    <div>
      <h1 className="font-display text-4xl text-ink">Family</h1>
      <p className="mt-2 text-foreground/70">Invite family. Sharing is private-by-default — explicit per memory or event.</p>
    </div>
  ),
});
*** Add File: src/routes/_authenticated/app.settings.tsx
import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/app/settings")({
  head: () => ({ meta: [{ title: "Privacy — LifeShot" }] }),
  component: () => (
    <div>
      <h1 className="font-display text-4xl text-ink">Privacy</h1>
      <p className="mt-2 text-foreground/70">AI processing, face clustering, family sharing — all opt-in.</p>
    </div>
  ),
});
*** Add File: src/routes/api.v1.sources.callback.$provider.ts
import { createFileRoute } from "@tanstack/react-router";

/** OAuth callback stub. Real impl will exchange the code via the connector. */
export const Route = createFileRoute("/api/v1/sources/callback/$provider")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const url = new URL(request.url);
        const stub = url.searchParams.get("stub");
        const returnTo = url.searchParams.get("return") ?? "/app/sources";
        if (stub) {
          // Stub flow — bounce back with a note.
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