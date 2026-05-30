import { SectionHeader } from "./SectionHeader";

const steps = [
  {
    n: "01",
    title: "Capture",
    body: "Snap a photo, dictate a note, or forward an email. LifeShot accepts anything that matters to you.",
  },
  {
    n: "02",
    title: "Organize",
    body: "Our AI weaves it into your timeline — by date, place, person, and feeling. You stay in control.",
  },
  {
    n: "03",
    title: "Relive",
    body: "Beautiful resurfaces on the anniversaries, milestones, and quiet evenings that need them most.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="py-24 sm:py-32 bg-paper-2/50 border-y border-border/60">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionHeader
          eyebrow="How it works"
          align="center"
          title={<>From scattered moments to a story <span className="italic font-normal">you'll want to read.</span></>}
        />
        <div className="mt-14 grid md:grid-cols-3 gap-8 md:gap-6 relative">
          <div className="hidden md:block absolute top-7 left-[16%] right-[16%] h-px bg-gradient-to-r from-transparent via-gold/60 to-transparent" />
          {steps.map((s) => (
            <div key={s.n} className="text-center md:text-left relative">
              <div className="inline-flex items-center justify-center h-14 w-14 rounded-full border-2 border-gold bg-paper font-display text-gold font-semibold text-lg">
                {s.n}
              </div>
              <h3 className="mt-5 font-display text-xl font-semibold text-ink">{s.title}</h3>
              <p className="mt-2 text-sm text-foreground/70 leading-relaxed max-w-xs mx-auto md:mx-0">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}