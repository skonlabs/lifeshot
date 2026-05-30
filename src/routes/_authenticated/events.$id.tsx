import { createFileRoute } from "@tanstack/react-router";
import { useEvent } from "@/lib/api/hooks";

export const Route = createFileRoute("/_authenticated/events/$id")({ component: Event });

function Event() {
  const { id } = Route.useParams();
  const { data, isLoading } = useEvent(id);
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-4 font-display text-2xl">Event</h1>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <pre className="overflow-auto rounded-lg border bg-muted/50 p-4 text-xs">{JSON.stringify(data, null, 2)}</pre>
      )}
    </div>
  );
}