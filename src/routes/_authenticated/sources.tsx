import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useConnectSource, useDisconnectSource, useImportUploaded, useProviders, useSourceAccounts, useSourceStatus, useSyncSource } from "@/lib/api/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useSourceProgress } from "@/lib/realtime/useSourceProgress";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check, Plug, RefreshCcw, Settings2, Trash2, UploadCloud } from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

const ON_DEVICE_PROVIDER_KINDS = new Set(["local_ios", "local_android", "desktop_folder", "external_drive", "nas"]);
const UNSUPPORTED_PROVIDER_KINDS = new Set(["icloud", "amazon_photos"]);

type Provider = { id: string; kind: string; name: string; priority: string };
type ExplainerState = { provider: Provider; reason: string } | null;
type UploadState = { accountId: string; prefix: string } | null;
type ConsentState = { provider: Provider } | null;
type ManageState = { provider: Provider; accountId: string } | null;
type ConfigMissingState = { provider: Provider; envVars: string[] } | null;

const PROVIDER_SCOPES: Record<string, { label: string; items: string[]; envVars: string[] }> = {
  google_photos: {
    label: "Google Photos",
    items: ["Read-only access to your Photos library", "Metadata, thumbnails, and previews", "We never delete or modify your originals"],
    envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  },
  dropbox: {
    label: "Dropbox",
    items: ["Read your file metadata", "Read file contents for indexing", "Account info (email, name)"],
    envVars: ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET"],
  },
  onedrive: {
    label: "OneDrive",
    items: ["Read files in your OneDrive", "Your basic profile (User.Read)", "Offline access for background sync"],
    envVars: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
  },
  export_import: {
    label: "Export / Import",
    items: ["Files you upload stay in your private bucket", "Indexed locally — originals never leave your storage", "Disconnect any time to delete the bucket folder"],
    envVars: [],
  },
};

export const Route = createFileRoute("/_authenticated/sources")({ component: Sources });

const PROVIDER_EXPLAINERS: Record<string, string> = {
  icloud: "Apple does not provide a public iCloud Photos API. To bring iCloud memories in, export them from iCloud.com or Photos on Mac as a zip and use the Export/Import provider below.",
  amazon_photos: "Amazon Photos has no public API for third-party indexing. Use Amazon's export tool, then upload the zip via Export/Import.",
  local_ios: "iOS Camera Roll requires the PMP iOS app for on-device indexing (PhotoKit). Coming soon \u2014 in the meantime export an album to a zip and upload it.",
  local_android: "Android Gallery requires the PMP Android app (MediaStore). Coming soon \u2014 export to zip and upload as a workaround.",
  desktop_folder: "Desktop folders require the PMP desktop agent. Coming soon \u2014 zip the folder and upload it.",
  external_drive: "External drives require the PMP desktop agent. Coming soon \u2014 zip the contents and upload them.",
  nas: "NAS volumes require the PMP desktop agent (SMB). Coming soon \u2014 export a folder and upload as a zip.",
};

