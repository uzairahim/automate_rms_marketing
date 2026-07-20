import type { Clock } from "../core/clock.js";
import type { Platform, Publisher } from "../core/publisher.js";
import { FakePublisher } from "../core/fake-publisher.js";
import { MetaPublisher } from "./meta-publisher.js";
import { TikTokPublisher } from "./tiktok-publisher.js";
import { RoutingPublisher } from "./routing-publisher.js";
import type { Config } from "../config.js";

/**
 * Choose the Publisher transport for each platform, from what the environment
 * says is configured.
 *
 * This is the whole of ADR 0002's escape hatch in practice: the one place that
 * decides what is behind the seam. A fresh checkout has no Meta app and no TikTok
 * app, so it gets the fake and the connect flow is still clickable end-to-end
 * (mirroring the email sender's console fallback). Configure the credentials and
 * the same code talks to the real APIs — which, while App Review and the TikTok
 * audit are pending, means our own test Page and the TikTok sandbox (ADR 0002,
 * docs/platform-app-setup.md).
 *
 * The choice is per platform, because approval is per platform: Meta and TikTok
 * are two reviews on two timelines, and one clearing first must not mean waiting
 * on the other. So a half-configured deployment is a real, supported state —
 * real Facebook and Instagram, faked TikTok — rather than all-or-nothing.
 *
 * Both entrypoints (API and worker) resolve through here, so they can never
 * disagree about which transport is live.
 */
export function resolvePublisher(config: Config, clock: Clock): Publisher {
  const fake = new FakePublisher();

  // One Meta transport shared by both its platforms: an Instagram Business
  // account is a property of a Facebook Page, reached with that Page's token
  // through the same app (ADR 0005).
  const meta = metaTransport(config, clock) ?? fake;
  const tiktok = tikTokTransport(config, clock) ?? fake;

  const transports: Record<Platform, Publisher> = {
    facebook: meta,
    instagram: meta,
    tiktok,
  };
  return new RoutingPublisher(transports);
}

function metaTransport(config: Config, clock: Clock): Publisher | null {
  const { appId, appSecret } = config.meta;
  if (appId && appSecret) return new MetaPublisher(appId, appSecret, clock);

  console.warn(
    "[publisher] META_APP_ID/META_APP_SECRET are not set — using the fake Publisher for " +
      "Facebook and Instagram. Connecting them will not reach Meta.",
  );
  return null;
}

function tikTokTransport(config: Config, clock: Clock): Publisher | null {
  const { clientKey, clientSecret } = config.tiktok;
  if (clientKey && clientSecret) return new TikTokPublisher(clientKey, clientSecret, clock);

  console.warn(
    "[publisher] TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET are not set — using the fake " +
      "Publisher for TikTok. Connecting it will not reach TikTok.",
  );
  return null;
}
