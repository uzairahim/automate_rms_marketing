import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { Publisher } from "../core/publisher.js";
import type { SecretCipher } from "../core/crypto.js";
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
  /**
   * Due Targets whose Client was no longer entitled to publish them (ADR 0011).
   * Failed on the spot without reaching a Publisher, so deliberately *not*
   * counted as attempts — the operator reading this tick's log should be able to
   * tell a refusal apart from a platform that turned us down.
   */
  blocked: number;
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
  cipher: SecretCipher,
  mediaDir: string,
): Promise<RetryOutcome> {
  const due = await findDueTargets(pool, clock.now());
  const outcome: RetryOutcome = { attempted: 0, published: 0, failed: 0, blocked: 0 };
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

    const { target: updated, eligible } = await attemptPublish(
      pool,
      clock,
      publisher,
      cipher,
      post,
      target,
      { auto: true },
    );
    if (!eligible) {
      outcome.blocked += 1;
    } else {
      outcome.attempted += 1;
      if (updated.status === "published") outcome.published += 1;
      else if (updated.status === "failed") outcome.failed += 1;
    }
    affectedPosts.add(target.postId);
  }

  for (const postId of affectedPosts) {
    await recomputePostStatus(pool, clock, mediaDir, postId);
  }

  return outcome;
}
