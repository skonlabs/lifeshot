import { createFileRoute, Link } from "@tanstack/react-router";
import { useEvents } from "@/lib/api/hooks";

export const Route = createFileRoute("/_authenticated/events")({ component: Events });

function Events() {
  const { data, isLoading } = useEvents();
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="mb-4 font-display text-2xl">Events</h1>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="space-y-2">
          {data?.events?.map((e) => (
            <li key={e.id}>
              <Link to="/events/$id" params={{ id: e.id }} className="block rounded-lg border p-4 transition-colors hover:bg-accent">
                <div className="font-medium">{e.title ?? "Untitled event"}</div>
                <div className="text-xs text-muted-foreground">
                  {e.start_time?.slice(0, 10)} – {e.end_time?.slice(0, 10)} · {e.asset_count} memories
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}