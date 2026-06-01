import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useConnectSource, useDisconnectSource, useImportUploaded, useProviders, useSourceAccounts, useSourceContainerChildren, useSourceContainers, useSourceStatus, useSyncSource, useUpdateSourceContainers } from "@/lib/api/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useSourceProgress } from "@/lib/realtime/useSourceProgress";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Check, ChevronRight, Folder, FolderOpen, Plug, RefreshCcw, Settings2, Trash2, UploadCloud } from "lucide-react";
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
type DisconnectState = { accountId: string; providerName: string } | null;
type SourceContainer = { id: string; name?: string; path?: string; selectable?: boolean; has_children?: boolean };

const BROWSABLE_PROVIDER_KINDS = new Set(["google_photos", "dropbox", "onedrive"]);

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
  local_ios: "iOS Camera Roll requires the LifeShot iOS app for on-device indexing (PhotoKit). Coming soon \u2014 in the meantime export an album to a zip and upload it.",
  local_android: "Android Gallery requires the LifeShot Android app (MediaStore). Coming soon \u2014 export to zip and upload as a workaround.",
  desktop_folder: "Desktop folders require the LifeShot desktop agent. Coming soon \u2014 zip the folder and upload it.",
  external_drive: "External drives require the LifeShot desktop agent. Coming soon \u2014 zip the contents and upload them.",
  nas: "NAS volumes require the LifeShot desktop agent (SMB). Coming soon \u2014 export a folder and upload as a zip.",
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
  const [disconnectConfirm, setDisconnectConfirm] = useState<DisconnectState>(null);

  useEffect(() => {
    if (!consent?.provider || manage) return;
    const matching = (accounts.data?.accounts ?? []).find(
      (account) => account.provider_kind === consent.provider.kind && account.status === "active",
    );
    if (matching) {
      setConsent(null);
      setManage({ provider: consent.provider, accountId: matching.id });
      void qc.invalidateQueries({ queryKey: ["source-containers", matching.id] });
    }
  }, [accounts.data?.accounts, consent, manage, qc]);

  function requestDisconnect(accountId: string, providerName: string) {
    setDisconnectConfirm({ accountId, providerName });
  }

  function confirmDisconnect() {
    if (!disconnectConfirm) return;
    disconnect.mutate(disconnectConfirm.accountId, {
      onSuccess: () => {
        toast.success("Source disconnected.");
        setDisconnectConfirm(null);
        setManage(null);
      },
      onError: (e) => toast.error((e as Error).message || "Disconnect failed."),
    });
  }

  // If this page is itself the OAuth popup, forward the result to the opener
  // and close the window. Detect by ?oauth_popup=1 + window.opener.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (search?.oauth_popup !== "1") return;
    if (!window.opener || window.opener === window) return;
    try {
      window.opener.postMessage(
        { type: "pmp:oauth", error: search?.error ?? null, detail: search?.detail ?? null },
        "*",
      );
    } catch { /* ignore */ }
    window.close();
  }, [search?.oauth_popup, search?.error, search?.detail]);

  // Listen for OAuth result postMessage from the popup.
  useEffect(() => {
    function handler(ev: MessageEvent) {
      const data = ev.data as { type?: string; error?: string | null; detail?: string | null; connected?: string | null; provider?: string | null } | null;
      if (!data || data.type !== "pmp:oauth") return;
      if (data.error) {
        const detail = data.detail ? `: ${decodeURIComponent(data.detail)}` : "";
        toast.error(`Connection failed (${data.error}${detail})`);
      } else {
        toast.success("Source connected. Select folders to start indexing.");
        if (data.connected && data.provider) {
          const provider = providers.data?.providers?.find((item) => item.kind === data.provider);
          if (provider) {
            setManage({ provider, accountId: data.connected });
            void qc.invalidateQueries({ queryKey: ["source-containers", data.connected] });
          }
        }
      }
      qc.invalidateQueries({ queryKey: ["source-accounts"] });
      try { popupRef.current?.close(); } catch { /* ignore */ }
      popupRef.current = null;
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [providers.data?.providers, qc]);

  // Surface OAuth callback errors as toasts.
  useEffect(() => {
    if (search?.error) {
      const detail = search.detail ? `: ${decodeURIComponent(search.detail)}` : "";
      toast.error(`Connection failed (${search.error}${detail})`);
    } else if (search?.connected) {
      toast.success("Source connected. Select folders to start indexing.");
      if (search.provider) {
        const provider = providers.data?.providers?.find((item) => item.kind === search.provider);
        if (provider) {
          setManage({ provider, accountId: search.connected });
          void qc.invalidateQueries({ queryKey: ["source-containers", search.connected] });
        }
      }
    }
  }, [providers.data?.providers, search?.connected, search?.detail, search?.error, search?.provider]);

  // Map provider_kind → first connected account so we can show a "Connected" badge
  // and switch the card from a Connect button to a Manage button.
  const connectedByKind = new Map<string, { id: string; status: string; asset_count: number }>();
  for (const a of accounts.data?.accounts ?? []) {
    if (a.status === "active" && !connectedByKind.has(a.provider_kind)) {
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
    const popupHost = (() => {
      try {
        return window.top && typeof window.top.open === "function" ? window.top : window;
      } catch {
        return window;
      }
    })();
    const popup = popupHost.open("about:blank", "pmp_oauth", `popup=yes,width=${w},height=${h},left=${x},top=${y}`);
    if (!popup) {
      toast.error("Popup was blocked. Allow pop-ups for this site and try again.");
      return;
    }
    popupRef.current = popup;

    try {
      const redirectUrl = new URL(`${window.location.origin}/oauth-popup`);
      const previewToken = new URLSearchParams(window.location.search).get("__lovable_token");
      if (previewToken) {
        redirectUrl.searchParams.set("__lovable_token", previewToken);
      }
      const out = await connect.mutateAsync({
        provider_id: provider.id,
        redirect_uri: redirectUrl.toString(),
      });
      if (out.authorize_url) {
        const authorizeUrl = new URL(out.authorize_url);
        if (["dropbox", "google_photos", "onedrive"].includes(provider.kind)) {
          authorizeUrl.searchParams.set("prompt", "consent");
          authorizeUrl.searchParams.set("force_reapprove", "true");
          authorizeUrl.searchParams.set("force_reauthentication", "true");
        }
        popup.location.href = authorizeUrl.toString();
        return;
      }
      popup?.close();
      popupRef.current = null;
      if (provider.kind === "export_import" && out.upload_target && out.session_token) {
        setUpload({ accountId: out.session_token, prefix: out.upload_target.prefix });
        return;
      }
      // Defensive: server should always return one of the above.
      toast.error(`${provider.name} did not return a connection URL. Please try again.`);
    } catch (e) {
      try { popup?.close(); } catch { /* ignore */ }
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
          LifeShot indexes — never stores. We keep a tiny reference and thumbnail; originals stay in the source you trust.
        </p>
      </header>
      <section className="mb-10">
        <div className="text-archive-label mb-3">Connected</div>
        {accounts.isLoading ? (
          <div className="space-y-2">{Array.from({length:2}).map((_,i)=><Skeleton key={i} className="h-20 rounded-md" />)}</div>
        ) : accounts.data?.accounts?.length ? (
          <ul className="space-y-2">
            {accounts.data.accounts.map((a) => (
              <SourceRow
                key={a.id}
                a={a}
                provider={providers.data?.providers?.find(p => p.kind === a.provider_kind)}
                onSync={() => sync.mutate(a.id, {
                  onSuccess: () => toast.success("Sync queued. Indexing your folders…"),
                  onError: (e) => toast.error((e as Error).message || "Sync failed to start."),
                })}
                onSelectFolders={() => {
                  const provider = providers.data?.providers?.find(p => p.kind === a.provider_kind);
                  if (!provider) return;
                  setManage({ provider, accountId: a.id });
                }}
                onDisconnect={() => {
                  requestDisconnect(a.id, providers.data?.providers?.find(p => p.kind === a.provider_kind)?.name ?? a.display_label ?? a.provider_kind);
                }}
              />
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
        onSync={(id) => {
          sync.mutate(id, {
            onSuccess: () => toast.success("Sync queued. Indexing your folders…"),
            onError: (e) => toast.error((e as Error).message || "Sync failed to start."),
          });
          setManage(null);
        }}
        onDisconnect={(id) => {
          requestDisconnect(id, manage?.provider.name ?? "this source");
        }}
        onReconnect={(p) => { setManage(null); setConsent({ provider: p }); }}
      />
      <ConfigMissingDialog state={configMissing} onClose={() => setConfigMissing(null)} />
      <DisconnectDialog
        state={disconnectConfirm}
        pending={disconnect.isPending}
        onClose={() => !disconnect.isPending && setDisconnectConfirm(null)}
        onConfirm={confirmDisconnect}
      />
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
            You'll be redirected to {state?.provider.name} to approve access. LifeShot only indexes — your originals stay where they are.
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
            <a href="/privacy" className="underline">Privacy Policy</a>, and authorize LifeShot to index this source on my behalf.
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
  const containers = useSourceContainers(state?.accountId);
  const updateContainers = useUpdateSourceContainers();
  const selected = containers.data?.selected ?? [];
  const [draft, setDraft] = useState<Record<string, SourceContainer>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!state) {
      setDraft({});
      setExpanded({});
      return;
    }
    const next = Object.fromEntries(selected.map((item) => [item.id, item]));
    setDraft(next);
  }, [state, containers.data?.selected]);

  const rootItems = containers.data?.containers ?? [];

  const toggleExpanded = (item: SourceContainer) => {
    setExpanded((prev) => ({ ...prev, [item.id]: !prev[item.id] }));
  };

  const toggleContainer = (item: SourceContainer) => {
    setDraft((prev) => {
      if (prev[item.id]) {
        const next = { ...prev };
        delete next[item.id];
        return next;
      }
      return { ...prev, [item.id]: item };
    });
  };
  const expectsBrowserTree = !!state && BROWSABLE_PROVIDER_KINDS.has(state.provider.kind);
  const accountMissing = !!state && !containers.isLoading && !containers.data && !containers.error;
  const reason = (containers.data as { reason?: string | null } | undefined)?.reason ?? null;
  const reasonHint =
    reason === "service_unavailable"
      ? "Folder discovery service isn't configured yet."
      : reason === "provider_unsupported"
        ? "This provider doesn't expose a browsable folder list."
        : reason === "no_token"
          ? "We couldn't read this source's access token. Try reconnecting."
          : reason === "no_session"
            ? "Your session expired. Refresh the page and try again."
            : reason === "account_not_found"
              ? "This source is no longer connected."
          : reason === "internal_error"
            ? "Couldn't load folders from the provider. Try reconnecting, then open Select folders again."
            : null;

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.provider.name}</DialogTitle>
          <DialogDescription>
            Choose which folders or albums should be indexed for this source.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] p-3">
            <div className="mb-2 text-sm font-medium text-[color:var(--ink)]">Folders to index</div>
            {accountMissing ? (
              <p className="text-xs text-[color:var(--umber)]">This source is no longer connected.</p>
            ) : containers.isLoading ? (
              <p className="text-xs text-[color:var(--umber)]">Loading folders…</p>
            ) : (rootItems.length || Object.keys(draft).length) ? (
              (() => {
                const rootIds = new Set(rootItems.map((r) => r.id));
                const orphanPaths = Object.values(draft)
                  .filter((item) => !rootIds.has(item.id) && !!item.path)
                  .map((item) => item.path as string);
                return (
                  <div className="max-h-72 space-y-1 overflow-auto pr-1">
                    {rootItems.map((item) => (
                      <ContainerTreeNode
                        key={item.id}
                        accountId={state?.accountId}
                        item={item}
                        depth={0}
                        expanded={expanded}
                        draft={draft}
                        onToggleExpanded={toggleExpanded}
                        onToggleSelected={toggleContainer}
                        autoExpandPaths={orphanPaths}
                      />
                    ))}
                  </div>
                );
              })()
            ) : (
              <p className="text-xs text-[color:var(--umber)]">
                {reasonHint ?? (expectsBrowserTree
                  ? "No folders were returned by the source yet."
                  : "No selectable folders are available for this source.")}
              </p>
            )}
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-[color:var(--umber)]">
                Only checked folders are used for indexing and future syncs. Selections are remembered per source.
              </p>
              <Button
                size="sm"
                disabled={accountMissing || updateContainers.isPending || containers.isLoading}
                onClick={() => state && updateContainers.mutate({
                  accountId: state.accountId,
                  containers: Object.values(draft),
                }, {
                  onSuccess: () => toast.success("Folder scope saved. Click Sync to index."),
                  onError: (e) => toast.error((e as Error).message || "Failed to save folder scope."),
                })}
              >
                {updateContainers.isPending ? "Saving…" : "Save scope"}
              </Button>
            </div>
          </div>
          <Button variant="outline" disabled={accountMissing} onClick={() => state && onSync(state.accountId)}>
            <RefreshCcw className="mr-2 h-4 w-4" /> Sync now
          </Button>
          <Button variant="outline" disabled={accountMissing} onClick={() => state && onReconnect(state.provider)}>
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

function ContainerTreeNode({
  accountId,
  item,
  depth,
  expanded,
  draft,
  onToggleExpanded,
  onToggleSelected,
  autoExpandPaths,
}: {
  accountId: string | undefined;
  item: SourceContainer;
  depth: number;
  expanded: Record<string, boolean>;
  draft: Record<string, SourceContainer>;
  onToggleExpanded: (item: SourceContainer) => void;
  onToggleSelected: (item: SourceContainer) => void;
  autoExpandPaths?: string[];
}) {
  const isExpanded = !!expanded[item.id];
  const children = useSourceContainerChildren({
    accountId,
    parentId: item.id,
    enabled: isExpanded && !!item.has_children,
  });
  const childItems = children.data?.containers ?? [];

  // Auto-expand this node if any saved-but-not-yet-visible selection's path
  // lives beneath it. This walks the tree down to the nested selection so it
  // appears inline at its real location instead of as a separate list.
  const shouldAutoExpand =
    !!item.has_children &&
    !isExpanded &&
    !!item.path &&
    !!autoExpandPaths?.some((p) => {
      const base = item.path === "/" ? "/" : `${item.path}/`;
      return p !== item.path && p.startsWith(base);
    });
  useEffect(() => {
    if (shouldAutoExpand) onToggleExpanded(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoExpand]);

  return (
    <div>
      <div
        className="flex items-start gap-2 rounded-sm px-2 py-1 text-sm text-[color:var(--ink)]"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <button
          type="button"
          onClick={() => item.has_children && onToggleExpanded(item)}
          className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center text-[color:var(--umber)] disabled:opacity-30"
          disabled={!item.has_children}
          aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
        >
          <ChevronRight className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
        </button>
        <input
          type="checkbox"
          className="mt-0.5"
          checked={!!draft[item.id]}
          onChange={() => onToggleSelected(item)}
          disabled={item.selectable === false}
        />
        <button
          type="button"
          onClick={() => item.has_children && onToggleExpanded(item)}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          {isExpanded ? <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--umber)]" /> : <Folder className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--umber)]" />}
          <span className="min-w-0 break-all">
            {item.name ?? item.id}
            {item.path && item.path !== "/" ? (
              <span className="ml-2 text-xs text-[color:var(--umber)]">{item.path}</span>
            ) : null}
          </span>
        </button>
      </div>

      {isExpanded ? (
        <div>
          {children.isLoading ? (
            <p className="px-2 py-1 text-xs text-[color:var(--umber)]" style={{ paddingLeft: `${(depth + 1) * 16 + 24}px` }}>
              Loading…
            </p>
          ) : childItems.length ? (
            childItems.map((child) => (
              <ContainerTreeNode
                key={child.id}
                accountId={accountId}
                item={child}
                depth={depth + 1}
                expanded={expanded}
                draft={draft}
                onToggleExpanded={onToggleExpanded}
                onToggleSelected={onToggleSelected}
                autoExpandPaths={autoExpandPaths}
              />
            ))
          ) : (
            <p className="px-2 py-1 text-xs text-[color:var(--umber)]" style={{ paddingLeft: `${(depth + 1) * 16 + 24}px` }}>
              No subfolders.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function DisconnectDialog({
  state,
  pending,
  onClose,
  onConfirm,
}: {
  state: DisconnectState;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={!!state} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {state?.providerName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Indexed memories from this source will be removed, and future syncs will stop.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            {pending ? "Disconnecting…" : "Disconnect"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConfigMissingDialog({ state, onClose }: { state: ConfigMissingState; onClose: () => void }) {
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.provider.name} isn't configured yet</DialogTitle>
          <DialogDescription>
            OAuth credentials for {state?.provider.name} haven't been added. An admin needs to set the following secrets in the Supabase project (Edge Functions → Secrets):
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
            Drop a zip export or pick files directly. They upload to your private storage, then LifeShot indexes them \u2014 originals stay yours.
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

function SourceRow({ a, onSync, onSelectFolders, onDisconnect, provider }: {
  a: {
    id: string; provider_kind: string; status: string; display_label: string | null;
    asset_count: number; last_sync_at: string | null;
    selected_container_count?: number;
    counts_by_kind?: { photo: number; video: number; document: number; audio: number; other: number };
    selection_counts_by_kind?: { photo: number; video: number; document: number; audio: number; other: number };
  };
  onSync: () => void; onSelectFolders: () => void; onDisconnect: () => void;
  provider?: { name: string; kind: string };
}) {
  const qc = useQueryClient();
  const status = useSourceStatus(a.id);
  const s = status.data;
  const running =
    s?.status === "syncing" ||
    s?.last_job?.status === "running" ||
    s?.last_job?.status === "pending";
  // While running, refresh the parent accounts list so indexed/folder counts
  // climb in near-real-time as the worker upserts assets.
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (running) {
      const t = setInterval(() => {
        qc.invalidateQueries({ queryKey: ["source-accounts"] });
      }, 5_000);
      return () => clearInterval(t);
    }
    if (wasRunningRef.current && !running) {
      // Just finished — pull fresh totals once.
      qc.invalidateQueries({ queryKey: ["source-accounts"] });
    }
    wasRunningRef.current = running;
  }, [running, qc]);
  const indexed = s?.progress.indexed ?? a.asset_count ?? 0;
  const discovered = s?.progress.discovered ?? indexed;
  const pct = discovered > 0 ? Math.min(100, Math.round((indexed / discovered) * 100)) : null;
  const k = a.selection_counts_by_kind ?? { photo: 0, video: 0, document: 0, audio: 0, other: 0 };
  const folders = a.selected_container_count ?? 0;
  const docsCombined = k.document + k.audio + k.other;
  return (
    <li className="hairline rounded-md border bg-[color:var(--paper)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[color:var(--paper-2)] text-[color:var(--ink)]">
            <ProviderIcon kind={a.provider_kind} className="h-5 w-5" />
          </div>
          <div className="min-w-0">
          <div className="font-medium text-[color:var(--ink)]">{provider?.name ?? a.display_label ?? a.provider_kind}</div>
          <div className="text-xs text-[color:var(--umber)]">
            {folders.toLocaleString()} folder{folders === 1 ? "" : "s"} ·{" "}
            {k.photo.toLocaleString()} photo{k.photo === 1 ? "" : "s"} ·{" "}
            {k.video.toLocaleString()} video{k.video === 1 ? "" : "s"} ·{" "}
            {docsCombined.toLocaleString()} doc{docsCombined === 1 ? "" : "s"}
            {" · "}
            <span className="font-medium text-[color:var(--ink)]">{a.asset_count.toLocaleString()} indexed</span>
            {!running && (
              <>
                {" · "}
                <span>{a.status}</span>
              </>
            )}
            {a.last_sync_at && ` · synced ${new Date(a.last_sync_at).toLocaleString()}`}
          </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onSelectFolders} className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border)] px-3 py-1.5 text-xs hover:bg-[color:var(--paper-2)]">
            <Settings2 className="h-3 w-3" /> Select folders
          </button>
          <button onClick={onSync} className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border)] px-3 py-1.5 text-xs hover:bg-[color:var(--paper-2)]">
            <RefreshCcw className="h-3 w-3" /> Sync
          </button>
          <button onClick={onDisconnect}
            className="inline-flex items-center gap-1 rounded-full border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10">
            <Trash2 className="h-3 w-3" /> Disconnect
          </button>
        </div>
      </div>
      {running && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-[color:var(--paper-2)]">
            <div
              className={`h-full bg-[color:var(--ink)] transition-all ${pct === null ? "animate-pulse w-1/3" : ""}`}
              style={pct !== null ? { width: `${pct}%` } : undefined}
            />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-[color:var(--umber)]">
            <span>Syncing…</span>
            <span>
              {indexed.toLocaleString()} indexed
              {pct !== null ? ` (${pct}%)` : ""}
            </span>
          </div>
        </div>
      )}
      {s?.last_error && <p className="mt-2 text-xs text-destructive">{s.last_error}</p>}
    </li>
  );
}