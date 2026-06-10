import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useActiveAssetCount, useDashboard, useEvents, usePeople, useSourceAccounts, useViewport } from "@/lib/api/hooks";
import { useSourceProgress } from "@/lib/realtime/useSourceProgress";
import { AssetCell } from "@/components/app/AssetCell";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronRight, Compass, Users, Calendar, Plug, ShieldCheck, Sparkles } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({ component: Dashboard });

function Dashboard() {
  useSourceProgress();
  const dash = useDashboard();
  const assetCount = useActiveAssetCount();
  const viewport = useViewport({ viewport_size: 12, quality_preference: "best" });
  const events = useEvents();
  const people = usePeople();
  const accounts = useSourceAccounts();

  const recent = useMemo(
    () => viewport.data?.pages.flatMap((p) => p.items) ?? [],
    [viewport.data],
  );
  const featured = recent[0];
  const strip = recent.slice(1, 7);
  const d = dash.data;

  const years = d?.per_year ? Object.entries(d.per_year).sort(([a], [b]) => Number(b) - Number(a)) : [];

  return (
    <div className="mx-auto max-w-[1400px] px-6 pb-16 pt-8">
      {/* Editorial masthead */}
      <section className="hairline-b grid grid-cols-12 gap-6 pb-10">
        <div className="col-span-12 md:col-span-7">
          <span className="text-archive-label">no. 001 — today's atlas</span>
          <h1 className="mt-3 font-serif-display text-5xl leading-[1.05] text-[color:var(--ink)] md:text-6xl">
            Your photos,<br/>
            <span className="italic text-[color:var(--umber)]">made navigable.</span>
          </h1>
          <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-[color:var(--umber)]">
            One archive across every phone, cloud, message thread, and family member —
            without moving a single file. Search by feeling, by face, by place, by year.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link to="/search" className="inline-flex items-center gap-1 rounded-full bg-[color:var(--ink)] px-4 py-2 text-[13px] font-medium text-[color:var(--paper)] hover:bg-[color:var(--umber)]">
              <Sparkles className="h-3.5 w-3.5" /> Search your photos
            </Link>
            <Link to="/sources" className="inline-flex items-center gap-1 rounded-full border border-[color:var(--ink)] px-4 py-2 text-[13px] font-medium text-[color:var(--ink)] hover:bg-[color:var(--paper-2)]">
              <Plug className="h-3.5 w-3.5" /> Connect a source
            </Link>
          </div>
        </div>

        {/* Featured "memory of the day" cinematic card */}
        <div className="col-span-12 md:col-span-5">
          <div className="hairline overflow-hidden rounded-lg border bg-[color:var(--paper-2)] shadow-sm">
            <div className="relative aspect-[5/4] w-full bg-[color:var(--clay)]">
              {viewport.isLoading ? (
                <Skeleton className="absolute inset-0" />
              ) : featured ? (
                <AssetCell d={featured} style={{ position: "absolute", inset: 0, borderRadius: 0 }} />
              ) : (
                <div className="absolute inset-0 grid place-items-center text-center text-xs text-[color:var(--umber)]">
                  Connect a source to surface a featured photo.
                </div>
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[color:var(--ink)]/70 to-transparent p-4">
                <span className="text-archive-label !text-[color:var(--paper)]/70">featured · today</span>
                <p className="font-serif-display text-xl text-[color:var(--paper)]">
                  {featured?.capture_time ? new Date(featured.capture_time).toDateString() : "Your story, one frame at a time"}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Bento: stats + lenses */}
      <section className="grid grid-cols-12 gap-3 py-8">
        <Stat title="Photos indexed" value={assetCount.data?.count ?? d?.total_assets} accent />
        <Stat title="At risk" value={d?.at_risk} href="/sources" />
        <Stat title="Duplicate groups" value={d?.duplicate_groups} href="/duplicates" />
        <Stat title="People" value={people.data?.people?.length} href="/people" icon={Users} />
        <Stat title="Chapters" value={events.data?.events?.length} href="/events" icon={Calendar} />
        <Stat title="Sources" value={accounts.data?.accounts?.length} href="/sources" icon={Plug} />
      </section>

      {/* Recent strip */}
      <section className="grid grid-cols-12 gap-6 pb-10">
        <div className="col-span-12 lg:col-span-8">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <span className="text-archive-label">recent additions</span>
              <h2 className="mt-1 font-display text-2xl text-[color:var(--ink)]">From the archive</h2>
            </div>
            <Link to="/library" className="inline-flex items-center gap-1 text-xs text-[color:var(--umber)] hover:text-[color:var(--ink)]">
              Open archive <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
          {viewport.isLoading ? (
            <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-md" />)}
            </div>
          ) : strip.length ? (
            <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
              {strip.map((a) => (
                <div key={a.asset_id} className="aspect-square">
                  <AssetCell d={a} style={{ width: "100%", height: "100%" }} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyArchive />
          )}
        </div>

        {/* Timeline by year */}
        <aside className="col-span-12 lg:col-span-4">
          <span className="text-archive-label">by year</span>
          <h2 className="mb-3 mt-1 font-display text-2xl text-[color:var(--ink)]">Your timeline</h2>
          {dash.isLoading ? (
            <Skeleton className="h-40 rounded-md" />
          ) : years.length ? (
            <ul className="space-y-1">
              {years.slice(0, 12).map(([y, n]) => {
                const max = Math.max(...years.map(([, v]) => v));
                const pct = Math.max(4, Math.round((n / max) * 100));
                return (
                  <li key={y} className="group flex items-center gap-3 text-sm">
                    <span className="w-12 font-display text-[color:var(--umber)]">{y}</span>
                    <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-[color:var(--paper-2)]">
                      <div className="h-full bg-[color:var(--ink)] transition-all group-hover:bg-[color:var(--umber)]" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-12 text-right tabular-nums text-[color:var(--umber)]">{n}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-[color:var(--umber)]">No photos indexed yet.</p>
          )}
        </aside>
      </section>

      {/* Source health */}
      <section className="hairline-t grid grid-cols-12 gap-6 py-8">
        <div className="col-span-12 lg:col-span-5">
          <span className="text-archive-label">connected sources</span>
          <h2 className="mt-1 font-display text-2xl text-[color:var(--ink)]">Where photos live</h2>
          <p className="mt-2 text-sm text-[color:var(--umber)]">
            Each source remains the source of truth. We keep only a reference and a thumbnail.
          </p>
        </div>
        <div className="col-span-12 lg:col-span-7">
          {accounts.isLoading ? (
            <Skeleton className="h-32 rounded-md" />
          ) : accounts.data?.accounts?.length ? (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {accounts.data.accounts.slice(0, 6).map((a) => (
                <li key={a.id} className="hairline rounded-md border bg-[color:var(--paper)] p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[color:var(--ink)]">{a.display_label ?? a.provider_kind}</span>
                    <span className={"text-[10px] uppercase tracking-wider " + (a.status === "active" || a.status === "connected" ? "text-emerald-700" : "text-[color:var(--umber)]")}>{a.status}</span>
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--umber)]">
                    {a.asset_count.toLocaleString()} indexed · {a.last_sync_at ? `synced ${relTime(a.last_sync_at)}` : "never synced"}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Link to="/sources" className="hairline block rounded-md border border-dashed bg-[color:var(--paper)] p-6 text-center">
              <Compass className="mx-auto h-6 w-6 text-[color:var(--umber)]" />
              <p className="mt-2 text-sm text-[color:var(--ink)]">Start your atlas — connect a source.</p>
            </Link>
          )}
          <Link to="/settings/privacy" className="mt-3 inline-flex items-center gap-1 text-xs text-[color:var(--umber)] hover:text-[color:var(--ink)]">
            <ShieldCheck className="h-3 w-3" /> Review privacy & consents
          </Link>
        </div>
      </section>
    </div>
  );
}

function Stat({ title, value, href, accent, icon: Icon }: { title: string; value: number | undefined; href?: string; accent?: boolean; icon?: React.ComponentType<{ className?: string }> }) {
  const body = (
    <div className={
      "hairline relative h-full rounded-lg border p-4 transition-colors " +
      (accent ? "bg-[color:var(--ink)] text-[color:var(--paper)]" : "bg-[color:var(--paper)] hover:bg-[color:var(--paper-2)]")
    }>
      <div className={"text-archive-label " + (accent ? "!text-[color:var(--paper)]/70" : "")}>{title}</div>
      <div className="mt-3 flex items-baseline justify-between gap-2">
        <span className={"font-display text-3xl tabular-nums " + (accent ? "" : "text-[color:var(--ink)]")}>{(value ?? 0).toLocaleString()}</span>
        {Icon ? <Icon className={"h-4 w-4 " + (accent ? "opacity-70" : "text-[color:var(--umber)]")} /> : null}
      </div>
    </div>
  );
  const wrapper = "col-span-6 md:col-span-4 lg:col-span-2";
  return href ? <Link to={href} className={wrapper}>{body}</Link> : <div className={wrapper}>{body}</div>;
}

function EmptyArchive() {
  return (
    <Link to="/sources" className="hairline block rounded-md border border-dashed bg-[color:var(--paper)] p-10 text-center">
      <h3 className="font-serif-display text-xl text-[color:var(--ink)]">Your archive is waiting</h3>
      <p className="mt-1 text-sm text-[color:var(--umber)]">Connect a source — Google Photos, iCloud, an old hard drive — to begin.</p>
    </Link>
  );
}

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.round(diff / 3.6e6);
  if (h < 1) return "moments ago";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}