import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCreateFamily, useFamilies, useFamilyDetail, useInviteToFamily, usePatchFamilyMember } from "@/lib/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { UserPlus, Users } from "lucide-react";

export const Route = createFileRoute("/_authenticated/family")({ component: Family });

function Family() {
  const families = useFamilies();
  const create = useCreateFamily();
  const invite = useInviteToFamily();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [familyId, setFamilyId] = useState("");
  const list = families.data?.families ?? [];

  useEffect(() => {
    if (!familyId && list[0]) setFamilyId(list[0].id);
  }, [familyId, list]);

  const detail = useFamilyDetail(familyId || undefined);
  const patch = usePatchFamilyMember();

  return (
    <div className="mx-auto max-w-4xl space-y-10 px-6 py-8">
      <header className="hairline-b pb-4">
        <span className="text-archive-label">family</span>
        <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">Memories, shared with the people who lived them</h1>
      </header>
      <section>
        <div className="text-archive-label mb-3">Your families</div>
        {families.isLoading ? (
          <Skeleton className="h-20 rounded-md" />
        ) : list.length ? (
          <ul className="hairline divide-y divide-[color:var(--border)] rounded-md border bg-[color:var(--paper)]">
            {list.map((f) => (
              <li key={f.id}
                onClick={() => setFamilyId(f.id)}
                className={"flex cursor-pointer items-center justify-between px-4 py-3 transition-colors " + (familyId === f.id ? "bg-[color:var(--paper-2)]" : "hover:bg-[color:var(--paper-2)]/60")}>
                <span className="flex items-center gap-2 font-medium text-[color:var(--ink)]"><Users className="h-3.5 w-3.5 text-[color:var(--umber)]" /> {f.name}</span>
                <span className="text-[11px] uppercase tracking-wider text-[color:var(--umber)]">{f.role}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[color:var(--umber)]">You don't belong to a family yet.</p>
        )}
      </section>

      {familyId && detail.data?.members && (
        <section>
          <div className="text-archive-label mb-3">Members of {detail.data.family.name}</div>
          <ul className="hairline divide-y divide-[color:var(--border)] rounded-md border bg-[color:var(--paper)]">
            {detail.data.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="font-medium text-[color:var(--ink)]">{m.display_name ?? m.user_id.slice(0,8)}</div>
                  <div className="text-[11px] uppercase tracking-wider text-[color:var(--umber)]">{m.role} · {m.status}</div>
                </div>
                <div className="flex gap-2">
                  <select defaultValue={m.role}
                    onChange={(e) => patch.mutate({ familyId, memberId: m.id, body: { role: e.target.value } }, {
                      onSuccess: () => toast.success("Role updated"),
                      onError: (err) => toast.error((err as Error).message),
                    })}
                    className="rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-2 py-1 text-xs">
                    {["owner","admin","member","child","guest"].map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  {m.status === "active" ? (
                    <button onClick={() => patch.mutate({ familyId, memberId: m.id, body: { status: "removed" } }, { onSuccess: () => toast.success("Removed") })}
                      className="rounded-full border border-destructive/40 px-2 py-1 text-[11px] text-destructive hover:bg-destructive/10">Remove</button>
                  ) : (
                    <button onClick={() => patch.mutate({ familyId, memberId: m.id, body: { status: "active" } }, { onSuccess: () => toast.success("Reactivated") })}
                      className="rounded-full border border-[color:var(--border)] px-2 py-1 text-[11px] hover:bg-[color:var(--paper-2)]">Reactivate</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="hairline rounded-md border bg-[color:var(--paper)] p-4">
        <div className="text-archive-label mb-2">Create a family</div>
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
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Hendersons" required
            className="flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-2 text-sm" />
          <button type="submit" className="rounded-full bg-[color:var(--ink)] px-4 py-2 text-sm font-medium text-[color:var(--paper)]">Create</button>
        </form>
      </section>
      <section className="hairline rounded-md border bg-[color:var(--paper)] p-4">
        <div className="text-archive-label mb-2 flex items-center gap-1"><UserPlus className="h-3 w-3" /> Invite someone</div>
        {list.length === 0 ? (
          <p className="text-sm text-[color:var(--umber)]">Create a family first.</p>
        ) : (
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
          <select value={familyId} onChange={(e) => setFamilyId(e.target.value)} required
            className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-2 text-sm">
            {list.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.com" required
              className="flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-2 text-sm" />
            <button type="submit" className="rounded-full bg-[color:var(--ink)] px-4 py-2 text-sm font-medium text-[color:var(--paper)]">Invite</button>
          </div>
        </form>
        )}
      </section>
    </div>
  );
}