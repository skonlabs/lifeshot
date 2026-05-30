import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useAuth, AuthProvider } from "@/hooks/use-auth";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/_authenticated/app")({
  component: AppShellWrapper,
});

function AppShellWrapper() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

const NAV = [
  { to: "/app", label: "Dashboard", exact: true },
  { to: "/app/library", label: "Library", exact: false },
  { to: "/app/search", label: "Search", exact: false },
  { to: "/app/events", label: "Events", exact: false },
  { to: "/app/people", label: "People", exact: false },
  { to: "/app/duplicates", label: "Duplicates", exact: false },
  { to: "/app/sources", label: "Sources", exact: false },
  { to: "/app/family", label: "Family", exact: false },
  { to: "/app/settings", label: "Privacy", exact: false },
] as const;

function AppShell() {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  return (
    <div className="min-h-screen bg-paper text-foreground">
      <div className="grid grid-cols-[260px_1fr]">
        <aside className="border-r border-border min-h-screen p-6 sticky top-0">
          <Link to="/" className="font-display text-2xl text-ink">LifeShot</Link>
          <nav className="mt-8 flex flex-col gap-1">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                activeOptions={{ exact: n.exact }}
                activeProps={{ className: "bg-ink text-paper" }}
                className="rounded-lg px-3 py-2 text-sm hover:bg-foreground/5 transition"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="mt-10 pt-6 border-t border-border text-sm text-foreground/70">
            <div className="truncate">{user?.email}</div>
            <button
              onClick={async () => { await signOut(); nav({ to: "/" }); }}
              className="mt-2 text-ink underline"
            >
              Sign out
            </button>
          </div>
        </aside>
        <main className="p-8 sm:p-10 max-w-6xl">
          <Outlet />
        </main>
      </div>
      <Toaster position="top-center" />
    </div>
  );
}