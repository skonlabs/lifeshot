import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTimeline, useViewport } from "@/lib/api/hooks";
import { VirtualGrid } from "@/components/app/VirtualGrid";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/library")({ component: Library });

function Library() {
  const viewport = useViewport({ viewport_size: 60 });
  const timeline = useTimeline("month");

  const items = useMemo(
    () => viewport.data?.pages.flatMap((p) => p.items) ?? [],
    [viewport.data],
  );

  return (
    <div className="px-4 py-6">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="font-display text-2xl">Library</h1>
        {timeline.data && (
          <div className="hidden gap-1 overflow-x-auto text-xs text-muted-foreground md:flex">
            {timeline.data.buckets.slice(0, 18).map((b) => (
              <span key={b.bucket} className="rounded bg-muted px-2 py-0.5 whitespace-nowrap">
                {b.bucket} · {b.asset_count}
              </span>
            ))}
          </div>
        )}
      </header>
      {viewport.isLoading ? (
        <div className="grid grid-cols-6 gap-2">
          {Array.from({ length: 18 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-md" />)}
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
    <div className="rounded-lg border-2 border-dashed py-16 text-center">
      <h2 className="font-display text-lg">Your library is empty</h2>
      <p className="mt-2 text-sm text-muted-foreground">Connect a source to start indexing memories.</p>
      <a href="/sources" className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
        Connect a source
      </a>
    </div>
  );
}