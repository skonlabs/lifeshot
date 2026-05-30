import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { Aperture, ArrowUpRight, Cloud, HardDrive, MessageCircle, Smartphone, FileText, Users, Search, MapPin, Calendar, Shield, Sparkles, Lock, Star } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "LifeShot — The memory layer for everything you've ever lived" },
      {
        name: "description",
        content:
          "A personal memory platform that unifies photos, files, chats, and documents from every source you use — without moving a single file.",
      },
      { property: "og:title", content: "LifeShot — A memory atlas for your whole life" },
      {
        property: "og:description",
        content: "Index, search, and narrate every memory across your phone, clouds, chats, and archives. We never copy your files.",
      },
      { property: "og:url", content: "/" },
    ],
    links: [{ rel: "canonical", href: "/" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "LifeShot",
          applicationCategory: "LifestyleApplication",
          operatingSystem: "Web, iOS, Android",
          description:
            "A cross-source personal memory platform that indexes, organizes, and narrates a lifetime of memories without moving the original files.",
          offers: {
            "@type": "Offer",
            price: "0",
            priceCurrency: "USD",
          },
        }),
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-[color:var(--paper)] text-[color:var(--ink)] antialiased">
      <TopNav />
      <main>
        <Hero />
        <Manifesto />
        <SourcesStrip />
        <Lenses />
        <HowItWorks />
        <PrivacyPact />
        <FamilyAtlas />
        <Testimonial />
        <Pricing />
        <FAQ />
        <FinalCTA />
      </main>
      <Footer />
      <Toaster position="top-center" />
    </div>
  );
}

/* =========================================================================
 * Top navigation — slim editorial bar
 * ===================================================================== */
function TopNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-[color:var(--border)] bg-[color:var(--paper)]/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2">
          <Aperture className="h-5 w-5 text-[color:var(--ink)]" />
          <span className="font-serif-display text-xl text-[color:var(--ink)]">LifeShot</span>
        </Link>
        <nav className="hidden items-center gap-8 text-sm text-[color:var(--umber)] md:flex">
          <a href="#thesis" className="hover:text-[color:var(--ink)]">Why</a>
          <a href="#lenses" className="hover:text-[color:var(--ink)]">Lenses</a>
          <a href="#how" className="hover:text-[color:var(--ink)]">How it works</a>
          <a href="#privacy" className="hover:text-[color:var(--ink)]">Privacy</a>
          <a href="#pricing" className="hover:text-[color:var(--ink)]">Pricing</a>
        </nav>
        <div className="flex items-center gap-3">
          <Link to="/sign-in" className="text-sm text-[color:var(--umber)] hover:text-[color:var(--ink)]">Sign in</Link>
          <Link to="/sign-up" className="inline-flex items-center gap-1 rounded-full bg-[color:var(--ink)] px-4 py-2 text-sm font-medium text-[color:var(--paper)] hover:opacity-90">
            Start your archive <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}

/* =========================================================================
 * Hero — editorial split with a "memory ledger" column
 * ===================================================================== */
