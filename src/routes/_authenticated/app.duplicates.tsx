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