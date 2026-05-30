export function Footer() {
  return (
    <footer className="border-t border-border bg-paper">
      <div className="mx-auto max-w-6xl px-5 sm:px-8 py-12 grid sm:grid-cols-2 md:grid-cols-4 gap-8 text-sm">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-gold" />
            <span className="font-display text-lg font-semibold text-ink">LifeShot</span>
          </div>
          <p className="mt-3 text-foreground/60 leading-relaxed">
            Your personal memory platform. Built quietly, kept privately.
          </p>
        </div>
        <div>
          <div className="font-medium text-ink">Product</div>
          <ul className="mt-3 space-y-2 text-foreground/60">
            <li><a href="#features" className="hover:text-ink">Features</a></li>
            <li><a href="#how" className="hover:text-ink">How it works</a></li>
            <li><a href="#pricing" className="hover:text-ink">Pricing</a></li>
            <li><a href="#faq" className="hover:text-ink">FAQ</a></li>
          </ul>
        </div>
        <div>
          <div className="font-medium text-ink">Company</div>
          <ul className="mt-3 space-y-2 text-foreground/60">
            <li><a href="#" className="hover:text-ink">About</a></li>
            <li><a href="#" className="hover:text-ink">Manifesto</a></li>
            <li><a href="#" className="hover:text-ink">Contact</a></li>
          </ul>
        </div>
        <div>
          <div className="font-medium text-ink">Legal</div>
          <ul className="mt-3 space-y-2 text-foreground/60">
            <li><a href="#" className="hover:text-ink">Privacy</a></li>
            <li><a href="#" className="hover:text-ink">Terms</a></li>
            <li><a href="#" className="hover:text-ink">Security</a></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-border">
        <div className="mx-auto max-w-6xl px-5 sm:px-8 py-5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-foreground/50">
          <div>© {new Date().getFullYear()} LifeShot. Made with care.</div>
          <div>Every moment. Beautifully remembered.</div>
        </div>
      </div>
    </footer>
  );
}