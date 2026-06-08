import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "@/components/app/AppShell";
import { useAuth } from "@/lib/auth/AuthProvider";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { isAuthenticated, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname;

  useEffect(() => {
    if (loading || isAuthenticated) return;
    const redirect = pathname && pathname.startsWith("/") && pathname !== "/sign-in"
      ? pathname
      : "/library";
    void navigate({
      to: "/sign-in",
      search: { redirect },
      replace: true,
    });
  }, [isAuthenticated, loading, navigate, pathname]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[color:var(--paper)] px-6 text-sm text-[color:var(--umber)]">
        Checking your archive…
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <AppShell />;
}