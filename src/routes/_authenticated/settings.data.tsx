import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useDeleteAccount, useExportData } from "@/lib/api/hooks";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/data")({ component: Data });

function Data() {
  const navigate = useNavigate();
  const exportData = useExportData();
  const deleteAccount = useDeleteAccount();
  const [confirmText, setConfirmText] = useState("");
  return (
    <div className="mx-auto max-w-2xl space-y-10 px-6 py-10">
      <header className="hairline-b pb-4">
        <span className="text-archive-label">settings · data</span>
        <h1 className="mt-1 font-serif-display text-3xl text-[color:var(--ink)]">Your data, your archive</h1>
        <p className="mt-2 text-sm text-[color:var(--umber)]">We never copy your originals. Everything below acts only on the metadata, thumbnails, and AI artifacts we generated.</p>
      </header>
      <section className="hairline rounded-md border bg-[color:var(--paper)] p-6">
        <div className="text-archive-label mb-1">Export</div>
        <h2 className="font-serif-display text-xl text-[color:var(--ink)]">Take everything with you</h2>
        <p className="mt-1 text-sm text-[color:var(--umber)]">A bundle of your indexed metadata, thumbnails, and derived data. We'll email you when it's ready.</p>
        <button
          onClick={() => exportData.mutate(undefined, {
            onSuccess: () => toast.success("Export started"),
            onError: (e) => toast.error((e as Error).message),
          })}
          className="mt-4 rounded-full bg-[color:var(--ink)] px-4 py-2 text-sm font-medium text-[color:var(--paper)]"
        >Start export</button>
      </section>
      <section className="rounded-md border border-destructive/40 bg-destructive/[0.03] p-6">
        <div className="text-archive-label mb-1 text-destructive/80">Danger zone</div>
        <h2 className="font-serif-display text-xl text-destructive">Delete account</h2>
        <p className="mt-1 text-sm text-[color:var(--umber)]">
          Removes your index, derived AI artifacts, and account. Your originals in connected sources remain untouched.
          Type <strong>delete my account</strong> to confirm.
        </p>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="mt-3 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-2 text-sm" placeholder="delete my account" />
        <button
          disabled={confirmText !== "delete my account"}
          onClick={() => deleteAccount.mutate(undefined, {
            onSuccess: () => { toast.success("Account deleted"); navigate({ to: "/sign-in" }); },
            onError: (e) => toast.error((e as Error).message),
          })}
          className="mt-3 rounded-full bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-40"
        >Permanently delete</button>
      </section>
    </div>
  );
}