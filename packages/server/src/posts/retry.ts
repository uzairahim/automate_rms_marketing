import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { Publisher } from "../core/publisher.js";
import { attemptPublish, recomputePostStatus } from "./publish.js";
import { findDueTargets, findPost, type Post } from "./posts.js";

/**
 * The auto-retry tick (PRD story 41): "failed Targets retried automatically
 * twice at one-minute intervals."
 *
 * Due Targets are found by querying, each tick, rather than holding a timer per
 * Target — the same approach as the token-refresh job, and for the same reason:
 * nothing in memory means a restart never drops a scheduled retry.
 */

export interface RetryOutcome {
  /** Targets that were due and attempted this tick. */
  attempted: number;
  published: number;
  /** Attempts that failed and used up their last auto-retry. */
  failed: number;
}

/** A due Target's Post, looked up by id — the retry job runs across every Client. */
async function findPostById(pool: pg.Pool, postId: string): Promise<Post | null> {
  const { rows } = await pool.query<{ client_id: string }>(
    `SELECT client_id FROM posts WHERE id = $1`,
    [postId],
  );
  const clientId = rows[0]?.client_id;
  return clientId ? findPost(pool, clientId, postId) : null;
}

export async function retryDueTargets(
  pool: pg.Pool,
  clock: Clock,
  publisher: Publisher,
  mediaDir: string,
): Promise<RetryOutcome> {
  const due = await findDueTargets(pool, clock.now());
  const outcome: RetryOutcome = { attempted: 0, published: 0, failed: 0 };
  // Several due Targets can belong to the same Post; cache so it's fetched once.
  const postCache = new Map<string, Post | null>();
  const affectedPosts = new Set<string>();

  for (const target of due) {
    let post = postCache.get(target.postId);
    if (post === undefined) {
      post = await findPostById(pool, target.postId);
      postCache.set(target.postId, post);
    }
    if (!post) continue; // A due Target with no Post left (FK cascade) has nothing to retry.

    outcome.attempted += 1;
    const updated = await attemptPublish(pool, clock, publisher, post, target, { auto: true });
    if (updated.status === "published") outcome.published += 1;
    else if (updated.status === "failed") outcome.failed += 1;
    affectedPosts.add(target.postId);
  }

  for (const postId of affectedPosts) {
    await recomputePostStatus(pool, clock, mediaDir, postId);
  }

  return outcome;
}
