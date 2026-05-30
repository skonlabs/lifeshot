import { motion } from "framer-motion";
import { EmailCapture } from "./EmailCapture";
import heroImg from "@/assets/hero-collage.jpg";

export function Hero() {
  return (
    <section id="top" className="relative pt-28 sm:pt-36 pb-16 sm:pb-24 overflow-hidden">
      <div className="absolute inset-0 -z-10 grain" />
      <div
        className="absolute -top-32 -left-32 -z-10 h-[420px] w-[420px] rounded-full opacity-40 blur-3xl"
        style={{ background: "radial-gradient(closest-side, color-mix(in oklab, var(--gold) 50%, transparent), transparent)" }}
      />
      <div
        className="absolute -bottom-32 -right-32 -z-10 h-[420px] w-[420px] rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(closest-side, color-mix(in oklab, var(--teal) 40%, transparent), transparent)" }}
      />

      <div className="mx-auto max-w-6xl px-5 sm:px-8 grid lg:grid-cols-[1.05fr_1fr] gap-12 lg:gap-16 items-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-paper/60 backdrop-blur px-3 py-1 text-xs text-foreground/70">
            <span className="h-1.5 w-1.5 rounded-full bg-gold" />
            Private beta — opening soon
          </div>
          <h1 className="mt-5 font-display text-4xl sm:text-5xl lg:text-6xl font-semibold leading-[1.05] text-ink">
            Every moment.
            <br />
            <span className="italic font-normal text-foreground/80">Beautifully </span>
            <span className="relative inline-block">
              remembered.
              <svg
                aria-hidden
                viewBox="0 0 200 12"
                className="absolute left-0 -bottom-2 w-full h-2 text-gold"
                preserveAspectRatio="none"
              >
                <path
                  d="M2 8 Q 50 2 100 6 T 198 5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </h1>
          <p className="mt-6 text-lg text-foreground/70 max-w-xl leading-relaxed">
            LifeShot is your private memory platform. Capture photos, notes, and voices —
            our AI quietly organizes a beautiful timeline of your life, ready to share
            with the people you love.
          </p>
          <div className="mt-8">
            <EmailCapture size="lg" />
            <p className="mt-3 text-xs text-foreground/60">
              Free during beta · No credit card · Cancel any time
            </p>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
          className="relative"
        >
          <div className="absolute -inset-4 rounded-[2rem] bg-gradient-to-br from-gold/20 via-transparent to-teal/15 blur-2xl" />
          <div className="relative rounded-2xl overflow-hidden shadow-[0_30px_80px_-30px_rgba(17,17,17,0.35)] border border-border bg-paper-2">
            <img
              src={heroImg}
              alt="A collage of polaroid family photos, handwritten notes, and pressed flowers on warm paper."
              width={1536}
              height={1280}
              className="w-full h-auto object-cover"
            />
          </div>
          <div className="absolute -bottom-4 -left-4 sm:-left-8 rounded-xl bg-paper border border-border shadow-lg px-4 py-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-gold/20 grid place-items-center">
              <span className="text-gold font-display font-semibold">12</span>
            </div>
            <div>
              <div className="text-xs text-foreground/60">This week</div>
              <div className="text-sm font-medium text-ink">new memories</div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}