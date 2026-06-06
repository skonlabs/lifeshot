import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { useCorrection, usePerson, useViewport } from "@/lib/api/hooks";
import { AssetCell } from "@/components/app/AssetCell";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/people/$id")({ component: Person });

function Person() {
  const { id } = Route.useParams();
  const { data, isLoading } = usePerson(id);
  const viewport = useViewport({ viewport_size: 60, people_filter: [id] });
  const correct = useCorrection();
  const p = (data as { person?: { display_name?: string | null }; display_name?: string | null; asset_count?: number } | undefined);
  const displayName = p?.person?.display_name ?? p?.display_name ?? "Unknown";
  const assets = viewport.data?.pages.flatMap((pg) => pg.items) ?? [];
  const totalCount = viewport.data?.pages[0]?.total_count ?? p?.asset_count ?? assets.length;
  const [name, setName] = useState("");
  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <Link to="/people" className="mb-4 inline-flex items-center gap-1 text-xs text-[color:var(--umber)] hover:text-[color:var(--ink)]">
        <ArrowLeft className="h-3 w-3" /> Back to people
      </Link>
      {isLoading ? (
        <Skeleton className="mb-6 h-24 w-full rounded-md" />
      ) : (
        <header className="hairline-b mb-6 pb-4">
          <span className="text-archive-label">a person in your archive</span>
          <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">{displayName}</h1>
          <p className="mt-1 text-sm text-[color:var(--umber)]">{totalCount} memories indexed</p>
        </header>
      )}
      <section className="hairline mb-8 rounded-md border bg-[color:var(--paper)] p-4">
        <div className="text-archive-label mb-2">Rename · correction</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const display_name = name.trim();
            if (!display_name) return;
            correct.mutate(
              { target_type: "person", target_id: id, correction: { display_name } },
              { onSuccess: () => { toast.success("Renamed"); setName(""); }, onError: (err) => toast.error((err as Error).message) },
            );
          }}
          className="flex gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={displayName}
            className="flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-2 text-sm" />
          <button type="submit" className="rounded-md bg-[color:var(--ink)] px-4 py-2 text-sm text-[color:var(--paper)]">Save</button>
        </form>
      </section>
      <section>
        <div className="text-archive-label mb-3">Memories of {displayName}</div>
        {viewport.isLoading ? (
          <div className="grid grid-cols-4 gap-2 md:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-md" />)}
          </div>
        ) : assets.length ? (
          <div className="grid grid-cols-4 gap-2 md:grid-cols-6">
            {assets.map((a) => (
              <div key={a.asset_id} className="aspect-square"><AssetCell d={a} style={{ width: "100%", height: "100%" }} /></div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[color:var(--umber)]">No memories yet for this person.</p>
        )}
      </section>
    </div>
  );
}