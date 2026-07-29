import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { Publisher } from "../core/publisher.js";
import type { SecretCipher } from "../core/crypto.js";
import { recomputePostStatus, publishPost } from "./publish.js";
import { findDuePosts, listTargets, recordTargetOutcome } from "./posts.js";

/**
 * The scheduler's minute tick (PRD stories 35, 44–45; issue #11).
 *
 * Due Scheduled Posts are found by querying, exactly like the retry tick
 * ({@link ../posts/retry.js}) — nothing is held in memory, so a restart never
 * drops a schedule. A Post found within the grace window fires through the
 * same {@link publishPost} fan-out as an immediate publish; one found beyond it
 * is marked `Failed` without ever calling the Publisher, so content never goes
 * out at an embarrassing hour.
 */

/** How late a due Post may be picked up and still fire (PRD: "60-minute grace window"). */
export const GRACE_WINDOW_MS = 60 * 60 * 1000;

export interface SchedulerOutcome {
  /** Scheduled Posts found due this tick. */
  due: number;
  /** Fired through the normal publish fan-out. */
  fired: number;
  /** Beyond the grace window — marked Failed without publishing. */
  missed: number;
}

/** Mark every one of a missed Post's Targets Failed, then roll up the Post itself. */
async function markMissed(
  pool: pg.Pool,
  clock: Clock,
  mediaDir: string,
  postId: string,
): Promise<void> {
  const targets = await listTargets(pool, postId);
  for (const target of targets) {
    await recordTargetOutcome(pool, clock, target.id, {
      status: "failed",
      externalId: null,
      permalink: null,
      error: "Missed its scheduled time by more than the 60-minute grace window.",
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
  const outcome: SchedulerOutcome = { due: due.length, fired: 0, missed: 0 };

  for (const post of due) {
    const lateBy = now.getTime() - new Date(post.scheduledAt!).getTime();

    if (lateBy > GRACE_WINDOW_MS) {
      await markMissed(pool, clock, mediaDir, post.id);
      outcome.missed += 1;
      continue;
    }

    const targets = await listTargets(pool, post.id);
    await publishPost(pool, clock, publisher, cipher, mediaDir, post, targets);
    outcome.fired += 1;
  }

  return outcome;
}
