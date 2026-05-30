import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useCreateFamily, useFamilies, useInviteToFamily } from "@/lib/api/hooks";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/family")({ component: Family });

function Family() {
  const families = useFamilies();
  const create = useCreateFamily();
  const invite = useInviteToFamily();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [familyId, setFamilyId] = useState("");
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <h1 className="font-display text-2xl">Family</h1>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Your families</h2>
        {families.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : families.data?.families?.length ? (
          <ul className="divide-y rounded-lg border">
            {families.data.families.map((f) => (
              <li key={f.id} className="flex items-center justify-between px-4 py-3">
                <span className="font-medium">{f.name}</span>
                <span className="text-xs text-muted-foreground">{f.role}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">You don't belong to a family yet.</p>
        )}
      </section>
      <section className="rounded-lg border p-4">
        <h2 className="mb-3 text-sm font-semibold">Create a family</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name }, {
              onSuccess: () => { toast.success("Created"); setName(""); },
              onError: (err) => toast.error((err as Error).message),
            });
          }}
          className="flex gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Family name" required className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" />
          <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Create</button>
        </form>
      </section>
      <section className="rounded-lg border p-4">
        <h2 className="mb-3 text-sm font-semibold">Invite someone</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate({ family_id: familyId, email }, {
              onSuccess: () => { toast.success("Invite sent"); setEmail(""); },
              onError: (err) => toast.error((err as Error).message),
            });
          }}
          className="space-y-2"
        >
          <input value={familyId} onChange={(e) => setFamilyId(e.target.value)} placeholder="Family ID" required className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" required className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" />
            <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Invite</button>
          </div>
        </form>
      </section>
    </div>
  );
}