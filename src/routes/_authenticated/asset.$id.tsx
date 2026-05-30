import { createFileRoute, Link } from "@tanstack/react-router";
import { useAsset, useAssetSources } from "@/lib/api/hooks";
import { ArrowLeft, Layers } from "lucide-react";

export const Route = createFileRoute("/_authenticated/asset/$id")({ component: AssetDetail });

function AssetDetail() {
  const { id } = Route.useParams();
  const asset = useAsset(id);
  const sources = useAssetSources(id);

  const d = asset.data?.descriptor as
    | { thumbnail_url?: string | null; next_quality_url?: string | null; dominant_color?: string | null }
    | undefined;
  const a = asset.data?.asset as Record<string, unknown> | undefined;

  const hiRes = d?.next_quality_url ?? d?.thumbnail_url ?? null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link to="/library" className="mb-6 inline-flex items-center gap-1 text-[11px] uppercase tracking-[0.18em] text-[color:var(--umber)] hover:text-[color:var(--ink)]">
        <ArrowLeft className="h-3 w-3" /> Back to library
      </Link>
      {asset.isLoading ? (
        <div className="aspect-video animate-pulse rounded-md bg-[color:var(--paper-2)]" />
      ) : asset.error ? (
        <p className="text-sm text-destructive">Couldn't load this memory.</p>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[1.7fr_1fr]">
          <figure
            className="hairline overflow-hidden rounded-md border bg-[color:var(--paper-2)]"
            style={{ backgroundColor: d?.dominant_color ?? undefined }}
          >
            {hiRes && <img src={hiRes} alt="" className="h-auto w-full object-contain" />}
          </figure>
          <aside className="space-y-6">
            <section>
              <div className="text-archive-label mb-3">Metadata</div>
              <dl className="hairline divide-y divide-[color:var(--border)] rounded-md border bg-[color:var(--paper)] text-sm">
                {a && Object.entries(a)
                  .filter(([k]) => !k.startsWith("_") && typeof a[k] !== "object")
                  .slice(0, 14)
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 px-4 py-2">
                      <dt className="text-[color:var(--umber)]">{k}</dt>
                      <dd className="truncate text-right text-[color:var(--ink)]">{String(v ?? "—")}</dd>
                    </div>
                  ))}
              </dl>
            </section>
            <section>
              <div className="text-archive-label mb-3 flex items-center gap-1"><Layers className="h-3 w-3" /> Sources</div>
              {sources.isLoading ? (
                <p className="text-sm text-[color:var(--umber)]">Loading…</p>
              ) : sources.data?.sources?.length ? (
                <ul className="flex flex-wrap gap-2">
                  {sources.data.sources.map((s, i) => (
                    <li key={i} className="rounded-full border border-[color:var(--border)] bg-[color:var(--paper)] px-3 py-1 text-[11px] uppercase tracking-wider text-[color:var(--umber)]">
                      {String((s as Record<string, unknown>).provider_kind ?? "source")}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[color:var(--umber)]">No source refs.</p>
              )}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}