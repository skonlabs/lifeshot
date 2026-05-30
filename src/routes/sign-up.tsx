import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { Camera } from "lucide-react";

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
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-center gap-2">
          <Camera className="h-6 w-6 text-primary" />
          <span className="font-display text-2xl font-semibold">LifeShot</span>
        </div>
        <h1 className="text-center text-xl font-semibold">Create your account</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          <input type="password" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          <button type="submit" disabled={loading} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {loading ? "Creating…" : "Create account"}
          </button>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account? <a href="/sign-in" className="text-primary hover:underline">Sign in</a>
        </p>
      </div>
    </div>
  );
}