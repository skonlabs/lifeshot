import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "./SectionHeader";

const tiers = [
  {
    name: "Free",
    price: "$0",
    blurb: "Start your timeline.",
    features: ["500 memories", "Personal journal", "Basic AI organize", "1 device"],
    cta: "Start free",
    highlight: false,
  },
  {
    name: "Plus",
    price: "$6",
    period: "/mo",
    blurb: "For a lifetime worth keeping.",
    features: ["Unlimited memories", "Advanced AI resurfaces", "Voice & video notes", "All devices, end-to-end encrypted"],
    cta: "Go Plus",
    highlight: true,
  },
  {
    name: "Family",
    price: "$12",
    period: "/mo",
    blurb: "Up to 6 people.",
    features: ["Everything in Plus", "6 family members", "Shared circles & albums", "Legacy export & inheritance"],
    cta: "Bring the family",
    highlight: false,
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="py-24 sm:py-32 bg-paper-2/40 border-y border-border/60">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionHeader
          eyebrow="Pricing"
          align="center"
          title={<>Honest pricing for <span className="italic font-normal">something you'll keep forever.</span></>}
        />
        <div className="mt-12 grid md:grid-cols-3 gap-5">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`relative rounded-2xl border p-7 bg-paper flex flex-col ${
                t.highlight
                  ? "border-ink shadow-[0_30px_60px_-30px_rgba(17,17,17,0.35)]"
                  : "border-border"
              }`}
            >
              {t.highlight && (
                <div className="absolute -top-3 left-7 rounded-full bg-gold px-3 py-1 text-xs font-medium text-ink">
                  Most loved
                </div>
              )}
              <div className="font-display text-lg font-semibold text-ink">{t.name}</div>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="font-display text-4xl font-semibold text-ink">{t.price}</span>
                {t.period && <span className="text-foreground/60">{t.period}</span>}
              </div>
              <p className="mt-2 text-sm text-foreground/70">{t.blurb}</p>
              <ul className="mt-6 space-y-2.5 flex-1">
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-foreground/80">
                    <Check size={16} className="mt-0.5 text-gold shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button
                asChild
                className={`mt-7 rounded-full ${
                  t.highlight
                    ? "bg-ink text-paper hover:bg-ink/90"
                    : "bg-transparent text-ink border border-ink hover:bg-ink hover:text-paper"
                }`}
              >
                <a href="#cta">{t.cta}</a>
              </Button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}