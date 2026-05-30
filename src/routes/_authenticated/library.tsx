import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTimeline, useViewport } from "@/lib/api/hooks";
import { VirtualGrid } from "@/components/app/VirtualGrid";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/library")({ component: Library });

type Granularity = "year" | "month" | "day";

function Library() {
  const [granularity, setGranularity] = useState<Granularity>("month");
  const viewport = useViewport({ viewport_size: 60 });
  const timeline = useTimeline(granularity);

  const items = useMemo(
    () => viewport.data?.pages.flatMap((p) => p.items) ?? [],
    [viewport.data],
  );

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <header className="hairline-b mb-6 flex flex-wrap items-end justify-between gap-4 pb-4">
        <div>
          <span className="text-archive-label">the archive</span>
          <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">{items.length.toLocaleString()} memories, in order</h1>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-[color:var(--border)] bg-[color:var(--paper-2)] p-0.5 text-xs">
          {(["year","month","day"] as Granularity[]).map((g) => (
            <button key={g} onClick={() => setGranularity(g)}
              className={"rounded-full px-3 py-1 capitalize transition-colors " + (granularity === g ? "bg-[color:var(--ink)] text-[color:var(--paper)]" : "text-[color:var(--umber)] hover:text-[color:var(--ink)]")}>
              {g}
            </button>
          ))}
        </div>
      </header>

      {timeline.data && timeline.data.buckets.length > 0 && (
        <div className="hairline mb-6 overflow-x-auto rounded-md border bg-[color:var(--paper)] p-2">
          <div className="flex items-end gap-1 px-1" style={{ minHeight: 48 }}>
            {timeline.data.buckets.slice(0, 60).map((b) => {
              const max = Math.max(...timeline.data!.buckets.map((x) => x.asset_count));
              const h = Math.max(6, Math.round((b.asset_count / max) * 40));
              return (
                <div key={b.bucket} className="group flex flex-col items-center" title={`${b.bucket} · ${b.asset_count}`}>
                  <div className="w-2 rounded-sm bg-[color:var(--umber)] opacity-60 transition-all group-hover:bg-[color:var(--ink)] group-hover:opacity-100" style={{ height: h }} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {viewport.isLoading ? (
        <div className="grid grid-cols-6 gap-2">
          {Array.from({ length: 24 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-md" />)}
        </div>
      ) : viewport.error ? (
        <p className="text-sm text-destructive">Couldn't load library.</p>
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <VirtualGrid
          items={items}
          fetchNext={() => viewport.fetchNextPage()}
          hasNext={!!viewport.hasNextPage}
          isFetching={viewport.isFetchingNextPage}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="hairline rounded-lg border border-dashed bg-[color:var(--paper)] py-20 text-center">
      <span className="text-archive-label">vol. 01 · empty</span>
      <h2 className="mt-2 font-serif-display text-3xl text-[color:var(--ink)]">A blank archive</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-[color:var(--umber)]">
        Connect a phone, a cloud drive, or an old hard disk. We'll index quietly and keep the originals where they are.
      </p>
      <Link to="/sources" className="mt-5 inline-block rounded-full bg-[color:var(--ink)] px-5 py-2 text-sm font-medium text-[color:var(--paper)] hover:bg-[color:var(--umber)]">
        Connect a source
      </Link>
    </div>
  );
}