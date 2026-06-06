import { createFileRoute, Link } from "@tanstack/react-router";
import { usePeople } from "@/lib/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldAlert, UserRound } from "lucide-react";

export const Route = createFileRoute("/_authenticated/people")({ component: People });

function People() {
  const { data, isLoading } = usePeople();
  const faceOff = (data as { face_processing_disabled?: boolean } | undefined)?.face_processing_disabled;
  const people = data?.people ?? [];
  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <header className="hairline-b mb-6 pb-4">
        <span className="text-archive-label">people</span>
        <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">The faces in your archive</h1>
      </header>
      {faceOff && (
        <div className="hairline mb-6 flex items-start gap-3 rounded-md border bg-[color:var(--paper)] p-4">
          <ShieldAlert className="mt-0.5 h-4 w-4 text-[color:var(--umber)]" />
          <div className="text-sm">
            <p className="font-medium text-[color:var(--ink)]">Face recognition is off.</p>
            <p className="text-[color:var(--umber)]">Enable it in <Link to="/settings/privacy" className="underline">Privacy</Link> to group memories by person.</p>
          </div>
        </div>
      )}
      {isLoading ? (
        <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-full" />)}
        </div>
      ) : people.length === 0 && !faceOff ? (
        <div className="hairline rounded-md border border-dashed bg-[color:var(--paper)] py-16 text-center text-sm text-[color:var(--umber)]">
          No people clustered yet — sync a source to begin.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
          {people.map((p) => (
            <Link key={p.id} to="/people/$id" params={{ id: p.id }}
              className="group block text-center">
              <FaceAvatar cover={p.cover} />
              <div className="mt-2 truncate text-sm font-medium text-[color:var(--ink)]">{p.display_name ?? "Unknown"}</div>
              <div className="text-xs text-[color:var(--umber)]">{p.asset_count} photo{p.asset_count === 1 ? "" : "s"}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

type Bbox = { x: number; y: number; w: number; h: number } | null;
type Cover = { thumbnail_url: string | null; face_bbox?: Bbox; width?: number | null; height?: number | null } | null | undefined;

/**
 * Renders a circular face crop from the cover asset's thumbnail.
 * Uses CSS background-position+size to crop the face_bbox region into a
 * round avatar without needing a server-side face thumbnail.
 * bbox is expected in normalized [0..1] coordinates.
 */
function FaceAvatar({ cover }: { cover: Cover }) {
  if (!cover?.thumbnail_url) {
    return (
      <div className="mx-auto grid aspect-square w-full place-items-center rounded-full bg-[color:var(--paper-2)] text-[color:var(--umber)]">
        <UserRound className="h-10 w-10" strokeWidth={1.2} />
      </div>
    );
  }
  const bb = cover.face_bbox;
  let imageStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "center center",
  };
  if (bb && bb.w > 0 && bb.h > 0) {
    const width = Math.max(cover.width ?? 1, 1);
    const height = Math.max(cover.height ?? 1, 1);
    const faceCx = (bb.x + bb.w / 2) * width;
    const faceCy = (bb.y + bb.h / 2) * height;
    const faceW = bb.w * width;
    const faceH = bb.h * height;
    const cropSide = clamp(Math.max(faceW, faceH) * 1.22, Math.min(width, height) * 0.12, Math.min(width, height));
    const cropX = clamp(faceCx - cropSide / 2, 0, Math.max(width - cropSide, 0));
    const cropY = clamp(faceCy - cropSide / 2, 0, Math.max(height - cropSide, 0));
    imageStyle = {
      position: "absolute",
      width: `${(width / cropSide) * 100}%`,
      maxWidth: "none",
      height: "auto",
      left: `${-(cropX / cropSide) * 100}%`,
      top: `${-(cropY / cropSide) * 100}%`,
    };
  }
  return (
    <div
      className="hairline mx-auto aspect-square w-full overflow-hidden rounded-full border bg-[color:var(--paper-2)] transition-transform group-hover:scale-[1.02]"
      role="img"
      aria-label="Face thumbnail"
    >
      <img src={cover.thumbnail_url} alt="" loading="lazy" decoding="async" style={imageStyle} />
    </div>
  );
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return 50;
  return Math.min(hi, Math.max(lo, n));
}