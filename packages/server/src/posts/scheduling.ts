import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { Publisher } from "../core/publisher.js";
import type { SecretCipher } from "../core/crypto.js";
import { recomputePostStatus, publishPost } from "./publish.js";
import { findDuePosts, listTargets, recordTargetOutcome } from "./posts.js";
import { findClientById, type Client } from "../tenancy/clients.js";
import { accessBlock } from "../tenancy/eligibility.js";

/**
 * The scheduler's minute tick (PRD stories 35, 44–45; issue #11).
 *
 * Due Scheduled Posts are found by querying, exactly like the retry tick
 * ({@link ../posts/retry.js}) — nothing is held in memory, so a restart never
 * drops a schedule. A Post found within the grace window fires through the
 * same {@link publishPost} fan-out as an immediate publish; one found beyond it
 * is marked `Failed` without ever calling the Publisher, so content never goes
 * out at an embarrassing hour.
 *
 * A Post whose Client may not publish at all (ADR 0011) is failed here too, and
 * checked *ahead* of the grace window: a suspended Client's Post never had a
 * chance to meet that window, so telling it that it missed one would name the
 * wrong cause. It is failed rather than held, because reactivating after a lapse
 * would otherwise dump a burst of stale Posts onto live accounts at the wrong
 * hours — exactly what the grace window exists to prevent.
 */

/** How late a due Post may be picked up and still fire (PRD: "60-minute grace window"). */
export const GRACE_WINDOW_MS = 60 * 60 * 1000;

/** Why a Post that was picked up too late never published. */
export const MISSED_GRACE_WINDOW_REASON =
  "Missed its scheduled time by more than the 60-minute grace window.";

export interface SchedulerOutcome {
  /** Scheduled Posts found due this tick. */
  due: number;
  /** Fired through the normal publish fan-out. */
  fired: number;
  /** Beyond the grace window — marked Failed without publishing. */
  missed: number;
  /** The Client was not entitled to publish — marked Failed without publishing. */
  blocked: number;
}

/**
 * Mark every one of a Post's Targets Failed with the same reason, then roll up
 * the Post itself. The reason is a parameter because lateness is no longer the
 * only way a Scheduled Post fails without ever reaching a Publisher.
 */
async function failWithoutPublishing(
  pool: pg.Pool,
  clock: Clock,
  mediaDir: string,
  postId: string,
  reason: string,
): Promise<void> {
  const targets = await listTargets(pool, postId);
  for (const target of targets) {
    await recordTargetOutcome(pool, clock, target.id, {
      status: "failed",
      externalId: null,
      permalink: null,
      error: reason,
      retryCount: target.retryCount,
      nextRetryAt: null,
    });
  }
  await recomputePostStatus(pool, clock, mediaDir, postId);
}

export async function publishDuePosts(
  pool: pg.Pool,
  clock: Clock,
  publisher: Publisher,
  cipher: SecretCipher,
  mediaDir: string,
): Promise<SchedulerOutcome> {
  const now = clock.now();
  const due = await findDuePosts(pool, now);
  const outcome: SchedulerOutcome = { due: due.length, fired: 0, missed: 0, blocked: 0 };

  // One tick spans every Client, and a Client typically owns several due Posts;
  // cache so this gate reads a Client once per tick (as the retry tick caches
  // Posts). The per-Target gate inside the fan-out deliberately reads fresh —
  // there, "right now" is the whole point.
  const clients = new Map<string, Client | null>();
  const clientFor = async (clientId: string): Promise<Client | null> => {
    if (!clients.has(clientId)) clients.set(clientId, await findClientById(pool, clientId));
    return clients.get(clientId) ?? null;
  };

  for (const post of due) {
    const denied = accessBlock((await clientFor(post.clientId))?.plan ?? null);
    if (denied) {
      await failWithoutPublishing(pool, clock, mediaDir, post.id, denied.message);
      outcome.blocked += 1;
      continue;
    }

    const lateBy = now.getTime() - new Date(post.scheduledAt!).getTime();

    if (lateBy > GRACE_WINDOW_MS) {
      await failWithoutPublishing(pool, clock, mediaDir, post.id, MISSED_GRACE_WINDOW_REASON);
      outcome.missed += 1;
      continue;
    }

    const targets = await listTargets(pool, post.id);
    await publishPost(pool, clock, publisher, cipher, mediaDir, post, targets);
    outcome.fired += 1;
  }

  return outcome;
}
