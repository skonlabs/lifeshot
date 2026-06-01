import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { Aperture } from "lucide-react";

export const Route = createFileRoute("/sign-up")({ component: SignUp });

function SignUp() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email, password,
      options: { emailRedirectTo: `${window.location.origin}/callback` },
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Check your email to confirm");
    navigate({ to: "/sign-in", search: { redirect: "/onboarding" } });
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="relative hidden flex-col justify-between bg-[color:var(--ink)] p-12 text-[color:var(--paper)] lg:flex">
        <div className="flex items-center gap-2">
          <Aperture className="h-5 w-5" />
          <span className="font-serif-display text-xl">LifeShot</span>
        </div>
        <div className="space-y-4">
          <p className="font-serif-display text-4xl leading-tight">Begin your memory atlas.</p>
          <p className="max-w-sm text-sm text-[color:var(--paper-2)]/70">Connect phones, clouds, messages, and old hard drives. We index them in place — your files stay where they are.</p>
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
            <div className="text-archive-label">create account</div>
            <h1 className="mt-1 font-serif-display text-3xl text-[color:var(--ink)]">Start your archive</h1>
          </div>
          <form onSubmit={onSubmit} className="space-y-3">
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-2.5 text-sm" />
            <input type="password" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--paper-2)] px-3 py-2.5 text-sm" />
            <button type="submit" disabled={loading} className="w-full rounded-full bg-[color:var(--ink)] px-3 py-2.5 text-sm font-medium text-[color:var(--paper)] disabled:opacity-50">
              {loading ? "Creating…" : "Create account"}
            </button>
          </form>
          <p className="text-center text-sm text-[color:var(--umber)]">
            Already here? <a href="/sign-in" className="text-[color:var(--ink)] underline underline-offset-4">Sign in</a>
          </p>
        </div>
      </main>
    </div>
  );
}