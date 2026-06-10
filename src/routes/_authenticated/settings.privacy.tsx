import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { usePrivacySettings, useUpdatePrivacy, useResetFacePipeline } from "@/lib/api/hooks";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/privacy")({ component: Privacy });

function Privacy() {
  const { data, isLoading } = usePrivacySettings();
  const update = useUpdatePrivacy();
  const reset = useResetFacePipeline();
  const [confirming, setConfirming] = useState(false);
  const s = data as { ai_enabled?: boolean; face_processing_enabled?: boolean; default_visibility?: "private" | "family" | "public" } | undefined;

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-10">
      <header className="hairline-b pb-4">
        <span className="text-archive-label">settings · privacy</span>
        <h1 className="mt-1 font-serif-display text-3xl text-[color:var(--ink)]">Privacy controls</h1>
        <p className="mt-2 text-sm text-[color:var(--umber)]">Everything is off by default. Turn on only what you want us to do with your memories.</p>
      </header>
      {isLoading ? (
        <p className="text-sm text-[color:var(--umber)]">Loading…</p>
      ) : (
        <div className="space-y-3">
          <Toggle
            label="AI processing"
            description="Enables natural-language search, captions, and summaries."
            value={!!s?.ai_enabled}
            onChange={(v) => update.mutate({ ai_enabled: v }, {
              onSuccess: () => toast.success(v ? "AI enabled" : "AI disabled"),
              onError: (e) => toast.error((e as Error).message),
            })}
          />
          <Toggle
            label="Face recognition"
            description="Groups faces into people. Off by default."
            value={!!s?.face_processing_enabled}
            onChange={(v) => update.mutate({ face_processing_enabled: v }, {
              onSuccess: () => toast.success(v ? "Face recognition on" : "Face recognition off"),
              onError: (e) => toast.error((e as Error).message),
            })}
          />
          <Select
            label="Default visibility"
            value={s?.default_visibility ?? "private"}
            onChange={(v) => { update.mutate({ default_visibility: v }); toast.success("Saved"); }}
            options={["private", "family", "public"]}
          />
          <div className="hairline mt-6 rounded-md border border-[color:var(--border)] bg-[color:var(--paper)] p-4">
            <div className="font-medium text-[color:var(--ink)]">Reset face pipeline</div>
            <div className="mt-1 text-xs text-[color:var(--umber)]">
              Deletes all detected people, face groupings, and the AWS Rekognition collection. Faces will be re-detected on the next sync.
            </div>
            {confirming ? (
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={() => reset.mutate(undefined, {
                    onSuccess: () => { toast.success("Face pipeline reset"); setConfirming(false); },
                    onError: (e) => toast.error((e as Error).message),
                  })}
                  disabled={reset.isPending}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {reset.isPending ? "Resetting…" : "Yes, reset everything"}
                </button>
                <button onClick={() => setConfirming(false)} className="text-sm text-[color:var(--umber)] underline">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="mt-3 rounded-md border border-red-600 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                Reset face pipeline
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ label, description, value, onChange }: { label: string; description: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="hairline flex items-start justify-between gap-4 rounded-md border bg-[color:var(--paper)] p-4">
      <div>
        <div className="font-medium text-[color:var(--ink)]">{label}</div>
        <div className="text-xs text-[color:var(--umber)]">{description}</div>
      </div>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-5 w-5 accent-[color:var(--ink)]" />
    </label>
  );
}

function Select<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: T[] }) {
  return (
    <label className="hairline flex items-center justify-between gap-4 rounded-md border bg-[color:var(--paper)] p-4">
      <span className="font-medium text-[color:var(--ink)]">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-1.5 text-sm">
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}