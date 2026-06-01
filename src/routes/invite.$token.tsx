import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api/client";

export const Route = createFileRoute("/invite/$token")({ component: AcceptInvite });

type State = "loading" | "needs_auth" | "ready" | "accepted" | "error";

function AcceptInvite() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<State>("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        // Stash the token so the sign-in flow can come back here.
        try { sessionStorage.setItem("pending_invite_token", token); } catch { /* ignore */ }
        setState("needs_auth");
        return;
      }
      setState("ready");
    })();
  }, [token]);

  async function accept() {
    try {
      setState("loading");
      const res = await api.families<{ family_id: string }>(`/accept/${token}`, { method: "POST", body: {} });
      setMessage(`You're now part of the family.`);
      setState("accepted");
      setTimeout(() => navigate({ to: "/family" }), 1200);
      return res;
    } catch (e) {
      setMessage((e as Error).message);
      setState("error");
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6 py-10 text-center">
      <span className="text-archive-label">family invitation</span>
      <h1 className="mt-2 font-serif-display text-3xl text-[color:var(--ink)]">You've been invited</h1>

      {state === "loading" && <p className="mt-6 text-sm text-[color:var(--umber)]">Checking your invite…</p>}

      {state === "needs_auth" && (
        <>
          <p className="mt-4 text-sm text-[color:var(--umber)]">Sign in to accept this invitation. We'll bring you back here.</p>
          <Link to="/sign-in" className="mx-auto mt-6 rounded-full bg-[color:var(--ink)] px-5 py-2 text-sm text-[color:var(--paper)]">Sign in</Link>
        </>
      )}

      {state === "ready" && (
        <>
          <p className="mt-4 text-sm text-[color:var(--umber)]">Join the shared archive — your memories will mingle with theirs, on your terms.</p>
          <button onClick={accept} className="mx-auto mt-6 rounded-full bg-[color:var(--ink)] px-6 py-2 text-sm font-medium text-[color:var(--paper)] hover:bg-[color:var(--umber)]">Accept invitation</button>
        </>
      )}

      {state === "accepted" && <p className="mt-6 text-sm text-emerald-700">{message}</p>}
      {state === "error" && (
        <>
          <p className="mt-6 text-sm text-destructive">{message ?? "Could not accept invitation."}</p>
          <Link to="/family" className="mx-auto mt-4 text-sm underline text-[color:var(--umber)]">Go to family settings</Link>
        </>
      )}
    </div>
  );
}