import { createFileRoute, Link } from "@tanstack/react-router";
import { useEvents } from "@/lib/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/events")({ component: Events });

function Events() {
  const { data, isLoading } = useEvents();
  const events = data?.events ?? [];
  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <header className="hairline-b mb-6 pb-4">
        <span className="text-archive-label">chapters</span>
        <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">Moments grouped into stories</h1>
      </header>
      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-md" />)}
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-[color:var(--umber)]">No chapters detected yet — sync a source to begin.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {events.map((e) => (
            <li key={e.id}>
              <Link to="/events/$id" params={{ id: e.id }}
                className="hairline group flex items-baseline justify-between gap-4 rounded-md border bg-[color:var(--paper)] p-4 transition-colors hover:bg-[color:var(--paper-2)]">
                <div className="min-w-0">
                  <div className="font-serif-display text-xl text-[color:var(--ink)] truncate">{e.title ?? "Untitled chapter"}</div>
                  <div className="mt-1 text-xs text-[color:var(--umber)]">
                    {e.start_time?.slice(0, 10) ?? "—"} – {e.end_time?.slice(0, 10) ?? "—"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-display text-2xl tabular-nums text-[color:var(--ink)]">{e.asset_count}</div>
                  <div className="text-[10px] uppercase tracking-wider text-[color:var(--umber)]">memories</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}