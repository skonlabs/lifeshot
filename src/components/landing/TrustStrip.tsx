import { Lock, Sparkles, Infinity as InfinityIcon, Users } from "lucide-react";

const items = [
  { icon: Lock, label: "End-to-end encrypted" },
  { icon: Sparkles, label: "AI that respects privacy" },
  { icon: Users, label: "Invite-only family circles" },
  { icon: InfinityIcon, label: "Yours forever" },
];

export function TrustStrip() {
  return (
    <section className="border-y border-border/60 bg-paper-2/40">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 py-6 grid grid-cols-2 md:grid-cols-4 gap-4">
        {items.map((it) => (
          <div key={it.label} className="flex items-center gap-2.5 text-sm text-foreground/70">
            <it.icon size={16} className="text-gold shrink-0" />
            <span>{it.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}