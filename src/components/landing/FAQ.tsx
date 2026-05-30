import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { SectionHeader } from "./SectionHeader";

const faqs = [
  {
    q: "Is LifeShot really private?",
    a: "Yes. Memories are encrypted on your device before they leave it. We can't read your photos, notes, or journals — only you and the people you invite can.",
  },
  {
    q: "What happens to my memories if I stop paying?",
    a: "Your memories are always yours. You can export everything as standard files (photos, audio, markdown) at any time, on any plan.",
  },
  {
    q: "How does the AI work without seeing my data?",
    a: "Our organizing models run on-device whenever possible. When server processing is required, data is encrypted in transit and never used to train shared models.",
  },
  {
    q: "Can I import old photos and journals?",
    a: "Absolutely. Import from your camera roll, Google Photos, Apple Photos, and most journaling apps. We'll help you build a timeline that starts decades ago.",
  },
  {
    q: "What about after I'm gone?",
    a: "LifeShot Family includes a legacy plan: nominate trusted contacts who can inherit a read-only copy of your story when the time comes.",
  },
];

export function FAQ() {
  return (
    <section id="faq" className="py-24 sm:py-32">
      <div className="mx-auto max-w-3xl px-5 sm:px-8">
        <SectionHeader
          eyebrow="FAQ"
          align="center"
          title={<>Questions, <span className="italic font-normal">answered honestly.</span></>}
        />
        <Accordion type="single" collapsible className="mt-10">
          {faqs.map((f, i) => (
            <AccordionItem key={f.q} value={`item-${i}`} className="border-border">
              <AccordionTrigger className="text-left font-display text-base sm:text-lg text-ink hover:no-underline">
                {f.q}
              </AccordionTrigger>
              <AccordionContent className="text-foreground/70 leading-relaxed">
                {f.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}