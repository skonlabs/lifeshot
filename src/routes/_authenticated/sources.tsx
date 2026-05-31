import { createFileRoute } from "@tanstack/react-router";
import { useConnectSource, useDisconnectSource, useProviders, useSourceAccounts, useSourceStatus, useSyncSource } from "@/lib/api/hooks";
import { useSourceProgress } from "@/lib/realtime/useSourceProgress";
import { Skeleton } from "@/components/ui/skeleton";
import { Plug, RefreshCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

const LOCAL_PROVIDER_KINDS = new Set(["local_ios", "local_android", "desktop_folder", "external_drive", "nas", "export_import"]);
const UNSUPPORTED_PROVIDER_KINDS = new Set(["icloud", "amazon_photos"]);

export const Route = createFileRoute("/_authenticated/sources")({ component: Sources });

function Sources() {
  useSourceProgress();
  const accounts = useSourceAccounts();
  const providers = useProviders();
  const connect = useConnectSource();
  const sync = useSyncSource();
  const disconnect = useDisconnectSource();

  async function onConnect(providerId: string) {
    try {
      const provider = providers.data?.providers?.find((p) => p.id === providerId);
      if (!provider) {
        toast.error("Source provider unavailable.");
        return;
      }
      if (UNSUPPORTED_PROVIDER_KINDS.has(provider.kind)) {
        toast.error(`${provider.name} does not have a live connection flow yet.`);
        return;
      }
      if (LOCAL_PROVIDER_KINDS.has(provider.kind)) {
        toast.message(`${provider.name} needs its local import flow wired next.`);
        return;
      }
      const out = await connect.mutateAsync({
        provider_id: providerId,
        redirect_uri: `${window.location.origin}/callback`,
      });
      if (out.authorize_url) window.location.href = out.authorize_url;
      else toast.success("Connected.");
    } catch (e) {
      toast.error((e as Error).message);
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
          <div className="grid gap-2 md:grid-cols-2">{Array.from({length:4}).map((_,i)=><Skeleton key={i} className="h-20 rounded-md" />)}</div>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {providers.data?.providers?.map((p) => (
              <button key={p.id} onClick={() => onConnect(p.id)}
                className="hairline group flex items-center gap-3 rounded-md border bg-[color:var(--paper)] p-4 text-left transition-colors hover:bg-[color:var(--paper-2)]">
                <div className="grid h-10 w-10 place-items-center rounded-md bg-[color:var(--paper-2)] text-[color:var(--umber)] group-hover:text-[color:var(--ink)]">
                  <Plug className="h-4 w-4" strokeWidth={1.5} />
                </div>
                <div>
                  <div className="font-medium text-[color:var(--ink)]">{p.name}</div>
                  <div className="text-xs text-[color:var(--umber)]">
                    {p.kind} · {p.priority}
                    {UNSUPPORTED_PROVIDER_KINDS.has(p.kind) ? " · unavailable" : LOCAL_PROVIDER_KINDS.has(p.kind) ? " · local flow pending" : ""}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
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