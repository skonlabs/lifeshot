import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { usePeople, useCorrection } from "@/lib/api/hooks";
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
            <PersonTile key={p.id} person={p} />
          ))}
        </div>
      )}
    </div>
  );
}

type Person = {
  id: string;
  display_name: string | null;
  asset_count: number;
  cover?: Cover;
};

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

type Bbox = { x: number; y: number; w: number; h: number } | null;
type Cover = {
  thumbnail_url: string | null;
  face_bbox?: Bbox;
  width?: number | null;
  height?: number | null;
  face_count?: number | null;
} | null | undefined;

/**
 * Renders a circular face crop from the cover asset's thumbnail.
 * Uses CSS background-position+size to crop the face_bbox region into a
 * round avatar without needing a server-side face thumbnail.
 * bbox is expected in normalized [0..1] coordinates.
 */
function FaceAvatar({ cover }: { cover: Cover }) {
  const bb = cover?.face_bbox;
  // Use a more inclusive check for usable bbox - if we have coordinates, let's use them.
  const hasUsableBbox = !!(bb && bb.w > 0 && bb.h > 0 && bb.w <= 1 && bb.h <= 1);
  const knownDims = !!(cover?.width && cover?.height && cover.width > 0 && cover.height > 0);
  const [imgFailed, setImgFailed] = useState(false);

  if (!cover?.thumbnail_url || imgFailed) {
    return (
      <div className="mx-auto grid aspect-square w-full place-items-center rounded-full bg-[color:var(--paper-2)] text-[color:var(--umber)]">
        <UserRound className="h-10 w-10" strokeWidth={1.2} />
      </div>
    );
  }

  // Fallback: when we don't have a usable bbox OR we don't know the source
  // image's pixel dimensions, render the thumbnail as a centered cover crop.
  // We use object-position: center 25% because faces are usually in the top third.
  if (!hasUsableBbox || !knownDims) {
    return (
      <div className="hairline relative mx-auto aspect-square w-full overflow-hidden rounded-full border bg-[color:var(--paper-2)] transition-transform group-hover:scale-[1.02]">
        <img
          src={cover.thumbnail_url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImgFailed(true)}
          className="absolute inset-0 h-full w-full object-cover object-[center_25%]"
        />
      </div>
    );
  }

  // Compute a square crop around the bbox, in original pixel space.
  const W = Math.max(cover.width ?? 1, 1);
  const H = Math.max(cover.height ?? 1, 1);
  const faceWpx = bb!.w * W;
  const faceHpx = bb!.h * H;
  const longestFaceSide = Math.max(faceWpx, faceHpx);
  const shortestImageSide = Math.min(W, H);

  // sidePx is the dimension of the square we want to show in the avatar.
  // 1.7x the face size provides a nice head-and-shoulders crop.
  let sidePx = longestFaceSide * 1.7;

  // Ensure sidePx is at least the face itself.
  sidePx = Math.max(sidePx, longestFaceSide);
  
  // Don't zoom in so much that we only see a few pixels if the face is tiny (limit zoom).
  sidePx = Math.max(sidePx, shortestImageSide * 0.1);

  // Don't zoom out so much that we exceed the image's smallest dimension
  // (prevents empty space in the square container).
  sidePx = Math.min(sidePx, shortestImageSide);

  const cxPx = (bb!.x + bb!.w / 2) * W;
  const cyPx = (bb!.y + bb!.h / 2) * H;
  
  let leftPx = cxPx - sidePx / 2;
  let topPx = cyPx - sidePx / 2;

  // Keep the crop window within image boundaries.
  leftPx = Math.min(Math.max(leftPx, 0), Math.max(W - sidePx, 0));
  topPx = Math.min(Math.max(topPx, 0), Math.max(H - sidePx, 0));

  const imageStyle: React.CSSProperties = {
    position: "absolute",
    width: `${(W / sidePx) * 100}%`,
    height: "auto",
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
        src={cover.thumbnail_url}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setImgFailed(true)}
        className="absolute"
        style={imageStyle}
      />
    </div>
  );
}
