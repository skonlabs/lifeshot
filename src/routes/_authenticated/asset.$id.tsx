import { createFileRoute, Link } from "@tanstack/react-router";
import { useAsset, useAssetMetadata, useAssetSources } from "@/lib/api/hooks";
import { ArrowLeft, Download, ExternalLink, Layers } from "lucide-react";

const FIELD_LABELS: Record<string, string> = {
  capture_time: "Captured",
  created_at: "Indexed",
  media_type: "Type",
  mime_type: "Format",
  width: "Width",
  height: "Height",
  duration_ms: "Duration",
  device_make: "Device",
  device_model: "Model",
  checksum_hash: "Checksum",
  file_size: "Size",
};

function humanize(key: string) {
  return FIELD_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const Route = createFileRoute("/_authenticated/asset/$id")({ component: AssetDetail });

function AssetDetail() {
  const { id } = Route.useParams();
  const asset = useAsset(id);
  const metadata = useAssetMetadata(id);
  const sources = useAssetSources(id);

  const d = asset.data?.descriptor as
    | { thumbnail_url?: string | null; next_quality_url?: string | null; dominant_color?: string | null }
    | undefined;
  const a = asset.data?.asset as Record<string, unknown> | undefined;

  const hiRes = d?.next_quality_url ?? d?.thumbnail_url ?? null;
  const srcs = (sources.data?.sources ?? []) as Array<{
    id: string; provider_kind: string | null; provider_name: string | null;
    label: string | null; provider_url: string | null; is_primary: boolean;
  }>;
  const primarySource = srcs.find((s) => s.is_primary && s.provider_url) ?? srcs.find((s) => s.provider_url);
  const metadataSections: Array<[string, Record<string, unknown>]> = metadata.data ? [
    ["Core", metadata.data.asset],
    ["File system", metadata.data.fileSystem],
    ["Media", metadata.data.media],
    ["EXIF", metadata.data.exif],
    ["GPS", metadata.data.gps],
    ["XMP / IPTC", metadata.data.xmpIptc],
    ["Video", metadata.data.video],
    ["Document", metadata.data.document],
    ["Audio", metadata.data.audio],
    ["Hashes", metadata.data.hashes],
    ["Preview", metadata.data.preview],
    ["AI readiness", metadata.data.aiReady],
    ["Organization", metadata.data.organization],
  ].filter((entry): entry is [string, Record<string, unknown>] => {
    const value = entry[1];
    return !!value && Object.values(value).some((item) => item !== null && item !== "" && !(Array.isArray(item) && item.length === 0));
  }) : [];

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
            <section className="flex flex-wrap gap-2">
              {primarySource?.provider_url && (
                <a href={primarySource.provider_url} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--ink)] px-3 py-1.5 text-xs font-medium text-[color:var(--paper)] hover:bg-[color:var(--umber)]">
                  <ExternalLink className="h-3 w-3" /> Open in {primarySource.provider_name ?? primarySource.provider_kind ?? "source"}
                </a>
              )}
              {hiRes && (
                <a href={hiRes} download target="_blank" rel="noreferrer"
                  title="Saves the preview thumbnail. Open in source for the original."
                  className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border)] px-3 py-1.5 text-xs text-[color:var(--ink)] hover:bg-[color:var(--paper-2)]">
                  <Download className="h-3 w-3" /> Save preview
                </a>
              )}
              {!primarySource?.provider_url && srcs.length > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border)] px-3 py-1.5 text-xs text-[color:var(--umber)] opacity-70">
                  <ExternalLink className="h-3 w-3" /> No direct source link
                </span>
              )}
            </section>
            <section>
              <div className="text-archive-label mb-3">Metadata</div>
              {metadata.isLoading ? (
                <p className="text-sm text-[color:var(--umber)]">Loading full metadata…</p>
              ) : metadataSections.length ? (
                <div className="space-y-4">
                  {metadataSections.map(([title, section]) => (
                    <div key={title} className="hairline rounded-md border bg-[color:var(--paper)]">
                      <div className="border-b border-[color:var(--border)] px-4 py-2 text-xs uppercase tracking-[0.18em] text-[color:var(--umber)]">
                        {title}
                      </div>
                      <dl className="divide-y divide-[color:var(--border)] text-sm">
                        {Object.entries(section as Record<string, unknown>)
                          .filter(([k, v]) => !k.startsWith("_") && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0) && typeof v !== "object")
                          .map(([k, v]) => (
                            <div key={`${title}-${k}`} className="flex justify-between gap-3 px-4 py-2">
                              <dt className="text-[color:var(--umber)]">{humanize(k)}</dt>
                              <dd className="truncate text-right text-[color:var(--ink)]">{String(v)}</dd>
                            </div>
                          ))}
                        {Object.entries(section as Record<string, unknown>)
                          .filter(([k, v]) => !k.startsWith("_") && Array.isArray(v) && v.length > 0)
                          .map(([k, v]) => (
                            <div key={`${title}-${k}-array`} className="flex justify-between gap-3 px-4 py-2">
                              <dt className="text-[color:var(--umber)]">{humanize(k)}</dt>
                              <dd className="text-right text-[color:var(--ink)]">{(v as unknown[]).join(", ")}</dd>
                            </div>
                          ))}
                      </dl>
                    </div>
                  ))}
                </div>
              ) : (
                <dl className="hairline divide-y divide-[color:var(--border)] rounded-md border bg-[color:var(--paper)] text-sm">
                  {a && Object.entries(a)
                    .filter(([k]) => !k.startsWith("_") && typeof a[k] !== "object")
                    .slice(0, 14)
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3 px-4 py-2">
                        <dt className="text-[color:var(--umber)]">{humanize(k)}</dt>
                        <dd className="truncate text-right text-[color:var(--ink)]">{String(v ?? "—")}</dd>
                      </div>
                    ))}
                </dl>
              )}
            </section>
            <section>
              <div className="text-archive-label mb-3 flex items-center gap-1"><Layers className="h-3 w-3" /> Sources</div>
              {sources.isLoading ? (
                <p className="text-sm text-[color:var(--umber)]">Loading…</p>
              ) : srcs.length ? (
                <ul className="flex flex-wrap gap-2">
                  {srcs.map((s) => (
                    <li key={s.id} className="rounded-full border border-[color:var(--border)] bg-[color:var(--paper)] px-3 py-1 text-[11px] uppercase tracking-wider text-[color:var(--umber)]">
                      {s.label ?? s.provider_name ?? s.provider_kind ?? "source"}
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