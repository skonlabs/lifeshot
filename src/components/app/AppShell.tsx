import { Link, Outlet, useRouter } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  Camera, Home, Image, LogOut, Search, Settings, Users, MapPin, Calendar, Copy, Plug, Heart,
} from "lucide-react";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: Home },
  { to: "/library", label: "Library", icon: Image },
  { to: "/search", label: "Search", icon: Search },
  { to: "/people", label: "People", icon: Users },
  { to: "/places", label: "Places", icon: MapPin },
  { to: "/events", label: "Events", icon: Calendar },
  { to: "/duplicates", label: "Duplicates", icon: Copy },
  { to: "/sources", label: "Sources", icon: Plug },
  { to: "/family", label: "Family", icon: Heart },
  { to: "/settings/privacy", label: "Privacy", icon: Settings },
] as const;

export function AppShell() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r bg-card md:flex md:flex-col">
        <div className="flex items-center gap-2 border-b px-5 py-4">
          <Camera className="h-5 w-5 text-primary" />
          <span className="font-display text-lg font-semibold">LifeShot</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-3">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeProps={{ className: "bg-accent text-accent-foreground" }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t px-3 py-3">
          <div className="mb-2 truncate px-2 text-xs text-muted-foreground">{user?.email}</div>
          <button
            onClick={async () => {
              await signOut();
              router.navigate({ to: "/sign-in" });
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 bg-background">
        <Outlet />
      </main>
    </div>
  );
}