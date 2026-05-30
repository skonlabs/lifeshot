import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getDashboard } from "@/lib/api/dashboard.functions";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/app/")({
  head: () => ({ meta: [{ title: "Dashboard — LifeShot" }] }),
  component: Dashboard,
});

function Dashboard() {
  const { data } = useQuery({ queryKey: ["dashboard"], queryFn: () => getDashboard() });
  const stats = [
    { label: "Memories indexed", value: data?.total_assets ?? 0 },
    { label: "Videos", value: data?.total_videos ?? 0 },
    { label: "Connected sources", value: data?.connected_sources ?? 0 },
    { label: "Duplicate groups", value: data?.in_duplicate_groups ?? 0 },
    { label: "At-risk memories", value: data?.at_risk_count ?? 0, hint: "Stored in only one place" },
  ];
  return (
    <div>
      <h1 className="font-display text-4xl text-ink">Your memory vault</h1>
      <p className="mt-2 text-foreground/70">
        Connect a source to start indexing. Originals stay in place — we only store thumbnails, metadata, and AI signals.
      </p>
      <div className="mt-8 grid grid-cols-2 lg:grid-cols-5 gap-4">
        {stats.map((s) => (
          <Card key={s.label} className="p-5 rounded-2xl border-border">
            <div className="text-xs uppercase tracking-wide text-foreground/60">{s.label}</div>
            <div className="mt-1 font-display text-3xl text-ink">{s.value.toLocaleString()}</div>
            {s.hint && <div className="mt-1 text-xs text-foreground/60">{s.hint}</div>}
          </Card>
        ))}
      </div>
      <div className="mt-10 p-6 rounded-2xl border border-border bg-paper-2">
        <div className="font-display text-xl text-ink">Next step</div>
        <p className="mt-1 text-foreground/70 text-sm">
          Head to <a className="underline text-ink" href="/app/sources">Sources</a> to connect Google Photos, Dropbox, or your phone.
        </p>
      </div>
    </div>
  );
}