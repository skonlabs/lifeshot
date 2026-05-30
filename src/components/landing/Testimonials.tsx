import { SectionHeader } from "./SectionHeader";

const quotes = [
  {
    q: "I finally have one place for the photos, the voice notes, the messy little notes-to-self. It feels like a real journal again.",
    name: "Maya R.",
    role: "Writer · Lisbon",
  },
  {
    q: "We started a family circle for my parents' 40th. They cried. I think we'll never stop adding to it.",
    name: "Daniel K.",
    role: "Dad of two · Berlin",
  },
  {
    q: "It's the first app that feels like it's on my side. Quiet, beautiful, private. Like a notebook with a soul.",
    name: "Aiko S.",
    role: "Designer · Kyoto",
  },
];

export function Testimonials() {
  return (
    <section className="py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionHeader
          eyebrow="Loved by early users"
          title={<>People keep saying the same thing: <span className="italic font-normal">finally.</span></>}
        />
        <div className="mt-12 grid md:grid-cols-3 gap-5">
          {quotes.map((t) => (
            <figure
              key={t.name}
              className="rounded-2xl border border-border bg-paper p-7 flex flex-col"
            >
              <div className="text-gold font-display text-3xl leading-none">&ldquo;</div>
              <blockquote className="mt-3 text-foreground/80 leading-relaxed">
                {t.q}
              </blockquote>
              <figcaption className="mt-6 pt-5 border-t border-border/60">
                <div className="font-medium text-ink">{t.name}</div>
                <div className="text-xs text-foreground/60">{t.role}</div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}