import { createFileRoute, Link } from "@tanstack/react-router";
import { useDashboard } from "@/lib/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/dashboard")({ component: Dashboard });

function Dashboard() {
  const { data, isLoading, error } = useDashboard();
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <h1 className="font-display text-3xl">Dashboard</h1>
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">Couldn't load dashboard.</p>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Stat label="Total assets" value={data?.total_assets ?? 0} />
            <Stat label="At risk" value={data?.at_risk ?? 0} />
            <Stat label="Duplicate groups" value={data?.duplicate_groups ?? 0} href="/duplicates" />
          </div>
          {data?.per_year && Object.keys(data.per_year).length > 0 && (
            <section className="rounded-lg border p-5">
              <h2 className="mb-3 text-sm font-semibold text-muted-foreground">By year</h2>
              <ul className="flex flex-wrap gap-3 text-sm">
                {Object.entries(data.per_year).map(([y, n]) => (
                  <li key={y} className="rounded-md bg-muted px-3 py-1">
                    <span className="font-medium">{y}</span> <span className="text-muted-foreground">· {n}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href?: string }) {
  const content = (
    <div className="rounded-lg border bg-card p-5 transition-colors hover:bg-accent">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 font-display text-3xl">{value.toLocaleString()}</div>
    </div>
  );
  return href ? <Link to={href}>{content}</Link> : content;
}