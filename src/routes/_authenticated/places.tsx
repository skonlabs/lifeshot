import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { usePlaces } from "@/lib/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { MapPin } from "lucide-react";

export const Route = createFileRoute("/_authenticated/places")({ component: Places });

function Places() {
  const { data, isLoading } = usePlaces();
  const places = data?.places ?? [];
  const withCoords = useMemo(() => places.filter((p) => p.lat != null && p.lng != null), [places]);

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <header className="hairline-b mb-6 pb-4">
        <span className="text-archive-label">places</span>
        <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">An atlas of where you've been</h1>
      </header>
      {isLoading ? (
        <Skeleton className="h-[420px] w-full rounded-md" />
      ) : (
        <div className="grid grid-cols-12 gap-6">
          {/* Schematic map projection */}
          <div className="col-span-12 lg:col-span-8">
            <div className="hairline relative aspect-[16/10] overflow-hidden rounded-md border bg-[color:var(--paper)]">
              <svg viewBox="-180 -90 360 180" preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
                {/* Equator + prime meridian as quiet rules */}
                <line x1="-180" y1="0" x2="180" y2="0" stroke="currentColor" strokeWidth="0.2" className="text-[color:var(--umber)]/30" />
                <line x1="0" y1="-90" x2="0" y2="90" stroke="currentColor" strokeWidth="0.2" className="text-[color:var(--umber)]/30" />
                {withCoords.map((p) => {
                  const cx = p.lng!;
                  const cy = -p.lat!;
                  const r = Math.max(1.4, Math.min(6, Math.sqrt(p.asset_count) * 0.6));
                  return (
                    <g key={p.id}>
                      <circle cx={cx} cy={cy} r={r} className="fill-[color:var(--ink)]/70" />
                      <circle cx={cx} cy={cy} r={r * 2.2} className="fill-[color:var(--ink)]/10" />
                    </g>
                  );
                })}
              </svg>
              <div className="absolute left-3 top-3 text-archive-label">{withCoords.length} located places</div>
            </div>
          </div>
          <ul className="col-span-12 max-h-[420px] space-y-1 overflow-y-auto pr-1 lg:col-span-4">
            {places.length === 0 ? (
              <li className="text-sm text-[color:var(--umber)]">No places detected yet.</li>
            ) : places.map((p) => (
              <li key={p.id} className="hairline flex items-center justify-between rounded-md border bg-[color:var(--paper)] px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-[color:var(--umber)]" />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-[color:var(--ink)]">{p.name}</div>
                    <div className="text-[11px] text-[color:var(--umber)]">{p.lat?.toFixed(2) ?? "—"}, {p.lng?.toFixed(2) ?? "—"}</div>
                  </div>
                </div>
                <div className="text-xs tabular-nums text-[color:var(--umber)]">{p.asset_count}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}