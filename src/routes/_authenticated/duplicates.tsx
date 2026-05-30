import { createFileRoute } from "@tanstack/react-router";
import { useConfirmDuplicate, useDuplicates } from "@/lib/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/duplicates")({ component: Duplicates });

function Duplicates() {
  const dupes = useDuplicates();
  const confirm = useConfirmDuplicate();
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="hairline-b mb-6 pb-4">
        <span className="text-archive-label">duplicates</span>
        <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">Nothing is ever deleted.</h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--umber)]">
          We surface near-identical memories so you can choose a primary — originals always remain in their source.
        </p>
      </header>
      {dupes.isLoading ? (
        <div className="space-y-3">{Array.from({length:4}).map((_,i)=><Skeleton key={i} className="h-24 rounded-md" />)}</div>
      ) : dupes.data?.groups?.length ? (
        <ul className="space-y-3">
          {dupes.data.groups.map((g) => (
            <li key={g.id} className="hairline rounded-md border bg-[color:var(--paper)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm">
                    <span className="font-medium text-[color:var(--ink)]">{g.members.length} matches</span>
                    <span className="text-[color:var(--umber)]"> · confidence {Math.round((g.confidence ?? 0) * 100)}%</span>
                  </div>
                  <div className="text-[11px] uppercase tracking-wider text-[color:var(--umber)]">Risk: {g.storage_risk ?? "—"} · {g.status}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => confirm.mutate(
                      { id: g.id, body: { action: "keep_primary", primary_asset_id: g.recommended_primary_asset_id ?? undefined } },
                      { onSuccess: () => toast.success("Marked"), onError: (e) => toast.error((e as Error).message) },
                    )}
                    className="rounded-full bg-[color:var(--ink)] px-3 py-1.5 text-xs text-[color:var(--paper)]"
                  >Keep primary</button>
                  <button onClick={() => confirm.mutate({ id: g.id, body: { action: "keep_all" } })}
                    className="rounded-full border border-[color:var(--border)] px-3 py-1.5 text-xs text-[color:var(--ink)] hover:bg-[color:var(--paper-2)]">Keep all</button>
                  <button onClick={() => confirm.mutate({ id: g.id, body: { action: "mark_reviewed" } })}
                    className="rounded-full border border-[color:var(--border)] px-3 py-1.5 text-xs text-[color:var(--ink)] hover:bg-[color:var(--paper-2)]">Mark reviewed</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="hairline rounded-md border border-dashed bg-[color:var(--paper)] py-16 text-center text-sm text-[color:var(--umber)]">
          No duplicate groups detected. ✨
        </div>
      )}
    </div>
  );
}