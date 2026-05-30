import { createFileRoute } from "@tanstack/react-router";
import { useConfirmDuplicate, useDuplicates } from "@/lib/api/hooks";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/duplicates")({ component: Duplicates });

function Duplicates() {
  const dupes = useDuplicates();
  const confirm = useConfirmDuplicate();
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header>
        <h1 className="font-display text-2xl">Duplicates</h1>
        <p className="mt-1 text-sm text-muted-foreground">We never delete anything. You decide which copy to consider primary.</p>
      </header>
      {dupes.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : dupes.data?.groups?.length ? (
        <ul className="space-y-3">
          {dupes.data.groups.map((g) => (
            <li key={g.id} className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">
                    {g.members.length} matches · confidence {Math.round((g.confidence ?? 0) * 100)}%
                  </div>
                  <div className="text-xs text-muted-foreground">Storage risk: {g.storage_risk ?? "—"} · {g.status}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      confirm.mutate(
                        { id: g.id, body: { action: "keep_primary", primary_asset_id: g.recommended_primary_asset_id ?? undefined } },
                        { onSuccess: () => toast.success("Marked"), onError: (e) => toast.error((e as Error).message) },
                      )
                    }
                    className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
                  >Keep primary</button>
                  <button onClick={() => confirm.mutate({ id: g.id, body: { action: "keep_all" } })} className="rounded-md border px-3 py-1.5 text-xs">Keep all</button>
                  <button onClick={() => confirm.mutate({ id: g.id, body: { action: "mark_reviewed" } })} className="rounded-md border px-3 py-1.5 text-xs">Mark reviewed</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No duplicate groups detected.</p>
      )}
    </div>
  );
}