function Sources() {
  useSourceProgress();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const accounts = useSourceAccounts();
  const providers = useProviders();
  const connect = useConnectSource();
  const sync = useSyncSource();
  const disconnect = useDisconnectSource();
  const qc = useQueryClient();
  const popupRef = useRef<Window | null>(null);
  const [explainer, setExplainer] = useState<ExplainerState>(null);
  const [upload, setUpload] = useState<UploadState>(null);
  const [consent, setConsent] = useState<ConsentState>(null);
  const [manage, setManage] = useState<ManageState>(null);
  const [configMissing, setConfigMissing] = useState<ConfigMissingState>(null);

  // If this page is itself the OAuth popup, forward the result to the opener
  // and close the window. Detect by ?oauth_popup=1 + window.opener.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (search?.oauth_popup !== "1") return;
    if (!window.opener || window.opener === window) return;
    try {
      window.opener.postMessage(
        { type: "pmp:oauth", error: search?.error ?? null, detail: search?.detail ?? null },
        window.location.origin,
      );
    } catch { /* ignore */ }
    window.close();
  }, [search?.oauth_popup, search?.error, search?.detail]);

  // Listen for OAuth result postMessage from the popup.
  useEffect(() => {
    function handler(ev: MessageEvent) {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { type?: string; error?: string | null; detail?: string | null } | null;
      if (!data || data.type !== "pmp:oauth") return;
      if (data.error) {
        const detail = data.detail ? `: ${decodeURIComponent(data.detail)}` : "";
        toast.error(`Connection failed (${data.error}${detail})`);
      } else {
        toast.success("Source connected. Indexing started.");
      }
      qc.invalidateQueries({ queryKey: ["source-accounts"] });
      try { popupRef.current?.close(); } catch { /* ignore */ }
      popupRef.current = null;
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [qc]);

  // Surface OAuth callback errors as toasts.
  useEffect(() => {
    if (search?.error) {
      const detail = search.detail ? `: ${decodeURIComponent(search.detail)}` : "";
      toast.error(`Connection failed (${search.error}${detail})`);
    } else if (search?.connected) {
      toast.success("Source connected. Indexing started.");
    }
  }, [search?.error, search?.detail, search?.connected]);

  // Map provider_kind → first connected account so we can show a "Connected" badge
  // and switch the card from a Connect button to a Manage button.
  const connectedByKind = new Map<string, { id: string; status: string; asset_count: number }>();
  for (const a of accounts.data?.accounts ?? []) {
    if (!connectedByKind.has(a.provider_kind)) {
      connectedByKind.set(a.provider_kind, { id: a.id, status: a.status, asset_count: a.asset_count });
    }
  }

  function onProviderClick(providerId: string) {
    const provider = providers.data?.providers?.find((p) => p.id === providerId);
    if (!provider) { toast.error("Source provider unavailable."); return; }

    if (UNSUPPORTED_PROVIDER_KINDS.has(provider.kind) || ON_DEVICE_PROVIDER_KINDS.has(provider.kind)) {
      setExplainer({ provider, reason: PROVIDER_EXPLAINERS[provider.kind] ?? "This provider isn't available yet." });
      return;
    }

    const existing = connectedByKind.get(provider.kind);
    if (existing) {
      setManage({ provider, accountId: existing.id });
      return;
    }
    setConsent({ provider });
  }

  async function startConnect(provider: Provider) {
    setConsent(null);
    // Open the popup synchronously inside the click handler so browsers don't
    // block it. We point it at a blank page and navigate it once we have the
    // authorize URL from the server.
    const w = 560, h = 720;
    const hostWindow = (() => {
      try {
        void window.top?.location?.origin;
        return window.top ?? window;
      } catch {
        return window;
      }
    })();
    const y = hostWindow.outerHeight ? Math.max(0, ((hostWindow.outerHeight - h) / 2) + (hostWindow.screenY ?? 0)) : 100;
    const x = hostWindow.outerWidth ? Math.max(0, ((hostWindow.outerWidth - w) / 2) + (hostWindow.screenX ?? 0)) : 100;
    const popup = window.open("about:blank", "pmp_oauth", `width=${w},height=${h},left=${x},top=${y}`);
    if (!popup) {
      toast.error("Popup was blocked. Allow pop-ups for this site and try again.");
      return;
    }
    popupRef.current = popup;
    try {
      const out = await connect.mutateAsync({
        provider_id: provider.id,
        redirect_uri: `${window.location.origin}/sources?oauth_popup=1`,
      });
      if (out.authorize_url) {
        popup.location.href = out.authorize_url;
        return;
      }
      popup.close();
      popupRef.current = null;
      if (provider.kind === "export_import" && out.upload_target && out.session_token) {
        setUpload({ accountId: out.session_token, prefix: out.upload_target.prefix });
        return;
      }
      // Defensive: server should always return one of the above.
      toast.error(`${provider.name} did not return a connection URL. Please try again.`);
    } catch (e) {
      try { popup.close(); } catch { /* ignore */ }
      popupRef.current = null;
      const msg = (e as Error).message ?? "";
      // Server error when OAuth env keys are missing — show a config dialog
      // with the exact env vars to set instead of a cryptic toast.
      if (/not configured/i.test(msg) && PROVIDER_SCOPES[provider.kind]?.envVars.length) {
        setConfigMissing({ provider, envVars: PROVIDER_SCOPES[provider.kind].envVars });
      } else {
        toast.error(msg || "Connection failed.");
      }
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="hairline-b mb-6 pb-4">
        <span className="text-archive-label">sources</span>
        <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">Where your memories live</h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--umber)]">
          PMP indexes — never stores. We keep a tiny reference and thumbnail; originals stay in the source you trust.
        </p>
      </header>
      <section className="mb-10">
        <div className="text-archive-label mb-3">Connected</div>
        {accounts.isLoading ? (
          <div className="space-y-2">{Array.from({length:2}).map((_,i)=><Skeleton key={i} className="h-20 rounded-md" />)}</div>
        ) : accounts.data?.accounts?.length ? (
          <ul className="space-y-2">
            {accounts.data.accounts.map((a) => (
              <SourceRow key={a.id} a={a} onSync={() => sync.mutate(a.id)} onDisconnect={() => {
                if (confirm("Disconnect this source? Indexed memories will be removed.")) disconnect.mutate(a.id);
              }} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[color:var(--umber)]">No sources connected yet.</p>
        )}
      </section>
      <section>
        <div className="text-archive-label mb-3">Add a source</div>
        {providers.isLoading ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{Array.from({length:6}).map((_,i)=><Skeleton key={i} className="h-20 rounded-md" />)}</div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {providers.data?.providers?.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
              const connected = connectedByKind.get(p.kind);
              return (
                <button key={p.id} onClick={() => onProviderClick(p.id)}
                  className="hairline group flex items-center justify-between gap-3 rounded-md border bg-[color:var(--paper)] p-4 text-left transition-colors hover:bg-[color:var(--paper-2)]">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={`grid h-10 w-10 place-items-center rounded-md ${connected ? "bg-emerald-50 text-emerald-700" : "bg-[color:var(--paper-2)] text-[color:var(--umber)] group-hover:text-[color:var(--ink)]"}`}>
                      {connected ? <Check className="h-4 w-4" strokeWidth={2} /> : <ProviderIcon kind={p.kind} className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium text-[color:var(--ink)]">
                        {p.name}
                        {connected && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700">Connected</span>}
                      </div>
                      {connected && (
                        <div className="truncate text-xs text-[color:var(--umber)]">
                          {connected.asset_count.toLocaleString()} indexed · {connected.status}
                        </div>
                      )}
                    </div>
                  </div>
                  {connected && <Settings2 className="h-4 w-4 shrink-0 text-[color:var(--umber)]" strokeWidth={1.5} />}
                </button>
              );
            })}
          </div>
        )}
      </section>
      <ExplainerDialog state={explainer} onClose={() => setExplainer(null)} />
      <UploadDialog state={upload} onClose={() => setUpload(null)} />
      <ConsentDialog
        state={consent}
        onClose={() => setConsent(null)}
        onConfirm={(p) => startConnect(p)}
        pending={connect.isPending}
      />
      <ManageDialog
        state={manage}
        onClose={() => setManage(null)}
        onSync={(id) => { sync.mutate(id); setManage(null); }}
        onDisconnect={(id) => {
          if (confirm("Disconnect this source? Indexed memories will be removed.")) {
            disconnect.mutate(id);
            setManage(null);
          }
        }}
        onReconnect={(p) => { setManage(null); setConsent({ provider: p }); }}
      />
      <ConfigMissingDialog state={configMissing} onClose={() => setConfigMissing(null)} />
    </div>
  );
}

function ConsentDialog({ state, onClose, onConfirm, pending }: {
  state: ConsentState; onClose: () => void; onConfirm: (p: Provider) => void; pending: boolean;
}) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { if (!state) setAccepted(false); }, [state]);
  const meta = state ? PROVIDER_SCOPES[state.provider.kind] : null;
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {state?.provider.name}</DialogTitle>
          <DialogDescription>
            You'll be redirected to {state?.provider.name} to approve access. PMP only indexes — your originals stay where they are.
          </DialogDescription>
        </DialogHeader>
        {meta && (
          <ul className="my-2 space-y-1.5 text-sm text-[color:var(--ink)]">
            {meta.items.map((it) => (
              <li key={it} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" strokeWidth={2} /><span>{it}</span></li>
            ))}
          </ul>
        )}
        <label className="flex items-start gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] p-3 text-xs text-[color:var(--umber)]">
          <input type="checkbox" className="mt-0.5" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>
            I agree to the <a href="/terms" className="underline">Terms of Use</a> and{" "}
            <a href="/privacy" className="underline">Privacy Policy</a>, and authorize PMP to index this source on my behalf.
          </span>
        </label>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button disabled={!accepted || pending} onClick={() => state && onConfirm(state.provider)}>
            {pending ? "Connecting…" : `Continue to ${state?.provider.name}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManageDialog({ state, onClose, onSync, onDisconnect, onReconnect }: {
  state: ManageState; onClose: () => void;
  onSync: (id: string) => void; onDisconnect: (id: string) => void; onReconnect: (p: Provider) => void;
}) {
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.provider.name}</DialogTitle>
          <DialogDescription>
            This source is connected. You can re-sync, re-authenticate, or disconnect it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button variant="outline" onClick={() => state && onSync(state.accountId)}>
            <RefreshCcw className="mr-2 h-4 w-4" /> Sync now
          </Button>
          <Button variant="outline" onClick={() => state && onReconnect(state.provider)}>
            <Plug className="mr-2 h-4 w-4" /> Re-authenticate
          </Button>
          <Button variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10" onClick={() => state && onDisconnect(state.accountId)}>
            <Trash2 className="mr-2 h-4 w-4" /> Disconnect
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfigMissingDialog({ state, onClose }: { state: ConfigMissingState; onClose: () => void }) {
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.provider.name} isn't configured yet</DialogTitle>
          <DialogDescription>
            OAuth credentials for {state?.provider.name} haven't been added. An admin needs to set the following secrets in Lovable Cloud → Edge Function secrets:
          </DialogDescription>
        </DialogHeader>
        <ul className="my-2 space-y-1 rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] p-3 font-mono text-xs">
          {state?.envVars.map((v) => <li key={v}>{v}</li>)}
        </ul>
        <p className="text-xs text-[color:var(--umber)]">
          Also register the redirect URI{" "}
          <code className="break-all">{`${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/sources/callback`}</code>{" "}
          <span className="mx-1">(legacy <code>{`${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/sources/v1/callback`}</code> also works)</span>
          in the provider's developer console.
        </p>
        <DialogFooter>
          <Button onClick={onClose}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExplainerDialog({ state, onClose }: { state: ExplainerState; onClose: () => void }) {
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.provider.name}</DialogTitle>
          <DialogDescription>{state?.reason}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadDialog({ state, onClose }: { state: UploadState; onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const importUploaded = useImportUploaded();

  async function onFiles(files: FileList | null) {
    if (!files || !state) return;
    setBusy(true);
    setProgress({ done: 0, total: files.length });
    let failed = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const safeName = f.name.replace(/[^\w.\-]+/g, "_");
        const path = `${state.prefix}/${Date.now()}_${i}_${safeName}`;
        const { error } = await supabase.storage.from("source_uploads").upload(path, f, {
          upsert: false, contentType: f.type || "application/octet-stream",
        });
        if (error) { failed++; toast.error(`Upload failed: ${f.name} \u2014 ${error.message}`); }
        setProgress({ done: i + 1, total: files.length });
      }
      const res = await importUploaded.mutateAsync(state.accountId);
      toast.success(`Queued ${res.queued_files} file(s) for indexing.${failed ? ` ${failed} failed to upload.` : ""}`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false); setProgress(null);
    }
  }

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload photos & videos</DialogTitle>
          <DialogDescription>
            Drop a zip export or pick files directly. They upload to your private storage, then PMP indexes them \u2014 originals stay yours.
          </DialogDescription>
        </DialogHeader>
        <div className="hairline rounded-md border border-dashed bg-[color:var(--paper-2)] p-8 text-center">
          <UploadCloud className="mx-auto mb-2 h-6 w-6 text-[color:var(--umber)]" strokeWidth={1.5} />
          <p className="text-sm text-[color:var(--umber)]">Images, videos, or a single .zip export.</p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,video/*,.zip"
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
          <Button className="mt-4" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? `Uploading ${progress?.done ?? 0}/${progress?.total ?? 0}\u2026` : "Choose files"}
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SourceRow({ a, onSync, onDisconnect }: {
  a: { id: string; provider_kind: string; status: string; display_label: string | null; asset_count: number; last_sync_at: string | null };
  onSync: () => void; onDisconnect: () => void;
}) {
  const status = useSourceStatus(a.id);
  const s = status.data;
  const pct = s ? Math.min(100, Math.round((s.progress.indexed / Math.max(1, s.progress.discovered)) * 100)) : null;
  const running = s?.last_job?.status === "running" || s?.status === "syncing";
  return (
    <li className="hairline rounded-md border bg-[color:var(--paper)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-[color:var(--ink)]">{a.display_label ?? a.provider_kind}</div>
          <div className="text-xs text-[color:var(--umber)]">
            {a.asset_count.toLocaleString()} indexed · <span className={running ? "text-emerald-700" : ""}>{a.status}</span>
            {a.last_sync_at && ` · synced ${new Date(a.last_sync_at).toLocaleString()}`}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onSync} className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border)] px-3 py-1.5 text-xs hover:bg-[color:var(--paper-2)]">
            <RefreshCcw className="h-3 w-3" /> Sync
          </button>
          <button onClick={onDisconnect}
            className="inline-flex items-center gap-1 rounded-full border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10">
            <Trash2 className="h-3 w-3" /> Disconnect
          </button>
        </div>
      </div>
      {(running || (pct !== null && pct < 100)) && pct !== null && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-[color:var(--paper-2)]">
            <div className="h-full bg-[color:var(--ink)] transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-[color:var(--umber)]">
            <span>{s?.last_job?.kind ?? "syncing"}</span>
            <span>{s?.progress.indexed.toLocaleString()} / {s?.progress.discovered.toLocaleString()} ({pct}%)</span>
          </div>
        </div>
      )}
      {s?.last_error && <p className="mt-2 text-xs text-destructive">{s.last_error}</p>}
    </li>
  );
}