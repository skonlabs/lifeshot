import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — LifeShot" }] }),
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return toast.error(error.message);
    nav({ to: "/app" });
  };

  return (
    <div className="min-h-screen grid place-items-center bg-paper px-5">
      <div className="w-full max-w-md">
        <Link to="/" className="font-display text-2xl text-ink">LifeShot</Link>
        <h1 className="mt-8 font-display text-3xl text-ink">Welcome back</h1>
        <p className="mt-2 text-foreground/70">Sign in to your memory vault.</p>
        <form onSubmit={onSubmit} className="mt-6 space-y-3">
          <Input type="email" required placeholder="you@yourlife.com" value={email} onChange={(e) => setEmail(e.target.value)} className="h-12 rounded-xl" />
          <Input type="password" required placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-12 rounded-xl" />
          <Button type="submit" disabled={busy} className="h-12 w-full rounded-xl bg-ink text-paper hover:bg-ink/90">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="mt-4 text-sm text-foreground/70">
          New here? <Link to="/signup" className="text-ink underline">Create an account</Link>
        </p>
      </div>
      <Toaster position="top-center" />
    </div>
  );
}