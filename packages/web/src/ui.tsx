import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Platform, PostStatus, TargetStatus } from "./api.js";
import {
  PLATFORM_LABELS,
  POST_STATUS_COLORS,
  POST_STATUS_LABELS,
  TARGET_STATUS_COLORS,
  TARGET_STATUS_LABELS,
} from "./postRules.js";

/**
 * The few pieces the composer, the Post lists, and a Post's detail all render.
 *
 * Extracted here rather than repeated per screen because they are the app's
 * vocabulary made visible — a status badge means the same thing wherever it
 * appears, and three copies of it would eventually stop agreeing. Styling stays
 * inline and in the existing slate/`--brand-primary` palette, matching the rest
 * of the SPA; the Client's accent is used for anything primary so even these
 * belong to the Client.
 */

export function PostStatusBadge({ status }: { status: PostStatus }) {
  return (
    <span style={{ ...badgeStyle, color: POST_STATUS_COLORS[status] }}>
      {POST_STATUS_LABELS[status]}
    </span>
  );
}

export function TargetStatusBadge({ status }: { status: TargetStatus }) {
  return (
    <span style={{ ...badgeStyle, color: TARGET_STATUS_COLORS[status] }}>
      {TARGET_STATUS_LABELS[status]}
    </span>
  );
}

/** A platform's name as a compact chip, for a Post's fan-out at a glance. */
export function PlatformChip({ platform }: { platform: Platform }) {
  return <span style={chipStyle}>{PLATFORM_LABELS[platform]}</span>;
}

/** An API failure, said in the API's own words. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" style={{ color: "#b91c1c", fontSize: "0.875rem", margin: "0.5rem 0" }}>
      {children}
    </p>
  );
}

/** Empty state copy — what to do, not just that there is nothing here. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p style={{ color: "#64748b", fontSize: "0.875rem" }}>{children}</p>;
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

  const style: CSSProperties = {
    width: size,
    height: size,
    objectFit: "cover",
    borderRadius: "0.25rem",
    border: "1px solid #e2e8f0",
    background: "#f1f5f9",
  };
  return type === "video" ? (
    <video src={url} style={style} controls muted playsInline onError={() => setFailed(true)} />
  ) : (
    <img src={url} alt="Attached media" style={style} onError={() => setFailed(true)} />
  );
}

const badgeStyle = {
  fontSize: "0.75rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
} as const;

const chipStyle = {
  display: "inline-block",
  padding: "0.125rem 0.5rem",
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  borderRadius: "999px",
  fontSize: "0.75rem",
  color: "#475569",
} as const;

/**
 * The style a disabled button needs on top of its own.
 *
 * Necessary because this app styles inline, and an inline style cannot express
 * `:disabled` — so without this a blocked "Publish now" renders identically to a
 * live one. A primary action that looks pressable and does nothing reads as a
 * broken app, precisely when the composer is trying to explain what is missing.
 */
export function disabledStyle(disabled: boolean) {
  return disabled ? { opacity: 0.45, cursor: "not-allowed" } : null;
}

export const cardStyle = {
  padding: "1rem",
  border: "1px solid #e2e8f0",
  borderRadius: "0.375rem",
  background: "#fff",
} as const;

export const secondaryButtonStyle = {
  padding: "0.5rem 1rem",
  background: "transparent",
  color: "#334155",
  border: "1px solid #cbd5e1",
  borderRadius: "0.25rem",
  fontSize: "0.938rem",
  cursor: "pointer",
} as const;

export const linkButtonStyle = {
  padding: 0,
  background: "none",
  border: "none",
  color: "var(--brand-primary)",
  fontSize: "0.875rem",
  textAlign: "left",
  cursor: "pointer",
} as const;

export const inputStyle = {
  padding: "0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: "0.25rem",
  fontSize: "0.938rem",
} as const;

export const fieldLabelStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  fontSize: "0.813rem",
  color: "#475569",
} as const;

export const sectionHeadingStyle = {
  fontSize: "1.1rem",
  fontWeight: 600,
  margin: "0 0 0.75rem",
} as const;
