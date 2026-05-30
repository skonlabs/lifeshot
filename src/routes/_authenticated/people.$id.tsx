import { createFileRoute } from "@tanstack/react-router";
import { usePerson } from "@/lib/api/hooks";

export const Route = createFileRoute("/_authenticated/people/$id")({ component: Person });

function Person() {
  const { id } = Route.useParams();
  const { data, isLoading } = usePerson(id);
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-4 font-display text-2xl">Person</h1>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <pre className="overflow-auto rounded-lg border bg-muted/50 p-4 text-xs">{JSON.stringify(data, null, 2)}</pre>
      )}
    </div>
  );
}