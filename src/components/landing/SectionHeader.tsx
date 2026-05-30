import type { ReactNode } from "react";

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = "left",
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: string;
  align?: "left" | "center";
}) {
  const a = align === "center" ? "text-center mx-auto" : "";
  return (
    <div className={`max-w-2xl ${a}`}>
      {eyebrow && (
        <div className={`flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-foreground/60 ${align === "center" ? "justify-center" : ""}`}>
          <span className="h-px w-6 bg-gold" />
          {eyebrow}
        </div>
      )}
      <h2 className="mt-3 font-display text-3xl sm:text-4xl font-semibold text-ink leading-tight">
        {title}
      </h2>
      {description && (
        <p className="mt-4 text-base sm:text-lg text-foreground/70 leading-relaxed">
          {description}
        </p>
      )}
    </div>
  );
}