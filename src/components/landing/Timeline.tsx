import { SectionHeader } from "./SectionHeader";

const years = [
  { year: "1998", title: "First steps", note: "Backyard, golden hour. Grandma's polaroid." },
  { year: "2006", title: "Summer at the lake", note: "37 photos · 2 voice notes" },
  { year: "2014", title: "Graduation", note: "Letter from Dad · cap & gown" },
  { year: "2019", title: "Wedding day", note: "120 photos · vows recording" },
  { year: "2023", title: "She was born", note: "Hospital morning · first hello" },
  { year: "Today", title: "Pancakes & pajamas", note: "1 photo · 1 line journal" },
];

export function Timeline() {
  return (
    <section className="py-24 sm:py-32 bg-paper-2/50 border-y border-border/60 overflow-hidden">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <SectionHeader
          eyebrow="A lifetime, scrollable"
          title={<>Your story, <span className="italic font-normal">on a single beautiful timeline.</span></>}
          description="Zoom out to see decades. Zoom in to relive a Tuesday afternoon."
        />
      </div>
      <div className="mt-12 relative">
        <div className="absolute top-1/2 inset-x-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
        <div className="overflow-x-auto pb-6 [scrollbar-width:thin]">
          <ol className="flex gap-5 px-5 sm:px-8 min-w-max">
            {years.map((y, i) => (
              <li
                key={y.year}
                className="w-64 shrink-0 rounded-2xl border border-border bg-paper p-5 shadow-sm relative"
                style={{ transform: `translateY(${i % 2 === 0 ? "-8px" : "8px"})` }}
              >
                <div className="font-display text-2xl text-gold font-semibold">{y.year}</div>
                <div className="mt-2 font-medium text-ink">{y.title}</div>
                <div className="mt-1 text-sm text-foreground/60">{y.note}</div>
                <div className="absolute -bottom-[7px] left-6 h-3 w-3 rounded-full bg-gold border-2 border-paper-2" />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}