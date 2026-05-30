import { createFileRoute, Link } from "@tanstack/react-router";
import { useEvent } from "@/lib/api/hooks";
import { AssetCell } from "@/components/app/AssetCell";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/events/$id")({ component: Event });

function Event() {
  const { id } = Route.useParams();
  const { data, isLoading } = useEvent(id);
  const e = data as
    | {
        id: string;
        title: string | null;
        start_time: string | null;
        end_time: string | null;
        asset_count?: number;
        assets?: Array<{
          asset_id: string;
          thumbnail_url: string | null;
          blurhash: string | null;
          dominant_color: string | null;
          width: number | null;
          height: number | null;
          media_type: string;
          source_badge: string | null;
          hydration_status: "pending" | "ready";
        }>;
      }
    | undefined;
  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <Link to="/events" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> All events
      </Link>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !e ? (
        <p className="text-sm text-muted-foreground">Event not found.</p>
      ) : (
        <>
          <header className="mb-6">
            <h1 className="font-display text-3xl">{e.title ?? "Untitled event"}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {e.start_time?.slice(0, 10) ?? "—"} – {e.end_time?.slice(0, 10) ?? "—"}
              {typeof e.asset_count === "number" && ` · ${e.asset_count} memories`}
            </p>
          </header>
          {e.assets?.length ? (
            <div className="grid grid-cols-4 gap-2 md:grid-cols-6">
              {e.assets.map((a) => (
                <div key={a.asset_id} className="aspect-square">
                  <AssetCell d={a} style={{ width: "100%", height: "100%" }} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No memories indexed for this event yet.</p>
          )}
        </>
      )}
    </div>
  );
}