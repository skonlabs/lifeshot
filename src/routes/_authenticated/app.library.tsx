import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getViewport } from "@/lib/api/viewport.functions";

export const Route = createFileRoute("/_authenticated/app/library")({
  head: () => ({ meta: [{ title: "Library — LifeShot" }] }),
  component: Library,
});

function Library() {
  const { data, isLoading } = useQuery({
    queryKey: ["viewport", "all"],
    queryFn: () => getViewport({ data: { pageSize: 60 } }),
  });
  return (
    <div>
      <h1 className="font-display text-4xl text-ink">Library</h1>
      <p className="mt-2 text-foreground/70">Your full timeline, across every source.</p>
      {isLoading && <p className="mt-8 text-foreground/60">Loading viewport…</p>}
      {data?.items.length === 0 && (
        <div className="mt-12 p-8 rounded-2xl border border-border bg-paper-2 text-center">
          <div className="font-display text-2xl text-ink">No memories yet</div>
          <p className="mt-2 text-foreground/70">
            Connect a source to start your timeline.
          </p>
          <a href="/app/sources" className="mt-4 inline-block text-ink underline">Connect a source →</a>
        </div>
      )}
    </div>
  );
}