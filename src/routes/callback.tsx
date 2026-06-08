import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { restoreSessionOnce } from "@/lib/supabase";

export const Route = createFileRoute("/callback")({ component: Callback });

function Callback() {
  const navigate = useNavigate();
  useEffect(() => {
    void restoreSessionOnce().then((session) => {
      let redirectTo = "/library";
      try {
        const pendingInviteToken = sessionStorage.getItem("pending_invite_token");
        if (pendingInviteToken) {
          sessionStorage.removeItem("pending_invite_token");
          redirectTo = `/invite/${pendingInviteToken}`;
        }
      } catch {
        // ignore sessionStorage access errors
      }

      navigate({ to: session ? redirectTo : "/sign-in", replace: true });
    });
  }, [navigate]);
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      Finishing sign-in…
    </div>
  );
}