import { useEffect, useState, type ReactNode } from "react";

const STORAGE_KEY = "site_gate_ok";
const USERNAME = "admin";
const PASSWORD = "ls@123";

export function SiteGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(false);
  const [ready, setReady] = useState(false);
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOk(window.localStorage.getItem(STORAGE_KEY) === "1");
      setReady(true);
    }
  }, []);

  if (!ready) return null;
  if (ok) return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (u === USERNAME && p === PASSWORD) {
            window.localStorage.setItem(STORAGE_KEY, "1");
            setOk(true);
          } else {
            setErr("Invalid credentials");
          }
        }}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-semibold text-foreground">Restricted access</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to continue.</p>
        </div>
        <div className="space-y-2">
          <input
            autoFocus
            value={u}
            onChange={(e) => setU(e.target.value)}
            placeholder="Username"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="password"
            value={p}
            onChange={(e) => setP(e.target.value)}
            placeholder="Password"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <button
          type="submit"
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Enter
        </button>
      </form>
    </div>
  );
}