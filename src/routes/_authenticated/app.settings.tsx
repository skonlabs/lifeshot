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