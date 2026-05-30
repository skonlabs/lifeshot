import { createFileRoute, Link } from "@tanstack/react-router";
import { useAsset, useAssetSources } from "@/lib/api/hooks";
import { ArrowLeft } from "lucide-react";

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
    <div className="mx-auto max-w-6xl px-6 py-6">
      <Link to="/library" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to library
      </Link>
      {asset.isLoading ? (
        <div className="aspect-video animate-pulse rounded-lg bg-muted" />
      ) : asset.error ? (
        <p className="text-sm text-destructive">Couldn't load this asset.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="overflow-hidden rounded-lg bg-muted" style={{ backgroundColor: d?.dominant_color ?? undefined }}>
            {hiRes && <img src={hiRes} alt="" className="h-auto w-full object-contain" />}
          </div>
          <aside className="space-y-4 text-sm">
            <section className="rounded-lg border p-4">
              <h2 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Metadata</h2>
              <dl className="space-y-1">
                {a && Object.entries(a)
                  .filter(([k]) => !k.startsWith("_") && typeof a[k] !== "object")
                  .slice(0, 14)
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="truncate text-right">{String(v ?? "—")}</dd>
                    </div>
                  ))}
              </dl>
            </section>
            <section className="rounded-lg border p-4">
              <h2 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Sources</h2>
              {sources.isLoading ? (
                <p className="text-muted-foreground">Loading…</p>
              ) : sources.data?.sources?.length ? (
                <ul className="space-y-1">
                  {sources.data.sources.map((s, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      {String((s as Record<string, unknown>).provider_kind ?? "source")}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No source refs.</p>
              )}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}