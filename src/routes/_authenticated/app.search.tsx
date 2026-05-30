import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { searchMemories } from "@/lib/api/search.functions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/app/search")({
  head: () => ({ meta: [{ title: "Search — LifeShot" }] }),
  component: Search,
});

function Search() {
  const [q, setQ] = useState("");
  const m = useMutation({ mutationFn: (query: string) => searchMemories({ data: { q: query } }) });
  const submit = (e: FormEvent) => { e.preventDefault(); if (q.trim()) m.mutate(q.trim()); };
  return (
    <div>
      <h1 className="font-display text-4xl text-ink">Search your life</h1>
      <p className="mt-2 text-foreground/70">Try: <em>"Thailand 2019"</em>, <em>"birthday with mom"</em>, <em>"passport scan"</em>.</p>
      <form onSubmit={submit} className="mt-6 flex gap-2 max-w-2xl">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="What are you looking for?" className="h-12 rounded-full" />
        <Button type="submit" className="h-12 rounded-full bg-ink text-paper hover:bg-ink/90 px-6">Search</Button>
      </form>
      {m.data && (
        <div className="mt-8 text-foreground/70">
          <div className="text-sm">Found {m.data.results.length} results in {m.data.took_ms}ms.</div>
          {m.data.results.length === 0 && <p className="mt-4">No results yet — connect a source first.</p>}
        </div>
      )}
    </div>
  );
}