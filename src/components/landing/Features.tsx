import { Brain, BookHeart, Users, Clock } from "lucide-react";
import { SectionHeader } from "./SectionHeader";

const features = [
  {
    icon: Brain,
    title: "AI auto-organize",
    body: "Drop in photos, voice notes, and scribbles. LifeShot quietly tags people, places, and themes — no manual albums.",
  },
  {
    icon: BookHeart,
    title: "A private journal",
    body: "Write a line a day or a long letter to yourself. Encrypted on your device, surfaced when you need it.",
  },
  {
    icon: Users,
    title: "Shared family circles",
    body: "Invite the people who matter into a quiet, ad-free space to add their own moments to the story.",
  },
  {
    icon: Clock,
    title: "Lifetime timeline",
    body: "A scrollable history of your life, from yesterday back to your earliest memory — preserved for the long haul.",
  },
];

export function Features() {
  return (
    <section id="features" className="py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionHeader
          eyebrow="Features"
          title={<>Four ways LifeShot <span className="italic font-normal">remembers for you.</span></>}
          description="One quiet place for everything worth keeping — built around your life, not an algorithm's feed."
        />
        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {features.map((f, i) => (
            <div
              key={f.title}
              className="group relative rounded-2xl border border-border bg-paper p-6 hover:shadow-[0_20px_50px_-20px_rgba(17,17,17,0.2)] transition-all duration-300 hover:-translate-y-0.5"
            >
              <div className="h-11 w-11 rounded-xl bg-gold/15 grid place-items-center mb-5">
                <f.icon size={20} className="text-ink" />
              </div>
              <h3 className="font-display text-lg font-semibold text-ink">{f.title}</h3>
              <p className="mt-2 text-sm text-foreground/70 leading-relaxed">{f.body}</p>
              <div className="absolute top-6 right-6 text-xs text-foreground/30 font-display">0{i + 1}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}