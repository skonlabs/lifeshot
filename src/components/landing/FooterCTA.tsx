import { EmailCapture } from "./EmailCapture";

export function FooterCTA() {
  return (
    <section id="cta" className="py-24 sm:py-32 relative overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-ink" />
      <div
        className="absolute inset-0 -z-10 opacity-40"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 0%, color-mix(in oklab, var(--gold) 35%, transparent), transparent 70%)",
        }}
      />
      <div className="mx-auto max-w-3xl px-5 sm:px-8 text-center text-paper">
        <div className="inline-flex items-center gap-2 rounded-full border border-paper/15 px-3 py-1 text-xs text-paper/70">
          <span className="h-1.5 w-1.5 rounded-full bg-gold" />
          Join the LifeShot private beta
        </div>
        <h2 className="mt-5 font-display text-4xl sm:text-5xl font-semibold leading-tight">
          Start remembering, <span className="italic font-normal text-paper/80">beautifully.</span>
        </h2>
        <p className="mt-4 text-paper/70 text-lg">
          A quiet corner of the internet for the most important story of all — yours.
        </p>
        <div className="mt-8 flex justify-center">
          <EmailCapture size="lg" />
        </div>
        <p className="mt-3 text-xs text-paper/50">
          We'll only email you about LifeShot. No spam, ever.
        </p>
      </div>
    </section>
  );
}