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