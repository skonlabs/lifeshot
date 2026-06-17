import { useMemo, useState, type CSSProperties } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { usePeople, useCorrection } from "@/lib/api/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldAlert, UserRound } from "lucide-react";

export const Route = createFileRoute("/_authenticated/people")({ component: People });

type Bbox = { x: number; y: number; w: number; h: number } | null;
type Cover = {
  face_crop?: string | null;
  thumbnail_url: string | null;
  face_bbox?: Bbox;
  width?: number | null;
  height?: number | null;
} | null | undefined;

type Person = {
  id: string;
  display_name: string | null;
  asset_count: number;
  cover?: Cover;
};

function People() {
  const { data, isLoading } = usePeople();
  const faceOff = (data as { face_processing_disabled?: boolean } | undefined)?.face_processing_disabled;
  const people = data?.people ?? [];
  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <header className="hairline-b mb-6 pb-4">
        <span className="text-archive-label">people</span>
        <h1 className="mt-1 font-serif-display text-4xl text-[color:var(--ink)]">The faces in your archive</h1>
        {!faceOff && (
          <p className="mt-2 text-xs text-[color:var(--umber)]">
            Faces are detected automatically as new photos sync.
          </p>
        )}
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
        <div className="grid grid-cols-6 gap-3 md:grid-cols-12">
          {Array.from({ length: 24 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-full" />)}
        </div>
      ) : people.length === 0 && !faceOff ? (
        <div className="hairline rounded-md border border-dashed bg-[color:var(--paper)] py-16 text-center text-sm text-[color:var(--umber)]">
          No people clustered yet — sync a source to begin.
        </div>
      ) : (
        <div className="grid grid-cols-6 gap-3 md:grid-cols-12">
          {people.map((p) => (
            <PersonTile key={(p as any).id} person={p as unknown as Person} />
          ))}
        </div>
      )}
    </div>
  );
}

function PersonTile({ person }: { person: Person }) {
  const correction = useCorrection();
  const [name, setName] = useState(person.display_name ?? "");
  const [editing, setEditing] = useState(false);
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== (person.display_name ?? "")) {
      correction.mutate({
        target_type: "person",
        target_id: person.id,
        correction: { display_name: trimmed },
      });
    }
    setEditing(false);
  };
  return (
    <div className="group block text-center">
      <Link to="/people/$id" params={{ id: person.id }} className="block">
        <FaceAvatar cover={person.cover} />
      </Link>
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setName(person.display_name ?? ""); setEditing(false); }
          }}
          placeholder="Name"
          className="hairline mt-2 w-full rounded border bg-[color:var(--paper)] px-1 py-0.5 text-center text-xs text-[color:var(--ink)] focus:outline-none focus:ring-1 focus:ring-[color:var(--ink)]"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-2 block w-full truncate text-xs font-medium text-[color:var(--ink)] hover:underline"
          title="Click to name"
        >
          {person.display_name ?? <span className="text-[color:var(--umber)]">+ name</span>}
        </button>
      )}
      <div className="text-[10px] text-[color:var(--umber)]">{person.asset_count}</div>
    </div>
  );
}

/**
 * Renders a circular face avatar.
 * Priority:
 *   1. face_crop data-URL (512×512 JPEG from Rekognition crop) — exact face pixels, no CSS cropping needed.
 *   2. zoom_url + face_bbox — CSS zoom/position trick using high-res preview image.
 *   3. zoom_url only — full photo centered at 25% from top (portraits are usually top-half).
 *   4. Fallback icon.
 */
function FaceAvatar({ cover }: { cover: Cover }) {
  const [imgFailed, setImgFailed] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  // useMemo must be called unconditionally — before any early returns.
  const dims = useMemo(() => {
    const width = cover?.width && cover.width > 0 ? cover.width : naturalSize?.width ?? null;
    const height = cover?.height && cover.height > 0 ? cover.height : naturalSize?.height ?? null;
    return width && height ? { width, height } : null;
  }, [cover?.height, cover?.width, naturalSize]);

  // 1. Exact face crop (data-URL from Rekognition).
  if (cover?.face_crop && !imgFailed) {
    return (
      <div className="hairline relative mx-auto aspect-square w-full overflow-hidden rounded-full border bg-[color:var(--paper-2)] transition-transform group-hover:scale-[1.02]">
        <img
          src={cover.face_crop}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImgFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
    );
  }

  const bb = cover?.face_bbox;
  // Use zoom_url (high-res preview) for CSS zoom paths; fall back to thumbnail_url.
  const zoomSrc = (cover as any)?.zoom_url ?? cover?.thumbnail_url;

  if (!zoomSrc || imgFailed) {
    return (
      <div className="mx-auto grid aspect-square w-full place-items-center rounded-full bg-[color:var(--paper-2)] text-[color:var(--umber)]">
        <UserRound className="h-10 w-10" strokeWidth={1.2} />
      </div>
    );
  }

  const hasUsableBbox = !!(bb && bb.w > 0.04 && bb.h > 0.04 && bb.w <= 1 && bb.h <= 1);

  // 2. Thumbnail without usable bbox (or dims not yet loaded) — show full photo.
  if (!hasUsableBbox || !dims) {
    return (
      <div className="hairline relative mx-auto aspect-square w-full overflow-hidden rounded-full border bg-[color:var(--paper-2)] transition-transform group-hover:scale-[1.02]">
        <img
          src={zoomSrc}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setImgFailed(true)}
          className="absolute inset-0 h-full w-full object-cover object-[center_25%]"
        />
      </div>
    );
  }

  // 3. CSS zoom crop around face bbox.
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const W = Math.max(dims.width, 1);
  const H = Math.max(dims.height, 1);
  const faceWpx = bb!.w * W;
  const faceHpx = bb!.h * H;
  const longestFaceSide = Math.max(faceWpx, faceHpx);
  const shortestImageSide = Math.min(W, H);
  const sidePx = clamp(longestFaceSide, shortestImageSide * 0.08, shortestImageSide * 0.6);
  const cxPx = (bb!.x + bb!.w / 2) * W;
  const cyPx = (bb!.y + bb!.h / 2) * H;
  let leftPx = cxPx - sidePx / 2;
  let topPx = cyPx - sidePx / 2;
  leftPx = Math.min(Math.max(leftPx, 0), Math.max(W - sidePx, 0));
  topPx = Math.min(Math.max(topPx, 0), Math.max(H - sidePx, 0));
  const imageStyle: CSSProperties = {
    position: "absolute",
    width: `${(W / sidePx) * 100}%`,
    height: `${(H / sidePx) * 100}%`,
    left: `${-(leftPx / sidePx) * 100}%`,
    top: `${-(topPx / sidePx) * 100}%`,
    maxWidth: "none",
  };

  return (
    <div
      className="hairline relative mx-auto aspect-square w-full overflow-hidden rounded-full border bg-[color:var(--paper-2)] transition-transform group-hover:scale-[1.02]"
      role="img"
      aria-label="Face thumbnail"
    >
      <img
        src={zoomSrc}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setImgFailed(true)}
        className="absolute"
        style={imageStyle}
      />
    </div>
  );
}
