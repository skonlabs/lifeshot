import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Camera, Lock, Sparkles } from "lucide-react";

export const Route = createFileRoute("/_authenticated/onboarding")({ component: Onboarding });

function Onboarding() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-12">
      <div className="text-center">
        <Camera className="mx-auto h-10 w-10 text-primary" />
        <h1 className="mt-4 font-display text-3xl">Welcome to LifeShot</h1>
        <p className="mt-2 text-sm text-muted-foreground">We index your memories — we don't move them. Originals stay where they are.</p>
      </div>
      <ul className="space-y-3 text-sm">
        <li className="flex gap-3 rounded-lg border p-4">
          <Lock className="h-5 w-5 shrink-0 text-primary" />
          <div><strong>Index, not store.</strong> We keep a tiny thumbnail and a reference so we can find a memory; the original stays in your source.</div>
        </li>
        <li className="flex gap-3 rounded-lg border p-4">
          <Sparkles className="h-5 w-5 shrink-0 text-primary" />
          <div><strong>AI on your terms.</strong> Search, summaries, and face grouping are off until you opt in — toggle anything in Privacy.</div>
        </li>
      </ul>
      <div className="flex justify-center">
        <button onClick={() => navigate({ to: "/sources" })} className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground">
          Connect your first source
        </button>
      </div>
    </div>
  );
}