function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="surface-paper grain">
        <div className="mx-auto grid max-w-7xl gap-10 px-6 py-20 lg:grid-cols-[1.15fr_1fr] lg:gap-14 lg:py-32">
          <div>
            <div className="text-archive-label">Vol. I · The Personal Memory Platform</div>
            <h1 className="mt-5 font-serif-display text-[clamp(2.75rem,6vw,5.25rem)] leading-[0.98] text-[color:var(--ink)]">
              A lifetime of memories,
              <br />
              <span className="not-italic font-display font-medium">finally in one place —</span>
              <br />
              <span>without moving a single file.</span>
            </h1>
            <p className="mt-7 max-w-xl text-base leading-relaxed text-[color:var(--umber)]">
              Your memories live across phones, cloud drives, chat apps, old laptops, family
              members, and paper archives. LifeShot is the first platform that <em>indexes them
              where they are</em> — making your whole life searchable, organized, preserved,
              and narratable. We never copy your files.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link to="/sign-up" className="inline-flex items-center gap-2 rounded-full bg-[color:var(--ink)] px-5 py-3 text-sm font-medium text-[color:var(--paper)] hover:opacity-90">
                Start your archive <ArrowUpRight className="h-4 w-4" />
              </Link>
              <a href="#how" className="inline-flex items-center gap-2 rounded-full border border-[color:var(--border)] bg-[color:var(--paper-2)] px-5 py-3 text-sm font-medium text-[color:var(--ink)] hover:bg-[color:var(--paper)]">
                See how it works
              </a>
            </div>
            <p className="mt-5 text-[11px] uppercase tracking-[0.2em] text-[color:var(--umber)]">
              Private beta · End-to-end encrypted · Originals stay where they are
            </p>
          </div>

          {/* Memory Ledger */}
          <aside className="hairline relative rounded-lg border bg-[color:var(--paper)] p-6 shadow-[0_30px_60px_-30px_rgba(60,40,20,0.25)]">
            <div className="flex items-center justify-between border-b border-[color:var(--border)] pb-3">
              <span className="text-archive-label">memory ledger · today</span>
              <span className="font-serif-display text-sm italic text-[color:var(--umber)]">— curated for you</span>
            </div>
            <ul className="mt-4 space-y-4 text-sm">
              {[
                { icon: Smartphone, when: "1998 · Aug 14", what: "Grandparents' anniversary on the porch", where: "iPhone backup → indexed" },
                { icon: Cloud, when: "2007 · Mar", what: "A roll of film from Lisbon, rediscovered", where: "Google Photos · 142 frames" },
                { icon: MessageCircle, when: "2014 · Jul 03", what: '"Happy birthday Dad" — WhatsApp voice note', where: "Linked to Person: Marco" },
                { icon: HardDrive, when: "2019 · Dec 24", what: "Christmas videos from the old hard drive", where: "External SSD · 11.4 GB" },
                { icon: FileText, when: "2024 · Feb", what: "Lease, X-ray, and tax PDFs auto-filed", where: "Documents lens" },
              ].map((row, i) => (
                <li key={i} className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--paper-2)] text-[color:var(--umber)]">
                    <row.icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] uppercase tracking-wider text-[color:var(--umber)]">{row.when}</div>
                    <div className="truncate font-medium text-[color:var(--ink)]">{row.what}</div>
                    <div className="truncate text-xs text-[color:var(--umber)]">{row.where}</div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="ink-rule mt-5" />
            <div className="mt-4 flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-[color:var(--umber)]">
              <span>247,318 memories indexed</span>
              <span>9 sources · 0 copied</span>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
 * Manifesto — the thesis
 * ===================================================================== */
