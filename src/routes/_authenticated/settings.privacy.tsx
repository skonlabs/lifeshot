import { createFileRoute } from "@tanstack/react-router";
import { useGrantConsent, usePrivacySettings, useUpdatePrivacy } from "@/lib/api/hooks";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/privacy")({ component: Privacy });

function Privacy() {
  const { data, isLoading } = usePrivacySettings();
  const update = useUpdatePrivacy();
  const consent = useGrantConsent();
  const s = data as { ai_enabled?: boolean; face_processing_enabled?: boolean; default_visibility?: "private" | "family" | "public" } | undefined;
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <h1 className="font-display text-2xl">Privacy</h1>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-3">
          <Toggle
            label="AI processing"
            description="Enables natural-language search, captions, and summaries."
            value={!!s?.ai_enabled}
            onChange={(v) => { update.mutate({ ai_enabled: v }); consent.mutate({ scope: "ai_processing", granted: v }); }}
          />
          <Toggle
            label="Face recognition"
            description="Groups faces into people. Off by default."
            value={!!s?.face_processing_enabled}
            onChange={(v) => { update.mutate({ face_processing_enabled: v }); consent.mutate({ scope: "face_recognition", granted: v }); }}
          />
          <Select
            label="Default visibility"
            value={s?.default_visibility ?? "private"}
            onChange={(v) => { update.mutate({ default_visibility: v }); toast.success("Saved"); }}
            options={["private", "family", "public"]}
          />
        </div>
      )}
    </div>
  );
}

function Toggle({ label, description, value, onChange }: { label: string; description: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start justify-between gap-4 rounded-lg border p-4">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-5 w-5" />
    </label>
  );
}

function Select<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: T[] }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border p-4">
      <span className="font-medium">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="rounded-md border bg-background px-3 py-1.5 text-sm">
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}