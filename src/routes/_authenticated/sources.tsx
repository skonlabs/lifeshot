import { createFileRoute } from "@tanstack/react-router";
import { useConnectSource, useDisconnectSource, useProviders, useSourceAccounts, useSyncSource } from "@/lib/api/hooks";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/sources")({ component: Sources });

function Sources() {
  const accounts = useSourceAccounts();
  const providers = useProviders();
  const connect = useConnectSource();
  const sync = useSyncSource();
  const disconnect = useDisconnectSource();

  async function onConnect(providerId: string) {
    try {
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
    <div className="mx-auto max-w-4xl space-y-8 px-6 py-8">
      <header>
        <h1 className="font-display text-2xl">Sources</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          LifeShot indexes — it doesn't store. Connect a source and we keep a lightweight reference plus a small thumbnail.
        </p>
      </header>
      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Connected</h2>
        {accounts.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : accounts.data?.accounts?.length ? (
          <ul className="space-y-2">
            {accounts.data.accounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <div className="font-medium">{a.display_label ?? a.provider_kind}</div>
                  <div className="text-xs text-muted-foreground">
                    {a.asset_count.toLocaleString()} assets · {a.status}
                    {a.last_sync_at && ` · synced ${new Date(a.last_sync_at).toLocaleString()}`}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => sync.mutate(a.id)} className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent">Sync</button>
                  <button
                    onClick={() => {
                      if (confirm("Disconnect this source? Indexed memories will be removed.")) disconnect.mutate(a.id);
                    }}
                    className="rounded-md border px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
                  >Disconnect</button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No sources connected yet.</p>
        )}
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Add a source</h2>
        {providers.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {providers.data?.providers?.map((p) => (
              <button key={p.id} onClick={() => onConnect(p.id)} className="rounded-lg border p-4 text-left transition-colors hover:bg-accent">
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">{p.kind} · {p.priority}</div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}