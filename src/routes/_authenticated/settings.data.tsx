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
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-8">
      <h1 className="font-display text-2xl">Your data</h1>
      <section className="rounded-lg border p-5">
        <h2 className="font-medium">Export everything</h2>
        <p className="mt-1 text-sm text-muted-foreground">We'll prepare a download with your indexed metadata, thumbnails, and AI-derived data.</p>
        <button
          onClick={() => exportData.mutate(undefined, {
            onSuccess: () => toast.success("Export started. We'll email you when it's ready."),
            onError: (e) => toast.error((e as Error).message),
          })}
          className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >Start export</button>
      </section>
      <section className="rounded-lg border border-destructive/40 p-5">
        <h2 className="font-medium text-destructive">Delete account</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Removes your indexed memories, derived AI artifacts, and account. Originals in your sources are untouched.
          Type <strong>delete my account</strong> to confirm.
        </p>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="mt-3 w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="delete my account" />
        <button
          disabled={confirmText !== "delete my account"}
          onClick={() => deleteAccount.mutate(undefined, {
            onSuccess: () => { toast.success("Account deleted"); navigate({ to: "/sign-in" }); },
            onError: (e) => toast.error((e as Error).message),
          })}
          className="mt-3 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-40"
        >Permanently delete</button>
      </section>
    </div>
  );
}