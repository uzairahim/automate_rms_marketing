import type { Clock } from "../core/clock.js";
import type { Publisher } from "../core/publisher.js";
import { FakePublisher } from "../core/fake-publisher.js";
import { MetaPublisher } from "./meta-publisher.js";
import type { Config } from "../config.js";

/**
 * Choose the Publisher transport for a process, from what the environment says
 * is configured.
 *
 * This is the whole of ADR 0002's escape hatch in practice: the one place that
 * decides what is behind the seam. A fresh checkout has no Meta app, so it gets
 * the fake and the connect flow is still clickable end-to-end (mirroring the
 * email sender's console fallback). Configure `META_APP_ID`/`META_APP_SECRET`
 * and the same code talks to the real Graph API — which, while App Review is
 * pending, means our own test Page (ADR 0002, docs/platform-app-setup.md).
 *
 * Both entrypoints (API and worker) resolve through here, so they can never
 * disagree about which transport is live.
 *
 * Slice 6 connects Facebook only, so one transport answers for the whole
 * process. ADR 0002's "one implementation per platform" bites when Slice 7 adds
 * TikTok — which does not share Meta's Graph API — and this becomes a dispatch
 * over a per-platform map. Confining that to this one function is the point of
 * the seam.
 */
export function resolvePublisher(config: Config, clock: Clock): Publisher {
  const { appId, appSecret } = config.meta;
  if (appId && appSecret) {
    return new MetaPublisher(appId, appSecret, clock);
  }

  console.warn(
    "[publisher] META_APP_ID/META_APP_SECRET are not set — using the fake Publisher. " +
      "Connecting a Page will not reach Facebook.",
  );
  return new FakePublisher();
}