function Manifesto() {
  return (
    <section id="thesis" className="border-y border-[color:var(--border)] bg-[color:var(--paper-2)]/60">
      <div className="mx-auto grid max-w-7xl gap-12 px-6 py-24 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <div className="text-archive-label">The thesis</div>
          <h2 className="mt-2 font-serif-display text-4xl text-[color:var(--ink)]">A new category, not another silo.</h2>
        </div>
        <div className="lg:col-span-7 lg:col-start-6 space-y-6 text-lg leading-relaxed text-[color:var(--ink)]/85">
          <p>
            Photo apps see only their cloud. Drives see only their folders. Chat apps see only their threads.
            Your life is the <em>intersection</em> of all of it — and no product has ever sat at that intersection.
          </p>
          <p>
            LifeShot is a <strong>cross-source memory operating layer</strong>: it makes every memory you have
            <em> visible, searchable, organized, preserved, and narratable</em> — across every place you keep them.
          </p>
          <p className="font-serif-display text-2xl text-[color:var(--ink)]">
            Storage is solved. <span className="text-[color:var(--umber)]">Memory is not.</span>
          </p>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
 * Sources Strip — visual proof of unification
 * ===================================================================== */
function SourcesStrip() {
  const sources = [
    { name: "iPhone", kind: "device" },
    { name: "Android", kind: "device" },
    { name: "Google Photos", kind: "cloud" },
    { name: "iCloud", kind: "cloud" },
    { name: "Dropbox", kind: "cloud" },
    { name: "OneDrive", kind: "cloud" },
    { name: "WhatsApp", kind: "chat" },
    { name: "Messenger", kind: "chat" },
    { name: "Telegram", kind: "chat" },
    { name: "Old hard drives", kind: "archive" },
    { name: "SD cards", kind: "archive" },
    { name: "Scanned albums", kind: "archive" },
    { name: "Family shares", kind: "people" },
    { name: "Documents (PDF)", kind: "docs" },
    { name: "Email attachments", kind: "docs" },
    { name: "Voice notes", kind: "audio" },
  ];
  return (
    <section className="border-b border-[color:var(--border)] bg-[color:var(--paper)]">
      <div className="mx-auto max-w-7xl px-6 py-16">
        <div className="text-archive-label">Connects to</div>
        <div className="mt-6 flex flex-wrap gap-2.5">
          {sources.map((s) => (
            <span key={s.name} className="hairline rounded-full border bg-[color:var(--paper-2)] px-3.5 py-1.5 text-sm text-[color:var(--ink)]">
              {s.name}
              <span className="ml-2 text-[10px] uppercase tracking-wider text-[color:var(--umber)]">{s.kind}</span>
            </span>
          ))}
        </div>
        <p className="mt-6 max-w-2xl text-sm text-[color:var(--umber)]">
          Every connector is read-only by default. We index metadata and thumbnails — your originals
          never leave the source they live in.
        </p>
      </div>
    </section>
  );
}

/* =========================================================================
 * Lenses — the six ways to see your life
 * ===================================================================== */
function Lenses() {
  const lenses = [
    { icon: Search, name: "Atlas", line: "Your whole archive as one map.", body: "A single timeline across every device, cloud, and chat. Years collapse into a single river of memory." },
    { icon: Calendar, name: "Events", line: "Moments, automatically grouped.", body: "Trips, birthdays, holidays, performances — clustered by time, place, and who was there." },
    { icon: Users, name: "People", line: "The faces of your life.", body: "Recognize people across decades and devices, with consent. Rename, merge, hide — you stay in control." },
    { icon: MapPin, name: "Places", line: "Where it all happened.", body: "Geographic memory: cities, neighborhoods, homes you've lived in, trails you've walked." },
    { icon: FileText, name: "Documents", line: "The paper trail of a life.", body: "Receipts, leases, X-rays, certificates — searchable in plain English, never confused with photos." },
    { icon: Sparkles, name: "Narratives", line: "Your life, written back to you.", body: "Ask 'show me Christmas with my brother' or 'compose a chapter on 2014' — and get a story, not a folder." },
  ];
  return (
    <section id="lenses" className="border-b border-[color:var(--border)] bg-[color:var(--paper-2)]/40">
      <div className="mx-auto max-w-7xl px-6 py-24">
        <header className="mb-12 flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="text-archive-label">Six lenses</div>
            <h2 className="mt-2 max-w-2xl font-serif-display text-4xl text-[color:var(--ink)]">One archive. Six ways to look through it.</h2>
          </div>
          <p className="max-w-sm text-sm text-[color:var(--umber)]">
            Lenses are not folders. The same memory can appear in many lenses without ever being duplicated.
          </p>
        </header>
        <div className="grid gap-px overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--border)] md:grid-cols-2 lg:grid-cols-3">
          {lenses.map((l, i) => (
            <article key={l.name} className="group relative bg-[color:var(--paper)] p-8 transition-colors hover:bg-[color:var(--paper-2)]">
              <div className="flex items-center justify-between">
                <span className="text-archive-label">No. {String(i + 1).padStart(2, "0")}</span>
                <l.icon className="h-4 w-4 text-[color:var(--umber)]" />
              </div>
              <h3 className="mt-6 font-serif-display text-3xl text-[color:var(--ink)]">{l.name}</h3>
              <p className="mt-1 italic text-[color:var(--umber)]">{l.line}</p>
              <p className="mt-5 text-sm leading-relaxed text-[color:var(--ink)]/80">{l.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
 * How it works — three-step ritual
 * ===================================================================== */
function HowItWorks() {
  const steps = [
    { n: "I", title: "Connect, don't upload", body: "Authorize the sources you already use — phones, clouds, chats, archives. Read-only by default. Nothing is moved." },
    { n: "II", title: "We index, never copy", body: "We extract metadata, hashes, thumbnails, and (with your consent) AI captions. Originals stay where they are." },
    { n: "III", title: "Your life becomes searchable", body: "Find any moment in plain English. Group by event, person, or place. Narrate decades on demand." },
  ];
  return (
    <section id="how" className="border-b border-[color:var(--border)] bg-[color:var(--paper)]">
      <div className="mx-auto max-w-7xl px-6 py-24">
        <div className="grid gap-12 lg:grid-cols-[1fr_2fr]">
          <div>
            <div className="text-archive-label">The ritual</div>
            <h2 className="mt-2 font-serif-display text-4xl text-[color:var(--ink)]">How it works</h2>
          </div>
          <ol className="space-y-10">
            {steps.map((s) => (
              <li key={s.n} className="grid grid-cols-[auto_1fr] gap-6 border-b border-[color:var(--border)] pb-10 last:border-0 last:pb-0">
                <span className="font-serif-display text-5xl italic leading-none text-[color:var(--umber)]">{s.n}</span>
                <div>
                  <h3 className="font-display text-xl text-[color:var(--ink)]">{s.title}</h3>
                  <p className="mt-2 max-w-xl text-[color:var(--ink)]/75">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
 * Privacy pact
 * ===================================================================== */
function PrivacyPact() {
  const tenets = [
    { icon: Lock, title: "Originals never move", body: "We index in place. Your photos stay in iCloud; your chats stay in WhatsApp. We hold pointers, not files." },
    { icon: Shield, title: "AI is opt-in, per scope", body: "Face recognition, captions, summaries — each requires a separate consent. Default is off." },
    { icon: Sparkles, title: "Export and delete in one click", body: "Take your index with you, or erase every derived artifact we've generated. No retention games." },
  ];
  return (
    <section id="privacy" className="bg-[color:var(--ink)] text-[color:var(--paper)]">
      <div className="mx-auto max-w-7xl px-6 py-24">
        <header className="mb-14 max-w-3xl">
          <div className="text-[11px] uppercase tracking-[0.2em] text-[color:var(--paper-2)]/60">The pact</div>
          <h2 className="mt-3 font-serif-display text-4xl text-[color:var(--paper)] md:text-5xl">
            Memories are the most intimate data a person owns. We treat them that way.
          </h2>
        </header>
        <div className="grid gap-px overflow-hidden rounded-lg bg-[color:var(--paper)]/15 md:grid-cols-3">
          {tenets.map((t) => (
            <div key={t.title} className="bg-[color:var(--ink)] p-8">
              <t.icon className="h-5 w-5 text-[color:var(--paper-2)]" />
              <h3 className="mt-5 font-display text-lg text-[color:var(--paper)]">{t.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[color:var(--paper-2)]/70">{t.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
 * Family atlas
 * ===================================================================== */
function FamilyAtlas() {
  return (
    <section className="border-b border-[color:var(--border)] bg-[color:var(--paper-2)]/60">
      <div className="mx-auto grid max-w-7xl gap-12 px-6 py-24 lg:grid-cols-2 lg:items-center">
        <div>
          <div className="text-archive-label">For families</div>
          <h2 className="mt-2 font-serif-display text-4xl text-[color:var(--ink)] md:text-5xl">
            Some memories belong to more than one person.
          </h2>
          <p className="mt-6 max-w-lg leading-relaxed text-[color:var(--ink)]/80">
            Invite parents, partners, siblings, children. Each person keeps their private archive — but
            a shared family layer lets you co-curate the moments that belong to everyone. Permissions are
            granular. Children's faces stay off by default. A legacy plan ensures memories outlive devices.
          </p>
          <div className="mt-8 flex flex-wrap gap-2">
            {["Owner", "Admin", "Member", "Child", "Guest", "Legacy contact"].map((r) => (
              <span key={r} className="hairline rounded-full border bg-[color:var(--paper)] px-3 py-1 text-xs text-[color:var(--ink)]">{r}</span>
            ))}
          </div>
        </div>
        <div className="hairline relative rounded-lg border bg-[color:var(--paper)] p-6">
          <div className="text-archive-label mb-4">The Henderson family · est. 1962</div>
          <ul className="divide-y divide-[color:var(--border)]">
            {[
              { name: "Marco Henderson", role: "owner", memories: "84,212" },
              { name: "Elena Henderson", role: "admin", memories: "61,907" },
              { name: "Lia (12)", role: "child", memories: "—" },
              { name: "Nonna Rosa", role: "legacy contact", memories: "12,348" },
            ].map((m) => (
              <li key={m.name} className="flex items-center justify-between py-3">
                <div>
                  <div className="font-medium text-[color:var(--ink)]">{m.name}</div>
                  <div className="text-[11px] uppercase tracking-wider text-[color:var(--umber)]">{m.role}</div>
                </div>
                <span className="font-serif-display text-sm italic text-[color:var(--umber)]">{m.memories} memories</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
 * Testimonial
 * ===================================================================== */
function Testimonial() {
  return (
    <section className="border-b border-[color:var(--border)] bg-[color:var(--paper)]">
      <div className="mx-auto max-w-4xl px-6 py-24 text-center">
        <div className="mx-auto inline-flex items-center gap-1 text-[color:var(--clay)]">
          {[...Array(5)].map((_, i) => <Star key={i} className="h-3.5 w-3.5 fill-current" />)}
        </div>
        <blockquote className="mt-6 font-serif-display text-3xl leading-tight text-[color:var(--ink)] md:text-4xl">
          "I found a photo of my mother holding me as a baby. It was on an old hard drive I hadn't
          plugged in for fifteen years. LifeShot just <em>knew</em> it was her."
        </blockquote>
        <div className="mt-6 text-[11px] uppercase tracking-[0.2em] text-[color:var(--umber)]">
          Anya R. · Lisbon · private beta
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
 * Pricing
 * ===================================================================== */
function Pricing() {
  const tiers = [
    {
      name: "Atlas",
      price: "Free",
      tag: "Always",
      body: "Connect up to 3 sources. Index 25,000 memories. Search, lenses, basic narratives.",
      cta: "Start free",
    },
    {
      name: "Archive",
      price: "$9",
      cadence: "/ month",
      tag: "Most chosen",
      body: "Unlimited sources and memories. Full AI: face recognition, captions, summaries, narratives.",
      cta: "Begin Archive",
      featured: true,
    },
    {
      name: "Legacy",
      price: "$19",
      cadence: "/ month",
      tag: "For families",
      body: "Everything in Archive, for the whole family. Shared albums, child safeguards, succession plan.",
      cta: "Plan a legacy",
    },
  ];
  return (
    <section id="pricing" className="border-b border-[color:var(--border)] bg-[color:var(--paper-2)]/50">
      <div className="mx-auto max-w-7xl px-6 py-24">
        <header className="mb-14 max-w-2xl">
          <div className="text-archive-label">Pricing</div>
          <h2 className="mt-2 font-serif-display text-4xl text-[color:var(--ink)]">Choose how far back you want to go.</h2>
        </header>
        <div className="grid gap-px overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--border)] md:grid-cols-3">
          {tiers.map((t) => (
            <div key={t.name} className={(t.featured ? "bg-[color:var(--ink)] text-[color:var(--paper)]" : "bg-[color:var(--paper)] text-[color:var(--ink)]") + " p-8 flex flex-col"}>
              <div className="flex items-center justify-between">
                <span className={"text-[11px] uppercase tracking-[0.2em] " + (t.featured ? "text-[color:var(--paper-2)]/70" : "text-[color:var(--umber)]")}>{t.tag}</span>
                <span className="font-serif-display text-xl italic">{t.name}</span>
              </div>
              <div className="mt-6 flex items-baseline gap-1">
                <span className="font-serif-display text-5xl">{t.price}</span>
                {t.cadence && <span className={"text-sm " + (t.featured ? "text-[color:var(--paper-2)]/70" : "text-[color:var(--umber)]")}>{t.cadence}</span>}
              </div>
              <p className={"mt-4 text-sm leading-relaxed " + (t.featured ? "text-[color:var(--paper-2)]/80" : "text-[color:var(--ink)]/80")}>{t.body}</p>
              <Link
                to="/sign-up"
                className={"mt-auto inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-sm font-medium pt-3 mt-8 " + (t.featured ? "bg-[color:var(--paper)] text-[color:var(--ink)] hover:opacity-90" : "border border-[color:var(--ink)] text-[color:var(--ink)] hover:bg-[color:var(--ink)] hover:text-[color:var(--paper)] transition-colors")}
              >
                {t.cta}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
 * FAQ
 * ===================================================================== */
function FAQ() {
  const qa = [
    { q: "Do you copy or move my files?", a: "No. LifeShot indexes in place. We hold metadata, hashes, and thumbnails — the originals stay in the source you connected." },
    { q: "How is this different from Google Photos or iCloud?", a: "Those are silos: each only sees its own storage. LifeShot is the layer above all of them, including your phone, drives, chats, and archives." },
    { q: "What about deceased relatives and digital legacy?", a: "Legacy contacts can be designated per family. When the time comes, an appointed person inherits the archive — or your data is sealed, your choice." },
    { q: "Where does the AI run? Is my data used to train models?", a: "AI runs in a private inference environment scoped to your account. Your memories are never used to train shared models." },
    { q: "Can I leave?", a: "Yes — export every artifact in one click, then erase. We retain nothing." },
  ];
  return (
    <section className="border-b border-[color:var(--border)] bg-[color:var(--paper)]">
      <div className="mx-auto grid max-w-7xl gap-12 px-6 py-24 lg:grid-cols-[1fr_2fr]">
        <div>
          <div className="text-archive-label">Questions</div>
          <h2 className="mt-2 font-serif-display text-4xl text-[color:var(--ink)]">Things people ask before trusting us with a life.</h2>
        </div>
        <dl className="divide-y divide-[color:var(--border)]">
          {qa.map((x) => (
            <div key={x.q} className="py-6">
              <dt className="font-display text-lg text-[color:var(--ink)]">{x.q}</dt>
              <dd className="mt-2 max-w-2xl text-[color:var(--ink)]/75">{x.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* =========================================================================
 * Final CTA
 * ===================================================================== */
function FinalCTA() {
  return (
    <section className="surface-paper grain border-b border-[color:var(--border)]">
      <div className="mx-auto max-w-5xl px-6 py-28 text-center">
        <div className="text-archive-label">Begin</div>
        <h2 className="mx-auto mt-4 max-w-3xl font-serif-display text-[clamp(2.5rem,5vw,4.5rem)] leading-tight text-[color:var(--ink)]">
          The day you start your archive is the day your memory stops being lost.
        </h2>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link to="/sign-up" className="inline-flex items-center gap-2 rounded-full bg-[color:var(--ink)] px-6 py-3 text-sm font-medium text-[color:var(--paper)]">
            Start your archive <ArrowUpRight className="h-4 w-4" />
          </Link>
          <Link to="/sign-in" className="text-sm text-[color:var(--umber)] hover:text-[color:var(--ink)]">
            I already have an account
          </Link>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
 * Footer
 * ===================================================================== */
function Footer() {
  return (
    <footer className="bg-[color:var(--paper)]">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-10 text-sm text-[color:var(--umber)]">
        <div className="flex items-center gap-2">
          <Aperture className="h-4 w-4" />
          <span className="font-serif-display text-base text-[color:var(--ink)]">LifeShot</span>
          <span className="ml-3 text-[11px] uppercase tracking-[0.2em]">A personal memory platform · est. 2026</span>
        </div>
        <div className="flex items-center gap-6">
          <a href="#privacy" className="hover:text-[color:var(--ink)]">Privacy</a>
          <a href="#pricing" className="hover:text-[color:var(--ink)]">Pricing</a>
          <Link to="/sign-in" className="hover:text-[color:var(--ink)]">Sign in</Link>
        </div>
      </div>
    </footer>
  );
}
