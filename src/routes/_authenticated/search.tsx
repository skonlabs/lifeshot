import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useSearch } from "@/lib/api/hooks";
import { AssetCell } from "@/components/app/AssetCell";
import { Search as SearchIcon } from "lucide-react";

export const Route = createFileRoute("/_authenticated/search")({ component: SearchPage });

function SearchPage() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const result = useSearch(submitted ? { query: submitted, k: 50, mode: "hybrid" } : null);
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="mb-4 font-display text-2xl">Search</h1>
      <form onSubmit={(e) => { e.preventDefault(); setSubmitted(query.trim() || null); }} className="relative mb-6">
        <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Try: photos of the kids at the beach last summer"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border bg-background py-3 pl-10 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </form>
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
            {result.data?.facets && Object.keys(result.data.facets).length > 0 && (
              <section className="rounded-lg border p-3">
                <h2 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Facets</h2>
                <pre className="overflow-auto text-xs">{JSON.stringify(result.data.facets, null, 2)}</pre>
              </section>
            )}
            {result.data?.parsed && (
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