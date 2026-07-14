/**
 * Publisher interface (ADR 0002) — the single seam between our domain logic and
 * the platform APIs (Facebook, Instagram, TikTok).
 *
 * All publishing goes through this abstraction with one implementation per
 * platform transport, so a platform can be swapped (to an aggregator, or the
 * BYO-token path of ADR 0008) without touching domain code. In tests the real
 * transports are replaced by {@link FakePublisher}, which records what *would*
 * be sent and can be scripted to succeed or fail per platform — no real
 * Meta/TikTok calls ever occur in the behavioral suite.
 */

export type Platform = "facebook" | "instagram" | "tiktok";

export const PLATFORMS: readonly Platform[] = ["facebook", "instagram", "tiktok"];

/** What we ask a platform transport to publish for a single Target. */
export interface PublishRequest {
  platform: Platform;
  /** The Post's text/caption. */
  text: string;
  /** Public HTTPS URL of the attached Media, if any. */
  mediaUrl?: string;
}

/** The outcome of a single publish attempt for one Target. */
export type PublishResult =
  | {
      ok: true;
      /** The platform's durable post/media ID, persisted per Target on success. */
      externalId: string;
      /** Link to the live post on the platform, if the transport returns one. */
      permalink?: string;
    }
  | {
      ok: false;
      /** Human-readable reason, surfaced on the Target for a manual retry. */
      error: string;
    };

export interface Publisher {
  publish(request: PublishRequest): Promise<PublishResult>;
}
