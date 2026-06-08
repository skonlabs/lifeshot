import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  Compass, Layers, LogOut, Search, ShieldCheck, Users, MapPin, Calendar,
  CopyCheck, Plug, Heart, Database, ChevronRight,
} from "lucide-react";

const LENSES = [
  { to: "/dashboard", label: "Atlas", icon: Compass },
  { to: "/library", label: "Archive", icon: Layers },
  { to: "/search", label: "Recall", icon: Search },
  { to: "/people", label: "People", icon: Users },
  { to: "/places", label: "Places", icon: MapPin },
  { to: "/events", label: "Chapters", icon: Calendar },
  { to: "/duplicates", label: "Duplicates", icon: CopyCheck },
  { to: "/sources", label: "Sources", icon: Plug },
  { to: "/family", label: "Family", icon: Heart },
] as const;

const META = [
  { to: "/settings/privacy", label: "Privacy", icon: ShieldCheck },
  { to: "/settings/data", label: "Your data", icon: Database },
] as const;

export function AppShell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  // ⌘K / ctrl+K → focus the recall search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        navigate({ to: "/search" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);

  return (
    <div className="flex min-h-screen surface-paper text-foreground">
      {/* Slim icon rail */}
      <aside className="sticky top-0 hidden h-screen w-[68px] shrink-0 flex-col items-center justify-between border-r border-[color:var(--border)] bg-[color:var(--paper-2)]/70 py-5 backdrop-blur md:flex">
        <Link to="/dashboard" aria-label="LifeShot atlas" className="group flex flex-col items-center gap-1">
          <div className="grid h-9 w-9 place-items-center rounded-md border border-[color:var(--umber)]/30 bg-[color:var(--paper)] text-[color:var(--ink)] shadow-sm transition-transform group-hover:rotate-[-2deg]">
            <span className="font-serif-display text-lg leading-none">L</span>
          </div>
          <span className="text-archive-label !text-[8px] !tracking-[0.22em]">LifeShot</span>
        </Link>
        <nav className="flex flex-1 flex-col items-center gap-1.5 pt-8">
          {LENSES.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              aria-label={l.label}
              className="group relative grid h-10 w-10 place-items-center rounded-md text-[color:var(--umber)] transition-colors hover:bg-[color:var(--paper)] hover:text-[color:var(--ink)]"
              activeProps={{ className: "bg-[color:var(--paper)] text-[color:var(--ink)] shadow-sm ring-1 ring-[color:var(--umber)]/20" }}
            >
              <l.icon className="h-[18px] w-[18px]" strokeWidth={1.5} />
              <span className="pointer-events-none absolute left-12 z-30 whitespace-nowrap rounded-md border border-[color:var(--border)] bg-[color:var(--ink)] px-2 py-1 text-[11px] font-medium text-[color:var(--paper)] opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                {l.label}
              </span>
            </Link>
          ))}
        </nav>
        <div className="flex flex-col items-center gap-1.5">
          {META.map((m) => (
            <Link
              key={m.to}
              to={m.to}
              aria-label={m.label}
              className="grid h-10 w-10 place-items-center rounded-md text-[color:var(--umber)] transition-colors hover:bg-[color:var(--paper)] hover:text-[color:var(--ink)]"
              activeProps={{ className: "bg-[color:var(--paper)] text-[color:var(--ink)] ring-1 ring-[color:var(--umber)]/20" }}
            >
              <m.icon className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </Link>
          ))}
          <button
            onClick={() => { void signOut(); }}
            aria-label="Sign out"
            className="grid h-10 w-10 place-items-center rounded-md text-[color:var(--umber)] hover:bg-[color:var(--paper)] hover:text-[color:var(--ink)]"
          >
            <LogOut className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Editorial top band */}
        <header className="sticky top-0 z-20 border-b border-[color:var(--border)] bg-[color:var(--paper)]/85 backdrop-blur">
          <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-3">
            <div className="flex items-baseline gap-3">
              <span className="text-archive-label">vol. 01 · the memory atlas</span>
              <span className="hidden text-[color:var(--umber)]/40 md:inline">/</span>
              <span className="hidden font-serif-display text-base text-[color:var(--ink)] md:inline">
                a private archive of {user?.email?.split("@")[0] ?? "you"}
              </span>
            </div>
            <form
              onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate({ to: "/search", search: { q: q.trim() } as never }); }}
              className="ml-auto hidden flex-1 max-w-md items-center gap-2 rounded-full border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-1.5 text-sm focus-within:border-[color:var(--umber)] md:flex"
            >
              <Search className="h-3.5 w-3.5 text-[color:var(--umber)]" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Recall a memory — 'beach with mom, 2019'"
                className="flex-1 bg-transparent text-[13px] placeholder:text-[color:var(--umber)]/70 focus:outline-none"
              />
              <kbd className="rounded border border-[color:var(--border)] bg-[color:var(--paper)] px-1.5 py-0.5 text-[10px] text-[color:var(--umber)]">⌘K</kbd>
            </form>
            <Link to="/sources" className="hidden items-center gap-1 rounded-full border border-[color:var(--ink)] bg-[color:var(--ink)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--paper)] hover:bg-[color:var(--umber)] md:inline-flex">
              Add source <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {/* Mobile lens strip */}
          <nav className="flex gap-1 overflow-x-auto border-t border-[color:var(--border)] px-3 py-2 md:hidden">
            {LENSES.map((l) => (
              <Link key={l.to} to={l.to}
                activeProps={{ className: "bg-[color:var(--ink)] text-[color:var(--paper)]" }}
                className="flex items-center gap-1 whitespace-nowrap rounded-full border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--umber)]"
              >
                <l.icon className="h-3 w-3" strokeWidth={1.5} /> {l.label}
              </Link>
            ))}
          </nav>
        </header>

        <main className="flex-1">
          <Outlet />
        </main>

        <footer className="hairline-t mx-auto w-full max-w-[1400px] px-6 py-4 text-[11px] text-[color:var(--umber)]">
          <span className="text-archive-label">LifeShot · personal memory platform</span>
          <span className="ml-3">We index, we never move. Originals stay in your sources.</span>
        </footer>
      </div>
    </div>
  );
}