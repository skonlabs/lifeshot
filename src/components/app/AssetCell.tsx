import { useEffect, useRef, useState } from "react";
import { decode } from "blurhash";
import { Link } from "@tanstack/react-router";

interface Descriptor {
  asset_id: string;
  thumbnail_url: string | null;
  blurhash: string | null;
  dominant_color: string | null;
  width: number | null;
  height: number | null;
  media_type: string;
  source_badge: string | null;
  hydration_status: "pending" | "ready";
}

export function AssetCell({ d, style, disableLink }: { d: Descriptor; style?: React.CSSProperties; disableLink?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!d.blurhash || !canvasRef.current) return;
    try {
      const pixels = decode(d.blurhash, 32, 32);
      const ctx = canvasRef.current.getContext("2d");
      if (!ctx) return;
      const img = ctx.createImageData(32, 32);
      img.data.set(pixels);
      ctx.putImageData(img, 0, 0);
    } catch {
      /* invalid blurhash → fall back to dominant color */
    }
  }, [d.blurhash]);

  const inner = (
    <>
      {d.blurhash && (
        <canvas
          ref={canvasRef}
          width={32}
          height={32}
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${loaded ? "opacity-0" : "opacity-100"}`}
        />
      )}
      {d.thumbnail_url && (
        <img
          src={d.thumbnail_url}
          alt=""
          width={96}
          height={96}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      )}
      {d.source_badge && (
        <span className="absolute right-1 top-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          {d.source_badge}
        </span>
      )}
      {d.hydration_status === "pending" && (
        <span className="absolute left-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-white/70" />
      )}
    </>
  );
  if (disableLink) {
    return (
      <div
        className="group relative block h-full w-full overflow-hidden rounded-md bg-muted"
        style={{ backgroundColor: d.dominant_color ?? undefined, ...style }}
      >
        {inner}
      </div>
    );
  }
  return (
    <Link
      to="/asset/$id"
      params={{ id: d.asset_id }}
      className="group relative block h-full w-full overflow-hidden rounded-md bg-muted"
      style={{ backgroundColor: d.dominant_color ?? undefined, ...style }}
    >
      {inner}
    </Link>
  );
}