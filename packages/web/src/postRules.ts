import type { ConnectedAccount, Platform, PostStatus, TargetStatus } from "./api.js";

/**
 * What the composer can tell a User *before* they press a button.
 *
 * This is a deliberate mirror of the server's own validate-and-gate
 * (`posts/validation.ts` and `resolveCompose`), not a replacement for it: the API
 * re-checks everything and is the only authority, so a drift here can never let
 * a bad Post through — it can only make the composer briefly optimistic. The
 * duplication buys the thing a round-trip cannot: telling a User that TikTok
 * needs a video while they are still choosing platforms, rather than after they
 * have committed.
 *
 * Kept as plain functions over plain data so each rule sits next to the server
 * rule it mirrors and can be compared with it by eye.
 */

/** A composed attachment, as far as the rules care: only its type matters. */
export interface AttachedMedia {
  type: "image" | "video";
}

/**
 * Why `platform` cannot accept this content, or null if it can. Mirrors
 * `reasonFor` in the server's `posts/validation.ts`, wording included.
 */
export function contentReason(platform: Platform, media: AttachedMedia | null): string | null {
  switch (platform) {
    case "tiktok":
      // Not "any media" — specifically a video.
      return media?.type === "video" ? null : "TikTok requires a video.";
    case "instagram":
      return media ? null : "Instagram requires an image or video.";
    case "facebook":
      return null;
  }
}

/**
 * Why `platform` cannot be published to right now regardless of the content —
 * nothing linked, or a linked account whose token has died (ADR 0008).
 *
 * The two are kept apart because they send a User to different places: one to
 * connect an account, the other to the Reconnect action on an account that is
 * already there. That is the same distinction the API draws between
 * `platform_not_connected` and `platform_token_expired`.
 */
export function connectionReason(connection: ConnectedAccount | undefined): string | null {
  if (!connection || connection.status === "disconnected") {
    return "Not connected yet — link this account first.";
  }
  if (connection.status === "token_expired") {
    return "Access expired — reconnect or regenerate this account's token.";
  }
  return null;
}

/**
 * Everything standing between this selection and a publish, one reason per
 * platform. Empty means the composer expects the API to accept it.
 *
 * A platform contributes at most one reason, connection before content: being
 * told to attach a video for an account that is not even linked is noise.
 */
export function blockingReasons(
  platforms: readonly Platform[],
  media: AttachedMedia | null,
  connections: readonly ConnectedAccount[],
): Partial<Record<Platform, string>> {
  const byPlatform = new Map(connections.map((connection) => [connection.platform, connection]));
  const reasons: Partial<Record<Platform, string>> = {};

  for (const platform of platforms) {
    const reason =
      connectionReason(byPlatform.get(platform)) ?? contentReason(platform, media);
    if (reason) reasons[platform] = reason;
  }
  return reasons;
}

/** The Post statuses a User can still edit, schedule, or send by hand. */
export function isPending(status: PostStatus): boolean {
  return status === "draft" || status === "scheduled";
}

/** How a Post's status reads to a User, in CONTEXT.md's own vocabulary. */
export const POST_STATUS_LABELS: Record<PostStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  publishing: "Publishing…",
  published: "Published",
  partially_published: "Partially published",
  failed: "Failed",
};

/**
 * The tone a status carries, as the badge class that paints it. Named tones
 * rather than raw hex so the six statuses share the five treatments defined
 * once in `index.css`, and so a status keeps its meaning if the palette moves.
 *
 * `partially_published` is amber rather than red on purpose: some Targets did go
 * out, and a successful one is never rolled back because another failed
 * (CONTEXT.md `Target`) — calling that "failed" would misrepresent what is live
 * on the platforms.
 */
export const POST_STATUS_TONES: Record<PostStatus, string> = {
  draft: "badge-draft",
  scheduled: "badge-progress",
  publishing: "badge-progress",
  published: "badge-published",
  partially_published: "badge-partial",
  failed: "badge-failed",
};

export const TARGET_STATUS_LABELS: Record<TargetStatus, string> = {
  pending: "Pending",
  published: "Published",
  failed: "Failed",
};

export const TARGET_STATUS_TONES: Record<TargetStatus, string> = {
  pending: "badge-progress",
  published: "badge-published",
  failed: "badge-failed",
};

/**
 * The card color each platform is drawn in, cycled from DESIGN.md's six-color
 * palette so the three never sit next to each other in the same hue. These are
 * CSS custom-property values, fed to `--orb` on a clay surface.
 */
export const PLATFORM_TONES: Record<Platform, string> = {
  facebook: "var(--color-clay-lavender)",
  instagram: "var(--color-clay-pink)",
  tiktok: "var(--color-clay-teal)",
};

/** Platform names as they are written on the platforms themselves. */
export const PLATFORM_LABELS: Record<Platform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
};
