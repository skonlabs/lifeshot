import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/signup")({
  head: () => ({ meta: [{ title: "Create account — LifeShot" }] }),
  component: SignupPage,
});

function SignupPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: typeof window !== "undefined" ? `${window.location.origin}/app` : undefined },
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Check your email to confirm your account.");
    nav({ to: "/login" });
  };

  return (
    <div className="min-h-screen grid place-items-center bg-paper px-5">
      <div className="w-full max-w-md">
        <Link to="/" className="font-display text-2xl text-ink">LifeShot</Link>
        <h1 className="mt-8 font-display text-3xl text-ink">Start your memory vault</h1>
        <p className="mt-2 text-foreground/70">Free during private beta.</p>
        <form onSubmit={onSubmit} className="mt-6 space-y-3">
          <Input type="email" required placeholder="you@yourlife.com" value={email} onChange={(e) => setEmail(e.target.value)} className="h-12 rounded-xl" />
          <Input type="password" required minLength={8} placeholder="Password (min 8 characters)" value={password} onChange={(e) => setPassword(e.target.value)} className="h-12 rounded-xl" />
          <Button type="submit" disabled={busy} className="h-12 w-full rounded-xl bg-ink text-paper hover:bg-ink/90">
            {busy ? "Creating…" : "Create account"}
          </Button>
        </form>
        <p className="mt-4 text-sm text-foreground/70">
          Have an account? <Link to="/login" className="text-ink underline">Sign in</Link>
        </p>
      </div>
      <Toaster position="top-center" />
    </div>
  );
}