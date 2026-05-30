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