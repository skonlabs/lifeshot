import { createFileRoute } from "@tanstack/react-router";
import { Nav } from "@/components/landing/Nav";
import { Hero } from "@/components/landing/Hero";
import { TrustStrip } from "@/components/landing/TrustStrip";
import { Features } from "@/components/landing/Features";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { FamilySection } from "@/components/landing/FamilySection";
import { Timeline } from "@/components/landing/Timeline";
import { Testimonials } from "@/components/landing/Testimonials";
import { Pricing } from "@/components/landing/Pricing";
import { FAQ } from "@/components/landing/FAQ";
import { FooterCTA } from "@/components/landing/FooterCTA";
import { Footer } from "@/components/landing/Footer";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "LifeShot — Every moment. Beautifully remembered." },
      {
        name: "description",
        content:
          "LifeShot is your private memory platform. Capture, organize, and relive a lifetime of moments with the people you love.",
      },
      { property: "og:title", content: "LifeShot — Your personal memory platform" },
      {
        property: "og:description",
        content: "Capture, organize, and relive a lifetime of moments.",
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
            "A private memory platform to capture, organize, and relive a lifetime of moments.",
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
    <div className="min-h-screen bg-paper text-foreground antialiased">
      <Nav />
      <main>
        <Hero />
        <TrustStrip />
        <Features />
        <HowItWorks />
        <FamilySection />
        <Timeline />
        <Testimonials />
        <Pricing />
        <FAQ />
        <FooterCTA />
      </main>
      <Footer />
      <Toaster position="top-center" />
    </div>
  );
}
