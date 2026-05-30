import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useCorrection, usePerson } from "@/lib/api/hooks";

export const Route = createFileRoute("/_authenticated/people/$id")({ component: Person });

function Person() {
  const { id } = Route.useParams();
  const { data, isLoading } = usePerson(id);
  const correct = useCorrection();
  const p = data as { display_name?: string | null; asset_count?: number } | undefined;
  const [name, setName] = useState("");
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <h1 className="mb-1 font-display text-2xl">{p?.display_name ?? "Unknown"}</h1>
          <p className="mb-6 text-sm text-muted-foreground">{p?.asset_count ?? 0} memories</p>
          <section className="rounded-lg border p-4">
            <h2 className="mb-2 text-sm font-semibold">Rename</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const display_name = name.trim();
                if (!display_name) return;
                correct.mutate(
                  { target_type: "person", target_id: id, correction: { display_name } },
                  {
                    onSuccess: () => { toast.success("Renamed"); setName(""); },
                    onError: (err) => toast.error((err as Error).message),
                  },
                );
              }}
              className="flex gap-2"
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={p?.display_name ?? "New name"}
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              />
              <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Save</button>
            </form>
          </section>
        </>
      )}
    </div>
  );
}