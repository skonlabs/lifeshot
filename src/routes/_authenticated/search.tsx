import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useSearch } from "@/lib/api/hooks";
import { AssetCell } from "@/components/app/AssetCell";
import { Search as SearchIcon, Sparkles, X } from "lucide-react";

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
  const facets = (result.data?.facets ?? {}) as FacetMap;
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
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs text-primary"
            >
              {k}: {v}
              <X className="h-3 w-3" />
            </button>
          ))}
          <button onClick={() => setFilters({})} className="text-xs text-muted-foreground hover:text-foreground">Clear all</button>
        </div>
      )}
      {!submitted ? (
        <p className="text-sm text-muted-foreground">Ask anything about your memories.</p>
      ) : result.isLoading ? (
        <p className="text-sm text-muted-foreground">Searching…</p>
      ) : result.error ? (
        <p className="text-sm text-destructive">Search failed.</p>
      ) : (
        <div className="grid grid-cols-[1fr_240px] gap-6">
          <div>
            {result.data?.results?.length ? (
              <div className="grid grid-cols-4 gap-2">
                {result.data.results.map((r) => (
                  <div key={r.asset_id} className="aspect-square">
                    <AssetCell d={r} style={{ width: "100%", height: "100%" }} />
                  </div>
                ))}
              </div>
            ) : (
              <div>
                <p className="text-sm text-muted-foreground">No results.</p>
                {result.data?.zero_result_suggestions?.length ? (
                  <ul className="mt-3 space-y-1 text-sm">
                    {result.data.zero_result_suggestions.map((s, i) => (
                      <li key={i}>
                        <button onClick={() => { setQuery(s); setSubmitted(s); }} className="text-primary hover:underline">
                          Try: {s}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </div>
          <aside className="space-y-4 text-sm">
            {Object.keys(facets).length > 0 && (
              <section className="rounded-lg border p-3">
                <h2 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Refine</h2>
                <div className="space-y-3">
                  {Object.entries(facets).map(([key, values]) => (
                    <div key={key}>
                      <div className="mb-1 text-xs font-medium capitalize text-muted-foreground">{key}</div>
                      <div className="flex flex-wrap gap-1">
                        {values.slice(0, 8).map((f) => {
                          const active = filters[key]?.includes(f.value);
                          return (
                            <button
                              key={f.value}
                              onClick={() => toggleFilter(key, f.value)}
                              className={
                                "rounded-full border px-2 py-0.5 text-xs transition-colors " +
                                (active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent")
                              }
                            >
                              {f.label ?? f.value} <span className="opacity-60">· {f.count}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {result.data?.parsed && import.meta.env.DEV && (
              <section className="rounded-lg border p-3">
                <h2 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Why these</h2>
                <pre className="overflow-auto text-xs">{JSON.stringify(result.data.parsed, null, 2)}</pre>
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}