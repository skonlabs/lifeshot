import { useEffect, useMemo, useRef } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { AssetCell } from "./AssetCell";

interface Descriptor {
  asset_id: string;
  thumbnail_url: string | null;
  blurhash: string | null;
  dominant_color: string | null;
  width: number | null;
  height: number | null;
  media_type: string;
  source_badge: string | null;
  hydration_status: "pending" | "ready";
}

interface Props {
  items: Descriptor[];
  fetchNext: () => void;
  hasNext: boolean;
  isFetching: boolean;
  selectionMode?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (id: string, shift: boolean) => void;
}

export function VirtualGrid({ items, fetchNext, hasNext, isFetching, selectionMode, selected, onToggleSelect }: Props) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const COLS = 6;
  const rows = useMemo(() => {
    const out: Descriptor[][] = [];
    for (let i = 0; i < items.length; i += COLS) out.push(items.slice(i, i + COLS));
    return out;
  }, [items]);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 200,
    overscan: 4,
    scrollMargin: parentRef.current?.offsetTop ?? 0,
  });

  useEffect(() => {
    const last = virtualizer.getVirtualItems().at(-1);
    if (!last) return;
    if (last.index >= rows.length - 2 && hasNext && !isFetching) {
      fetchNext();
    }
  }, [virtualizer, rows.length, hasNext, isFetching, fetchNext]);

  return (
    <div ref={parentRef} className="relative">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vr) => {
          const row = rows[vr.index];
          return (
            <div
              key={vr.key}
              className="absolute left-0 right-0 grid gap-2 px-1"
              style={{
                transform: `translateY(${vr.start - virtualizer.options.scrollMargin}px)`,
                gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
              }}
            >
              {row.map((d) => (
                <div
                  key={d.asset_id}
                  className="aspect-square relative"
                  onClick={(e) => {
                    if (!selectionMode) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleSelect?.(d.asset_id, e.shiftKey);
                  }}
                >
                  <AssetCell d={d} style={{ width: "100%", height: "100%" }} disableLink={selectionMode} />
                  {selectionMode && (
                    <div className={
                      "pointer-events-none absolute inset-0 rounded-md ring-2 transition " +
                      (selected?.has(d.asset_id) ? "ring-[color:var(--ink)] bg-[color:var(--ink)]/15" : "ring-transparent")
                    } />
                  )}
                  {selectionMode && (
                    <div className={
                      "absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full border text-[10px] font-semibold transition " +
                      (selected?.has(d.asset_id)
                        ? "border-[color:var(--ink)] bg-[color:var(--ink)] text-[color:var(--paper)]"
                        : "border-white/80 bg-black/30 text-transparent")
                    }>✓</div>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {isFetching && (
        <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
      )}
    </div>
  );
}