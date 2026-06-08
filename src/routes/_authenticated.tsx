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
  const redirectTarget = typeof location.href === "string" && location.href.startsWith("/")
    ? location.href
    : location.pathname;

  useEffect(() => {
    if (loading || isAuthenticated) return;

    void navigate({
      to: "/sign-in",
      search: { redirect: redirectTarget === "/sign-in" ? "/library" : redirectTarget },
      replace: true,
    });
  }, [isAuthenticated, loading, navigate, redirectTarget]);

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