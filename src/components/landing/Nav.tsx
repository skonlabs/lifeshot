import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";

const links = [
  { href: "#features", label: "Features" },
  { href: "#how", label: "How it works" },
  { href: "#family", label: "Family" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-all ${
        scrolled
          ? "bg-paper/80 backdrop-blur-md border-b border-border/60"
          : "bg-transparent"
      }`}
    >
      <nav className="mx-auto max-w-6xl px-5 sm:px-8 h-16 flex items-center justify-between">
        <a href="#top" className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-gold" />
          <span className="font-display text-lg font-semibold tracking-tight text-ink">
            LifeShot
          </span>
        </a>
        <div className="hidden md:flex items-center gap-8">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm text-foreground/70 hover:text-ink transition-colors"
            >
              {l.label}
            </a>
          ))}
        </div>
        <div className="hidden md:block">
          <Button asChild className="rounded-full bg-ink text-paper hover:bg-ink/90">
            <a href="#cta">Get early access</a>
          </Button>
        </div>
        <button
          aria-label="Open menu"
          className="md:hidden p-2 -mr-2 text-ink"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </nav>
      {open && (
        <div className="md:hidden border-t border-border/60 bg-paper">
          <div className="px-5 py-4 flex flex-col gap-3">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="text-sm text-foreground/80 py-1"
              >
                {l.label}
              </a>
            ))}
            <Button asChild className="rounded-full bg-ink text-paper mt-2">
              <a href="#cta" onClick={() => setOpen(false)}>
                Get early access
              </a>
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}