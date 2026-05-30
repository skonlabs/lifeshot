import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { listProviders, startConnect } from "@/lib/api/sources.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/app/sources")({
  head: () => ({ meta: [{ title: "Sources — LifeShot" }] }),
  component: Sources,
});

function Sources() {
  const { data } = useQuery({ queryKey: ["providers"], queryFn: () => listProviders() });
  const connect = useMutation({
    mutationFn: (provider: string) =>
      startConnect({ data: { provider: provider as never, returnTo: "/app/sources" } }),
    onSuccess: (r) => { window.location.href = r.redirectUrl; },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div>
      <h1 className="font-display text-4xl text-ink">Connect your memories</h1>
      <p className="mt-2 text-foreground/70 max-w-2xl">
        Originals never leave the source. LifeShot stores metadata, thumbnails (where allowed), and AI signals so you can search and organize across everything.
      </p>
      <div className="mt-8 grid sm:grid-cols-2 gap-4">
        {data?.providers.map((p) => (
          <Card key={p.id} className="p-5 rounded-2xl border-border flex items-start justify-between gap-4">
            <div>
              <div className="font-display text-lg text-ink">{p.displayName}</div>
              <div className="mt-1 text-xs uppercase tracking-wide text-foreground/60">{p.status}</div>
              {p.note && <div className="mt-2 text-sm text-foreground/70">{p.note}</div>}
            </div>
            <Button
              disabled={!p.available || connect.isPending}
              onClick={() => connect.mutate(p.id)}
              className="rounded-full bg-ink text-paper hover:bg-ink/90"
            >
              {p.available ? "Connect" : "Soon"}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}