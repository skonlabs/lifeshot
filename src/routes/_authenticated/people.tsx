import { createFileRoute, Link } from "@tanstack/react-router";
import { usePeople } from "@/lib/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldAlert, UserRound } from "lucide-react";

export const Route = createFileRoute("/_authenticated/people")({ component: People });

function People() {
  const { data, isLoading } = usePeople();
  const faceOff = (data as { face_processing_disabled?: boolean } | undefined)?.face_processing_disabled;
  const people = data?.people ?? [];
  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <header className="hairline-b mb-6 pb-4">
        <span className="text-archive-label">people</span>
        <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">The faces in your archive</h1>
      </header>
      {faceOff && (
        <div className="hairline mb-6 flex items-start gap-3 rounded-md border bg-[color:var(--paper)] p-4">
          <ShieldAlert className="mt-0.5 h-4 w-4 text-[color:var(--umber)]" />
          <div className="text-sm">
            <p className="font-medium text-[color:var(--ink)]">Face recognition is off.</p>
            <p className="text-[color:var(--umber)]">Enable it in <Link to="/settings/privacy" className="underline">Privacy</Link> to group memories by person.</p>
          </div>
        </div>
      )}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="aspect-[4/5] rounded-md" />)}
        </div>
      ) : people.length === 0 && !faceOff ? (
        <div className="hairline rounded-md border border-dashed bg-[color:var(--paper)] py-16 text-center text-sm text-[color:var(--umber)]">
          No people clustered yet — sync a source to begin.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {people.map((p) => (
            <Link key={p.id} to="/people/$id" params={{ id: p.id }}
              className="hairline group block overflow-hidden rounded-md border bg-[color:var(--paper)] transition-colors hover:bg-[color:var(--paper-2)]">
              <div className="grid aspect-[4/5] place-items-center bg-[color:var(--paper-2)] text-[color:var(--umber)]">
                <UserRound className="h-12 w-12" strokeWidth={1.2} />
              </div>
              <div className="p-3">
                <div className="truncate font-medium text-[color:var(--ink)]">{p.display_name ?? "Unknown"}</div>
                <div className="text-xs text-[color:var(--umber)]">{p.asset_count} memories</div>
                {p.consent_required && <div className="mt-1 text-[10px] uppercase tracking-wider text-amber-700">Consent required</div>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}