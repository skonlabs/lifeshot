import { createFileRoute, Link } from "@tanstack/react-router";
import { usePeople } from "@/lib/api/hooks";

export const Route = createFileRoute("/_authenticated/people")({ component: People });

function People() {
  const { data, isLoading } = usePeople();
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="mb-4 font-display text-2xl">People</h1>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {data?.people?.map((p) => (
            <Link key={p.id} to="/people/$id" params={{ id: p.id }} className="rounded-lg border p-4 transition-colors hover:bg-accent">
              <div className="font-medium">{p.display_name ?? "Unknown"}</div>
              <div className="text-xs text-muted-foreground">{p.asset_count} memories</div>
              {p.consent_required && <div className="mt-2 text-xs text-amber-600">Consent required</div>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}