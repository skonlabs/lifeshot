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