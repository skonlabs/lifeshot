import { createFileRoute, Link } from "@tanstack/react-router";
import { useEvents } from "@/lib/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { AssetCell } from "@/components/app/AssetCell";

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
        <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {events.map((e) => (
            <li key={e.id}>
              <Link to="/events/$id" params={{ id: e.id }}
                className="hairline group block overflow-hidden rounded-md border bg-[color:var(--paper)] transition-colors hover:bg-[color:var(--paper-2)]">
                <div className="aspect-[4/3] relative bg-[color:var(--paper-2)]">
                  {e.cover ? (
                    <AssetCell d={{ ...e.cover, width: null, height: null, source_badge: null, hydration_status: "ready" }} style={{ width: "100%", height: "100%" }} disableLink />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-wider text-[color:var(--umber)]">no cover yet</div>
                  )}
                </div>
                <div className="flex items-baseline justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="font-serif-display text-lg text-[color:var(--ink)] truncate">{e.title ?? "Untitled chapter"}</div>
                    <div className="mt-0.5 text-[11px] text-[color:var(--umber)]">
                      {e.start_time?.slice(0, 10) ?? "—"} – {e.end_time?.slice(0, 10) ?? "—"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-display text-xl tabular-nums text-[color:var(--ink)]">{e.asset_count ?? "—"}</div>
                    <div className="text-[9px] uppercase tracking-wider text-[color:var(--umber)]">memories</div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}