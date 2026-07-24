import type pg from "pg";
import type { SecretCipher } from "../core/crypto.js";
import {
  PublisherError,
  type Platform,
  type PlatformCredential,
  type PostMetrics,
  type Publisher,
} from "../core/publisher.js";
import { openAccountCredential } from "../connections/accounts.js";
import type { Target } from "./posts.js";

/**
 * Reading a published post back from the platform (Slice 11; PRD story 46): the
 * history thumbnail (ADR 0003) and a Post's live per-post metrics (CONTEXT.md
 * `Metric Snapshot`).
 *
 * Both are authenticated reads keyed by the Target's stored `external_id` and
 * authorized by the *Connected Account's* credential — the one place that unseals
 * one for a read, mirroring how {@link openAccountCredential} is the sole read
 * path to a token (ADR 0006). Neither result is ever persisted: a thumbnail URL
 * is a temporary signed one (ADR 0003), and per-post metrics are live-only.
 *
 * A Target that cannot be read — never published, published then the account
 * disconnected, or the platform refusing the read — yields `null`/absent rather
 * than an error, so one platform's gap never blanks a whole history list or
 * detail page.
 */

/**
 * Opens a Client's account credential for a platform — the single input these
 * reads need. Taken as a function rather than `(pool, cipher, clientId)` so the
 * history list can hand in a *memoized* opener: a Client has at most one account
 * per platform (CONTEXT.md `Client`), so unsealing it once per request and
 * reusing it across every row beats re-unsealing per Target (ADR 0006).
 */
export type OpenAccountCredential = (
  platform: Platform,
) => Promise<{ externalId: string; credential: PlatformCredential } | null>;

/**
 * A per-request opener that unseals each platform's account credential at most
 * once. The result is cached (including a `null` for a disconnected platform),
 * so a whole history list resolves each of the ≤3 platforms a single time.
 */
export function memoizingCredentialOpener(
  pool: pg.Pool,
  cipher: SecretCipher,
  clientId: string,
): OpenAccountCredential {
  const cache = new Map<
    Platform,
    Promise<{ externalId: string; credential: PlatformCredential } | null>
  >();
  return (platform) => {
    const hit = cache.get(platform);
    if (hit) return hit;
    const pending = openAccountCredential(pool, cipher, clientId, platform);
    cache.set(platform, pending);
    return pending;
  };
}

/**
 * The thumbnail for one published Target, fetched live from the platform — or
 * `null` when there is none to show (the Target never published, the account was
 * since disconnected, or the platform refused/rate-limited the read). Always a
 * fresh fetch; the URL is never stored (ADR 0003).
 */
export async function targetThumbnail(
  open: OpenAccountCredential,
  publisher: Publisher,
  target: Target,
): Promise<string | null> {
  if (target.status !== "published" || !target.externalId) return null;

  const account = await open(target.platform);
  if (!account) return null;

  // The transport already turns "no thumbnail right now" into null; this catch
  // is belt-and-braces for a transport that throws instead — a thumbnail must
  // never be the reason a history entry fails to render.
  try {
    return await publisher.fetchThumbnail({
      platform: target.platform,
      credential: account.credential,
      externalId: target.externalId,
    });
  } catch (err) {
    if (err instanceof PublisherError) return null;
    throw err;
  }
}

/**
 * One thumbnail for a whole history entry: the first published Target (in the
 * Post's platform order) that yields one. A Post fans out to several platforms,
 * but a list row shows a single image — so the first available wins, and a Post
 * whose every platform is unreadable simply has no thumbnail and renders on its
 * text/status alone.
 */
export async function historyThumbnail(
  open: OpenAccountCredential,
  publisher: Publisher,
  targets: readonly Target[],
): Promise<string | null> {
  for (const target of targets) {
    const url = await targetThumbnail(open, publisher, target);
    if (url) return url;
  }
  return null;
}

/**
 * Live per-post metrics for one published Target — or `null` when there are none
 * to show (not published, the account was disconnected, or the platform refused
 * the read). Never stored (CONTEXT.md `Metric Snapshot`).
 */
export async function targetMetrics(
  open: OpenAccountCredential,
  publisher: Publisher,
  target: Target,
): Promise<PostMetrics | null> {
  if (target.status !== "published" || !target.externalId) return null;

  const account = await open(target.platform);
  if (!account) return null;

  // Unlike the thumbnail, a metrics transport genuinely throws on refusal — so
  // this catch is load-bearing: one platform refusing becomes this Target's
  // "unavailable" (null), never the whole request's failure.
  try {
    return await publisher.fetchPostMetrics({
      platform: target.platform,
      credential: account.credential,
      externalId: target.externalId,
    });
  } catch (err) {
    if (err instanceof PublisherError) return null;
    throw err;
  }
}
