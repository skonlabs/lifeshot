import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useActiveAssetCount, useBulkAssetAction, useTimeline, useViewport } from "@/lib/api/hooks";
import { VirtualGrid } from "@/components/app/VirtualGrid";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckSquare, Trash2, X } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/library")({ component: Library });

type Granularity = "year" | "month" | "day";

function Library() {
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [range, setRange] = useState<{ from?: string; to?: string } | null>(null);
  const viewport = useViewport({ viewport_size: 60, timeline_filter: range ?? undefined });
  const timeline = useTimeline(granularity);
  const assetCount = useActiveAssetCount();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);
  const bulk = useBulkAssetAction();

  const items = useMemo(
    () => viewport.data?.pages.flatMap((p) => p.items) ?? [],
    [viewport.data],
  );
  const totalCount = range ? (viewport.data?.pages[0]?.total_count ?? items.length) : (assetCount.data?.count ?? viewport.data?.pages[0]?.total_count ?? items.length);

  function toggle(id: string, shift: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && lastClickedRef.current) {
        const ids = items.map((i) => i.asset_id);
        const a = ids.indexOf(lastClickedRef.current);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
        }
      } else {
        next.has(id) ? next.delete(id) : next.add(id);
      }
      lastClickedRef.current = id;
      return next;
    });
  }

  function exitSelection() {
    setSelectionMode(false);
    setSelected(new Set());
    lastClickedRef.current = null;
  }

  async function trashSelected() {
    if (!selected.size) return;
    try {
      const res = await bulk.mutateAsync({ asset_ids: Array.from(selected), action: "trash" });
      toast.success(`Moved ${res.affected} to trash`);
      exitSelection();
    } catch (e) {
      toast.error("Bulk delete failed");
    }
  }

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <header className="hairline-b mb-6 flex flex-wrap items-end justify-between gap-4 pb-4">
        <div>
          <span className="text-archive-label">the archive</span>
          <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">{totalCount.toLocaleString()} memories, in order</h1>
          {range && (
            <button onClick={() => setRange(null)} className="mt-2 inline-flex items-center gap-1 rounded-full bg-[color:var(--ink)]/10 px-2.5 py-0.5 text-[11px] text-[color:var(--ink)]">
              {range.from?.slice(0,10)} → {range.to?.slice(0,10)} <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSelectionMode((s) => !s)}
            className={"inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs " + (selectionMode ? "border-[color:var(--ink)] bg-[color:var(--ink)] text-[color:var(--paper)]" : "border-[color:var(--border)] bg-[color:var(--paper)] text-[color:var(--umber)] hover:text-[color:var(--ink)]")}
          >
            <CheckSquare className="h-3.5 w-3.5" /> {selectionMode ? "Done" : "Select"}
          </button>
          <div className="flex items-center gap-1 rounded-full border border-[color:var(--border)] bg-[color:var(--paper-2)] p-0.5 text-xs">
            {(["year","month","day"] as Granularity[]).map((g) => (
              <button key={g} onClick={() => setGranularity(g)}
                className={"rounded-full px-3 py-1 capitalize transition-colors " + (granularity === g ? "bg-[color:var(--ink)] text-[color:var(--paper)]" : "text-[color:var(--umber)] hover:text-[color:var(--ink)]")}>
                {g}
              </button>
            ))}
          </div>
        </div>
      </header>

      {timeline.data && timeline.data.buckets.length > 0 && (
        <div className="hairline mb-6 overflow-x-auto rounded-md border bg-[color:var(--paper)] p-2">
          <div className="flex items-end gap-1 px-1" style={{ minHeight: 48 }}>
            {(() => {
              const buckets = timeline.data!.buckets.slice(0, 60);
              const max = Math.max(...buckets.map((x) => x.asset_count));
              return buckets.map((b: any) => {
                const h = Math.max(6, Math.round((b.asset_count / max) * 40));
                const isActive = range && range.from === b.start_time;
                return (
                  <button
                    key={b.bucket}
                    type="button"
                    title={`${b.bucket} · ${b.asset_count}`}
                    onClick={() => setRange({ from: b.start_time ?? undefined, to: b.end_time ?? undefined })}
                    className="group flex flex-col items-center"
                  >
                    <div
                      className={
                        "w-2 rounded-sm transition-all group-hover:bg-[color:var(--ink)] group-hover:opacity-100 " +
                        (isActive ? "bg-[color:var(--ink)] opacity-100" : "bg-[color:var(--umber)] opacity-60")
                      }
                      style={{ height: h }}
                    />
                  </button>
                );
              });
            })()}
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
          selectionMode={selectionMode}
          selected={selected}
          onToggleSelect={toggle}
        />
      )}

      {selectionMode && selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <div className="hairline flex items-center gap-3 rounded-full border bg-[color:var(--paper)] py-2 pl-4 pr-2 shadow-lg">
            <span className="text-xs text-[color:var(--umber)]">{selected.size} selected</span>
            <button
              onClick={trashSelected}
              disabled={bulk.isPending}
              className="inline-flex items-center gap-1.5 rounded-full bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" /> Move to trash
            </button>
            <button onClick={exitSelection} className="rounded-full p-1.5 text-[color:var(--umber)] hover:text-[color:var(--ink)]">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
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