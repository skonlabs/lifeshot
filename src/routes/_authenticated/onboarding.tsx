import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { Check, Circle, Lock, Sparkles, Users, Link2, Search as SearchIcon } from "lucide-react";
import { useMe, useSourceAccounts, useUpdateMe } from "@/lib/api/hooks";

export const Route = createFileRoute("/_authenticated/onboarding")({ component: Onboarding });

type StepKey = "intro" | "connect" | "explore" | "invite";

const STEPS: Array<{ key: StepKey; title: string; copy: string; icon: any; cta: string; to: any }> = [
  { key: "intro",   title: "How LifeShot works",   copy: "We index, not store. The original always stays in your source.", icon: Lock,      cta: "Got it",         to: { to: "/onboarding", hash: "step-2" } },
  { key: "connect", title: "Connect your first source", copy: "Phone roll, cloud drive, or an old hard disk — we'll index quietly in the background.", icon: Link2,     cta: "Connect a source", to: { to: "/sources" } },
  { key: "explore", title: "Try a natural-language recall", copy: "Ask your archive anything: places, faces, captions, transcripts — all in one query.", icon: SearchIcon, cta: "Open recall",    to: { to: "/search" } },
  { key: "invite",  title: "Bring family in (optional)", copy: "Share chapters with siblings or parents — each person sees only what you allow.", icon: Users,    cta: "Open family",     to: { to: "/family" } },
];

function Onboarding() {
  const navigate = useNavigate();
  const me = useMe();
  const updateMe = useUpdateMe();
  const accounts = useSourceAccounts();

  const state = (me.data?.onboarding_state ?? {}) as Record<StepKey, boolean>;

  // Auto-mark connect step done once at least one source account exists.
  useEffect(() => {
    if (!me.data) return;
    if (!state.connect && (accounts.data?.accounts?.length ?? 0) > 0) {
      updateMe.mutate({ onboarding_state: { ...state, connect: true } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data, accounts.data]);

  const completedCount = useMemo(() => STEPS.filter((s) => state[s.key]).length, [state]);
  const allDone = completedCount === STEPS.length;

  function markDone(k: StepKey) {
    updateMe.mutate({ onboarding_state: { ...state, [k]: true } });
  }

  if (allDone) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-16 text-center">
        <span className="text-archive-label">you're all set</span>
        <h1 className="font-serif-display text-5xl text-[color:var(--ink)]">A lifetime, recalled on demand.</h1>
        <p className="text-sm text-[color:var(--umber)]">Your sources are syncing. Drop into the archive whenever you're ready.</p>
        <div className="flex justify-center gap-2">
          <button onClick={() => navigate({ to: "/library" })} className="rounded-full bg-[color:var(--ink)] px-5 py-2.5 text-sm font-medium text-[color:var(--paper)]">Open the archive</button>
          <button onClick={() => updateMe.mutate({ onboarding_state: {} })} className="rounded-full border border-[color:var(--border)] px-4 py-2.5 text-xs text-[color:var(--umber)]">Reset</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-12">
      <div className="text-center">
        <span className="text-archive-label">welcome</span>
        <h1 className="mt-2 font-serif-display text-5xl text-[color:var(--ink)]">Your memory atlas, opened.</h1>
        <p className="mt-3 text-sm text-[color:var(--umber)]">Four short steps. We pick up wherever you left off.</p>
        <div className="mt-4 inline-flex items-center gap-2 text-[11px] text-[color:var(--umber)]">
          <div className="h-1 w-32 overflow-hidden rounded-full bg-[color:var(--paper-2)]">
            <div className="h-full bg-[color:var(--ink)] transition-all" style={{ width: `${(completedCount / STEPS.length) * 100}%` }} />
          </div>
          {completedCount} / {STEPS.length}
        </div>
      </div>
      <ol className="space-y-3 text-sm">
        {STEPS.map((s, idx) => {
          const done = !!state[s.key];
          const Icon = s.icon;
          return (
            <li key={s.key} id={`step-${idx + 1}`} className={"hairline flex gap-3 rounded-lg border p-4 transition " + (done ? "bg-[color:var(--paper-2)] opacity-70" : "bg-[color:var(--paper)]")}>
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--border)] bg-[color:var(--paper)]">
                {done ? <Check className="h-3.5 w-3.5 text-[color:var(--ink)]" /> : <Icon className="h-3.5 w-3.5 text-[color:var(--umber)]" />}
              </div>
              <div className="flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <strong className={done ? "line-through" : ""}>{s.title}</strong>
                  <span className="text-[10px] uppercase tracking-wider text-[color:var(--umber)]">step {idx + 1}</span>
                </div>
                <p className="mt-1 text-[color:var(--umber)]">{s.copy}</p>
                {!done && (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => { markDone(s.key); if (s.to) navigate(s.to as any); }}
                      className="rounded-full bg-[color:var(--ink)] px-3 py-1.5 text-xs font-medium text-[color:var(--paper)]"
                    >
                      {s.cta}
                    </button>
                    <button onClick={() => markDone(s.key)} className="rounded-full px-3 py-1.5 text-xs text-[color:var(--umber)] hover:text-[color:var(--ink)]">
                      Skip
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center justify-between border-t pt-4 text-[11px] text-[color:var(--umber)]">
        <span className="inline-flex items-center gap-1.5"><Sparkles className="h-3 w-3" /> AI features stay off until you opt in.</span>
        <button onClick={() => navigate({ to: "/library" })} className="hover:text-[color:var(--ink)]">Skip onboarding →</button>
      </div>
    </div>
  );
}