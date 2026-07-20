import type { Platform } from "../core/publisher.js";

/**
 * Compose-time validate-and-gate (PRD stories 32–33; CONTEXT.md `Post`).
 *
 * A Post's content must satisfy the union of every *selected* platform's rules
 * before it may be published — TikTok requires a video, Instagram requires any
 * media, Facebook is permissive. This is checked once, against the whole
 * selection, so a User sees every reason at once rather than discovering them
 * one platform at a time.
 */

export interface ComposedMedia {
  url: string;
  type: "image" | "video";
}

export interface ComposedContent {
  text: string;
  media?: ComposedMedia;
}

export interface ValidationResult {
  valid: boolean;
  /** One human-readable reason per platform whose rule the content fails. */
  reasons: Partial<Record<Platform, string>>;
}

/** Why `content` fails `platform`'s rule, or null if it satisfies it. */
function reasonFor(platform: Platform, content: ComposedContent): string | null {
  switch (platform) {
    case "tiktok":
      // Not "any media" — specifically a video (PRD story 32's own example).
      return content.media?.type === "video" ? null : "TikTok requires a video.";
    case "instagram":
      return content.media ? null : "Instagram requires an image or video.";
    case "facebook":
      return null;
  }
}

/** Validate composed content against every platform it is being sent to. */
export function validateContent(
  content: ComposedContent,
  platforms: readonly Platform[],
): ValidationResult {
  const reasons: Partial<Record<Platform, string>> = {};
  for (const platform of platforms) {
    const reason = reasonFor(platform, content);
    if (reason) reasons[platform] = reason;
  }
  return { valid: Object.keys(reasons).length === 0, reasons };
}
