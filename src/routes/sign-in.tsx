import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { signInWithPasswordServer } from "@/lib/auth/password-auth.functions";
import { toast } from "sonner";
import { Aperture } from "lucide-react";

export const Route = createFileRoute("/sign-in")({
  validateSearch: (s: Record<string, unknown>) => ({
    redirect: sanitizeRedirect(typeof s.redirect === "string" ? s.redirect : "/library"),
  }),
  component: SignIn,
});

function sanitizeRedirect(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/library";
  if (value.startsWith("/sign-in") || value.startsWith("/sign-up") || value.startsWith("/callback")) {
    return "/library";
  }
  return value;
}

function SignIn() {
  const navigate = useNavigate();
  const signInWithPassword = useServerFn(signInWithPasswordServer);
  const search = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const session = await signInWithPassword({
        data: { email, password },
      });

      if (!session.ok) {
        toast.error(session.message);
        return;
      }

      const { error } = await supabase.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });

      if (error) {
        toast.error(error.message);
        return;
      }

      const { data: refreshed } = await supabase.auth.getSession();
      if (!refreshed.session) {
        toast.error("Sign in failed");
        return;
      }

      window.location.replace(search.redirect);
      return;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  async function signInWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/callback` },
    });
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="relative hidden flex-col justify-between bg-[color:var(--ink)] p-12 text-[color:var(--paper)] lg:flex">
        <div className="flex items-center gap-2">
          <Aperture className="h-5 w-5" />
          <span className="font-serif-display text-xl">LifeShot</span>
        </div>
        <div className="space-y-4">
          <p className="font-serif-display text-4xl leading-tight">Your memories, finally in one place — without moving a single file.</p>
          <p className="max-w-sm text-sm text-[color:var(--paper-2)]/70">A memory atlas across your phone, clouds, chats, and archives. We index, never copy.</p>
        </div>
        <p className="text-[11px] uppercase tracking-[0.2em] text-[color:var(--paper-2)]/50">A personal memory platform · est. 2026</p>
      </aside>
      <main className="flex items-center justify-center bg-[color:var(--paper)] px-6 py-12">
        <div className="w-full max-w-sm space-y-8">
          <div className="lg:hidden flex items-center gap-2 text-[color:var(--ink)]">
            <Aperture className="h-5 w-5" />
            <span className="font-serif-display text-xl">LifeShot</span>
          </div>
          <div>
            <div className="text-archive-label">welcome back</div>
            <h1 className="mt-1 font-serif-display text-3xl text-[color:var(--ink)]">Sign in to your archive</h1>
          </div>
          <form onSubmit={onSubmit} className="space-y-3">
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-2.5 text-sm" />
            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-2.5 text-sm" />
            <button type="submit" disabled={loading} className="w-full rounded-full bg-[color:var(--ink)] px-3 py-2.5 text-sm font-medium text-[color:var(--paper)] disabled:opacity-50">
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <div className="relative">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-[color:var(--border)]" /></div>
            <div className="relative flex justify-center text-[11px] uppercase tracking-wider"><span className="bg-[color:var(--paper)] px-2 text-[color:var(--umber)]">or</span></div>
          </div>
          <button onClick={signInWithGoogle} className="w-full rounded-full border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-2.5 text-sm font-medium text-[color:var(--ink)] hover:bg-[color:var(--paper)]">
            Continue with Google
          </button>
          <p className="text-center text-sm text-[color:var(--umber)]">
            New here? <a href="/sign-up" className="text-[color:var(--ink)] underline underline-offset-4">Start your archive</a>
          </p>
        </div>
      </main>
    </div>
  );
}