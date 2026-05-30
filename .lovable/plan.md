# LifeShot — Landing Page Plan

A responsive, frontend-only marketing page for **LifeShot**, a Personal Memory Platform. Positioning combines all four angles: an AI-powered memory vault that doubles as a private journal, a shared family space, and a lifelong legacy timeline.

> Note: Supabase and a GitHub repo are NOT created in this step — landing pages don't need a backend. We'll wire those in when we build the actual product (auth, uploads, timeline). Please revoke the PAT you pasted in chat.

## Design system

- **Palette** (added as oklch tokens in `src/styles.css`):
  - Background `#FAFAF7`, Foreground `#1E293B`
  - Primary `#111111` (ink), Accent gold `#D6B25E`, Secondary teal `#14B8A6`
- **Typography**: Outfit (display/headings) + Figtree (body), loaded via Google Fonts in `__root.tsx`
- **Mood**: editorial + warm, generous whitespace, soft shadows, subtle film-grain texture, gold hairline dividers, rounded-2xl cards

## Page sections (single route `/`)

1. **Sticky nav** — wordmark, links (Features, How it works, Family, Pricing, FAQ), "Get early access" CTA
2. **Hero** — large serif-feel Outfit headline ("Every moment. Beautifully remembered."), subhead, email capture + secondary CTA, hero collage of memory cards (generated image)
3. **Trust strip** — short tagline + soft badges (Private by default · End-to-end encrypted · Yours forever)
4. **Features grid (4 cards)** — AI auto-organize · Private journal · Shared family albums · Lifetime timeline
5. **How it works (3 steps)** — Capture → Organize → Relive, with numbered gold markers
6. **Family/shared space section** — split layout, image + copy about invite-only circles
7. **Legacy timeline section** — horizontal scroll mock of a year-by-year timeline
8. **Testimonials** — 3 quote cards
9. **Pricing teaser** — Free / Plus / Family, simple cards
10. **FAQ accordion** — 5–6 questions
11. **Footer CTA + footer** — email capture, social, legal

All CTAs are visual only (no backend). Email field shows a toast confirming "You're on the list".

## Technical details

- Single route file: replace placeholder in `src/routes/index.tsx`
- Add SEO meta (title <60ch, description <160ch, og tags, JSON-LD `SoftwareApplication`)
- Components split under `src/components/landing/` (Nav, Hero, Features, HowItWorks, Family, Timeline, Testimonials, Pricing, FAQ, Footer)
- Use existing shadcn primitives (Button, Card, Accordion, Input, Badge, Sonner toast)
- Animations via `framer-motion` (already an option) — subtle fade/slide on scroll only
- Generate 2 hero/section images with imagegen (warm, analog memory aesthetic) into `src/assets/`
- Fully responsive: mobile-first, breakpoints sm/md/lg
- Accessibility: semantic landmarks, single H1, alt text, focus styles, reduced-motion respected

## Out of scope (for later turns)

- Supabase auth, database, file uploads
- GitHub repo creation (use the GitHub connector in Lovable settings when ready)
- Actual email capture backend
