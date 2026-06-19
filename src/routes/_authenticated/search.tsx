import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useSearch } from "@/lib/api/hooks";
import { AssetCell } from "@/components/app/AssetCell";
import { Search as SearchIcon, Sparkles, X, SlidersHorizontal, ImageOff } from "lucide-react";

export const Route = createFileRoute("/_authenticated/search")({
  validateSearch: (s: Record<string, unknown>): { q?: string } =>
    ({ q: typeof s.q === "string" ? s.q : "" }),
  component: SearchPage,
});

const SUGGESTED = [
  "summer at the beach",
  "mom and dad together",
  "screenshots from 2019",
  "handwritten notes",
  "videos with the kids",
];

type FacetMap = Record<string, Array<{ value: string; label?: string; count: number }>>;

function SearchPage() {
  const initial = Route.useSearch().q;
  const [query, setQuery] = useState(initial ?? "");
  const [submitted, setSubmitted] = useState<string | null>(initial?.trim() || null);
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (initial && initial !== submitted) { setQuery(initial); setSubmitted(initial); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const searchInput = useMemo(
    () => (submitted ? { query: submitted, k: 50, mode: "hybrid" as const, filters } : null),
    [submitted, filters],
  );
  const result = useSearch(searchInput);
  // Server may return facets as either Record<string, Array<{value,count}>>
  // or Record<string, Record<value, count>>. Normalise to the array form so
  // .slice/.map are always safe.
  const rawFacets = (result.data?.facets ?? {}) as Record<string, unknown>;
  const facets: FacetMap = Object.fromEntries(
    Object.entries(rawFacets).map(([k, v]) => {
      if (Array.isArray(v)) return [k, v as FacetMap[string]];
      if (v && typeof v === "object") {
        return [k, Object.entries(v as Record<string, unknown>).map(([value, count]) => ({
          value,
          count: typeof count === "number" ? count : Number(count) || 0,
        }))];
      }
      return [k, []];
    }),
  );
  const activeFilters = Object.entries(filters).flatMap(([k, vs]) => vs.map((v) => ({ k, v })));

  function toggleFilter(key: string, value: string) {
    setFilters((prev) => {
      const cur = prev[key] ?? [];
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      const out = { ...prev, [key]: next };
      if (next.length === 0) delete out[key];
      return out;
    });
  }

  const totalResults = result.data?.results?.length ?? 0;
  const prettyKey = (k: string) =>
    k.replace(/^by[_\s-]?/i, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const prettyValue = (v: string) => {
    if (!v || v === "none" || v === "unknown") return "Unspecified";
    return v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="hairline-b mb-6 pb-4">
        <span className="text-archive-label">recall</span>
        <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">Ask your archive anything.</h1>
        <p className="mt-1 text-sm text-[color:var(--umber)]">Hybrid search across faces, places, captions, transcripts, and metadata.</p>
      </header>
      <form onSubmit={(e) => { e.preventDefault(); setSubmitted(query.trim() || null); }} className="relative mb-4">
        <SearchIcon className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--umber)]" />
        <input
          type="text"
          autoFocus
          placeholder="e.g. photos of the kids at the beach last summer"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-full border border-[color:var(--border)] bg-[color:var(--paper)] py-3.5 pl-11 pr-28 text-[15px] shadow-sm focus:border-[color:var(--umber)] focus:outline-none"
        />
        <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-[color:var(--ink)] px-4 py-1.5 text-xs font-medium text-[color:var(--paper)] hover:bg-[color:var(--umber)]">
          Recall
        </button>
      </form>
      {!submitted && (
        <div className="mb-6 flex flex-wrap gap-2">
          <span className="text-archive-label mr-1 self-center">try</span>
          {SUGGESTED.map((s) => (
            <button key={s} onClick={() => { setQuery(s); setSubmitted(s); }}
              className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border)] bg-[color:var(--paper)] px-3 py-1 text-xs text-[color:var(--umber)] hover:border-[color:var(--umber)] hover:text-[color:var(--ink)]">
              <Sparkles className="h-3 w-3" /> {s}
            </button>
          ))}
        </div>
      )}
      {activeFilters.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {activeFilters.map(({ k, v }) => (
            <button
              key={`${k}:${v}`}
              onClick={() => toggleFilter(k, v)}
              className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border)] bg-[color:var(--paper)] px-3 py-1 text-xs text-[color:var(--ink)] hover:border-[color:var(--umber)]"
            >
              <span className="text-[color:var(--umber)]">{prettyKey(k)}:</span> {prettyValue(v)}
              <X className="h-3 w-3" />
            </button>
          ))}
          <button onClick={() => setFilters({})} className="self-center text-xs text-[color:var(--umber)] underline-offset-2 hover:text-[color:var(--ink)] hover:underline">Clear all</button>
        </div>
      )}
      {!submitted ? (
        <p className="text-sm text-[color:var(--umber)]">Ask anything about your memories.</p>
      ) : result.isLoading ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-md bg-[color:var(--border)]/40" />
          ))}
        </div>
      ) : result.error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">Search failed. Please try again.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_260px]">
          <div>
            {totalResults > 0 && (
              <div className="mb-3 flex items-baseline justify-between">
                <p className="text-sm text-[color:var(--umber)]">
                  <span className="font-medium text-[color:var(--ink)]">{totalResults}</span> result{totalResults === 1 ? "" : "s"} for <span className="italic">"{submitted}"</span>
                </p>
              </div>
            )}
            {result.data?.results?.length ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {result.data.results.map((r) => (
                  <div key={r.asset_id} className="aspect-square overflow-hidden rounded-md border border-[color:var(--border)] bg-[color:var(--paper)] transition-transform hover:-translate-y-0.5 hover:shadow-md">
                    <AssetCell d={r} style={{ width: "100%", height: "100%" }} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-[color:var(--border)] bg-[color:var(--paper)] p-8 text-center">
                <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-[color:var(--border)]/30 text-[color:var(--umber)]">
                  <ImageOff className="h-5 w-5" />
                </div>
                <h3 className="font-serif-display text-xl text-[color:var(--ink)]">No matches found</h3>
                <p className="mt-1 text-sm text-[color:var(--umber)]">We couldn't find anything for "{submitted}".</p>
                {result.data?.zero_result_suggestions?.length ? (
                  <div className="mt-5">
                    <p className="text-archive-label mb-2">Try instead</p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {result.data.zero_result_suggestions.map((s, i) => (
                        <button
                          key={i}
                          onClick={() => { setQuery(s); setSubmitted(s); }}
                          className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border)] bg-[color:var(--paper)] px-3 py-1 text-xs text-[color:var(--ink)] hover:border-[color:var(--umber)]"
                        >
                          <Sparkles className="h-3 w-3 text-[color:var(--umber)]" /> {s}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <aside className="space-y-4 text-sm md:sticky md:top-6 md:self-start">
            {Object.keys(facets).length > 0 && (
              <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--paper)] p-4">
                <h2 className="mb-3 flex items-center gap-1.5 text-xs uppercase tracking-wide text-[color:var(--umber)]">
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Refine
                </h2>
                <div className="space-y-4">
                  {Object.entries(facets)
                    .filter(([, values]) => values && values.length > 0)
                    .map(([key, values]) => (
                    <div key={key}>
                      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--umber)]">{prettyKey(key)}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {values.slice(0, 8).map((f) => {
                          const active = filters[key]?.includes(f.value);
                          return (
                            <button
                              key={f.value}
                              onClick={() => toggleFilter(key, f.value)}
                              className={
                                "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                                (active
                                  ? "border-[color:var(--ink)] bg-[color:var(--ink)] text-[color:var(--paper)]"
                                  : "border-[color:var(--border)] bg-[color:var(--paper)] text-[color:var(--ink)] hover:border-[color:var(--umber)]")
                              }
                            >
                              {prettyValue(f.label ?? f.value)} <span className="opacity-60">· {f.count}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {result.data?.parsed && import.meta.env.DEV && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug") && (
              <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--paper)] p-3">
                <h2 className="mb-2 text-xs uppercase tracking-wide text-[color:var(--umber)]">Why these</h2>
                <pre className="overflow-auto text-[11px] text-[color:var(--umber)]">{JSON.stringify(result.data.parsed, null, 2)}</pre>
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}