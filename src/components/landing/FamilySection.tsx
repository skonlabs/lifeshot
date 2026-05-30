import { Check } from "lucide-react";
import { SectionHeader } from "./SectionHeader";
import familyImg from "@/assets/family-moment.jpg";

const bullets = [
  "Invite parents, partners, kids — anyone you trust.",
  "Everyone contributes; LifeShot weaves it into one story.",
  "Granular controls: what's shared, what stays yours.",
  "Built to last decades, exportable any time.",
];

export function FamilySection() {
  return (
    <section id="family" className="py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        <div className="relative order-2 lg:order-1">
          <div className="absolute -inset-3 rounded-3xl bg-gradient-to-tr from-gold/15 to-teal/10 blur-2xl" />
          <div className="relative rounded-2xl overflow-hidden border border-border shadow-[0_30px_60px_-30px_rgba(17,17,17,0.3)]">
            <img
              src={familyImg}
              alt="A multi-generational family looking at old photos and a tablet together in warm light."
              loading="lazy"
              width={1280}
              height={1280}
              className="w-full h-auto object-cover"
            />
          </div>
        </div>
        <div className="order-1 lg:order-2">
          <SectionHeader
            eyebrow="Together"
            title={<>The memories you keep are <span className="italic font-normal">the people you keep them with.</span></>}
            description="LifeShot's family circles are quiet, private spaces — no feeds, no likes, no strangers. Just the people in the photograph."
          />
          <ul className="mt-8 space-y-3">
            {bullets.map((b) => (
              <li key={b} className="flex items-start gap-3">
                <span className="mt-0.5 h-5 w-5 rounded-full bg-gold/20 grid place-items-center shrink-0">
                  <Check size={12} className="text-ink" />
                </span>
                <span className="text-foreground/80">{b}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}