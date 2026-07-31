import { useEffect, useState, type ReactNode } from "react";
import type { Platform, PostStatus, TargetStatus } from "./api.js";
import {
  PLATFORM_LABELS,
  PLATFORM_TONES,
  POST_STATUS_LABELS,
  POST_STATUS_TONES,
  TARGET_STATUS_LABELS,
  TARGET_STATUS_TONES,
} from "./postRules.js";

/**
 * The few pieces the composer, the Post lists, and a Post's detail all render.
 *
 * Extracted here rather than repeated per screen because they are the app's
 * vocabulary made visible — a status badge means the same thing wherever it
 * appears, and three copies of it would eventually stop agreeing. Styling is
 * Clay's, expressed as Tailwind classes over the tokens in `index.css`; the
 * Client's own accent stays reserved for anything primary, so even these belong
 * to the Client.
 */

export function PostStatusBadge({ status }: { status: PostStatus }) {
  return (
    <span className={`badge ${POST_STATUS_TONES[status]}`}>
      {/* A Post still in flight gets a pulsing dot — the one status that is
          about to change on its own, so it should not look settled. */}
      {status === "publishing" && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
      )}
      {POST_STATUS_LABELS[status]}
    </span>
  );
}

export function TargetStatusBadge({ status }: { status: TargetStatus }) {
  return (
    <span className={`badge ${TARGET_STATUS_TONES[status]}`}>{TARGET_STATUS_LABELS[status]}</span>
  );
}

/** A platform's name as a compact chip, for a Post's fan-out at a glance. */
export function PlatformChip({ platform }: { platform: Platform }) {
  return (
    <span className="chip">
      <span
        className="size-2 rounded-full"
        style={{ background: PLATFORM_TONES[platform] }}
        aria-hidden="true"
      />
      {PLATFORM_LABELS[platform]}
    </span>
  );
}

/**
 * A platform as a modeled clay tile, carrying its initial.
 *
 * The three platforms are the app's most-repeated objects — they head every
 * connection row and every composer destination — so they get the system's
 * signature surface rather than a flat swatch. The color comes from
 * `PLATFORM_TONES`, which draws from DESIGN.md's six-color palette.
 */
export function PlatformTile({
  platform,
  size = "md",
}: {
  platform: Platform;
  /** `sm` sits inside a row of text; `md` heads a card. */
  size?: "sm" | "md";
}) {
  const tone = PLATFORM_TONES[platform];
  // Teal is the one dark tone in the palette, so it is the one that needs
  // light type on it.
  const light = platform === "tiktok";
  return (
    <span
      className={`clay-pill grid shrink-0 place-items-center font-semibold ${
        size === "sm" ? "size-8 text-[0.8125rem]" : "size-11 text-title-sm"
      } ${light ? "text-white" : "text-ink"}`}
      style={{ ["--orb" as string]: tone }}
      aria-hidden="true"
    >
      {PLATFORM_LABELS[platform].charAt(0)}
    </span>
  );
}

/** An API failure, said in the API's own words. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="callout callout-error my-3 text-body-sm">
      {children}
    </p>
  );
}

/** Empty state copy — what to do, not just that there is nothing here. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="card-soft flex items-center gap-4 px-5 py-6">
      {/* A soft field of color rather than an icon: the empty state should feel
          like room to fill, not like a warning. */}
      <span
        className="clay-orb clay-orb-alt size-9 shrink-0 opacity-70"
        style={{ ["--orb" as string]: "var(--color-clay-mint)" }}
        aria-hidden="true"
      />
      <p className="m-0 text-body-sm text-muted">{children}</p>
    </div>
  );
}

/** A screen still waiting on its first fetch. */
export function LoadingNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 text-body-sm text-muted">
      <span
        className="size-3 animate-[breathe_2s_ease-in-out_infinite] rounded-full bg-clay-peach"
        aria-hidden="true"
      />
      {children}
    </p>
  );
}

/**
 * A Post's Media, at a fixed size. `object-fit: cover` so an image of any
 * aspect ratio fills the box instead of stretching, and a video renders as a
 * plain playable element rather than a still — a User attaching a video to
 * TikTok wants to confirm it is the right video.
 *
 * A URL that will not load renders as nothing at all. This is not defensiveness
 * for its own sake: a history thumbnail is a *temporary signed URL* fetched from
 * the platform (ADR 0003), so it can expire between the API reading it and the
 * browser requesting it. The alternative is a broken-image icon captioned with
 * alt text, which reads as a bug in the Post rather than a thumbnail that aged
 * out — and the row is already built to stand on its text and status alone.
 */
export function MediaPreview({
  url,
  type,
  size = "6rem",
}: {
  url: string;
  type: "image" | "video";
  size?: string;
}) {
  const [failed, setFailed] = useState(false);
  // Reset when the URL changes, so a re-fetched thumbnail gets its own chance.
  useEffect(() => setFailed(false), [url]);

  if (failed) return null;

  const className =
    "shrink-0 rounded-lg bg-surface-card object-cover shadow-clay ring-1 ring-hairline-soft";
  const style = { width: size, height: size };

  return type === "video" ? (
    <video
      src={url}
      className={className}
      style={style}
      controls
      muted
      playsInline
      onError={() => setFailed(true)}
    />
  ) : (
    <img
      src={url}
      alt="Attached media"
      className={className}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * A screen's heading, with room for an action beside it.
 *
 * `eyebrow` carries the small uppercase label DESIGN.md puts above section
 * heads — it is what lets the heading itself stay a plain noun.
 */
export function SectionHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  /** An action that belongs to this section, aligned to the right. */
  children?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow && (
          <p className="m-0 mb-1.5 text-overline uppercase text-muted">{eyebrow}</p>
        )}
        <h2 className="m-0 text-display-sm text-ink">{title}</h2>
      </div>
      {children}
    </div>
  );
}

/**
 * A decorative clay form.
 *
 * DESIGN.md's brand voltage is commissioned 3D claymation art. This is the
 * system's stand-in: the same modeled-clay read, built from a single color, so
 * the warmth appears on empty states and entry screens without an asset
 * pipeline. Always `aria-hidden` — it says nothing a screen reader needs.
 */
export function ClayOrb({
  tone,
  className = "",
  alt = false,
  drift = false,
}: {
  /** Any of the six palette colors, as a CSS value. */
  tone: string;
  className?: string;
  /** The second silhouette, so two orbs together do not read as copies. */
  alt?: boolean;
  /** Slow ambient motion. Suppressed for reduced-motion users by the theme. */
  drift?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`clay-orb ${alt ? "clay-orb-alt" : ""} ${drift ? "animate-breathe" : ""} ${className}`}
      style={{ ["--orb" as string]: tone }}
    />
  );
}
