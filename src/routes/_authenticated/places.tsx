import { createFileRoute } from "@tanstack/react-router";
import { usePlaces } from "@/lib/api/hooks";

export const Route = createFileRoute("/_authenticated/places")({ component: Places });

function Places() {
  const { data, isLoading } = usePlaces();
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="mb-4 font-display text-2xl">Places</h1>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {data?.places?.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">{p.lat?.toFixed(3) ?? "—"}, {p.lng?.toFixed(3) ?? "—"}</div>
              </div>
              <div className="text-sm text-muted-foreground">{p.asset_count}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}