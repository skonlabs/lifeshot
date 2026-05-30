import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { Camera } from "lucide-react";

export const Route = createFileRoute("/sign-in")({
  validateSearch: (s: Record<string, unknown>) => ({
    redirect: typeof s.redirect === "string" ? s.redirect : "/library",
  }),
  beforeLoad: async ({ search }) => {
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: search.redirect });
  },
  component: SignIn,
});

function SignIn() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    navigate({ to: search.redirect });
  }

  async function signInWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/callback` },
    });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-center gap-2">
          <Camera className="h-6 w-6 text-primary" />
          <span className="font-display text-2xl font-semibold">LifeShot</span>
        </div>
        <h1 className="text-center text-xl font-semibold">Sign in</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          <button type="submit" disabled={loading} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50">
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="relative">
          <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
          <div className="relative flex justify-center text-xs"><span className="bg-background px-2 text-muted-foreground">or</span></div>
        </div>
        <button onClick={signInWithGoogle} className="w-full rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-accent">
          Continue with Google
        </button>
        <p className="text-center text-sm text-muted-foreground">
          New here? <a href="/sign-up" className="text-primary hover:underline">Create an account</a>
        </p>
      </div>
    </div>
  );
}