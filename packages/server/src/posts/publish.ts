import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { Publisher } from "../core/publisher.js";
import {
  findTarget,
  listTargets,
  recordTargetOutcome,
  rollupStatus,
  updatePostStatus,
  type Post,
  type Target,
} from "./posts.js";

/**
 * Publishing a Post's Targets, and the retry state machine that follows a
 * failure (PRD stories 39–43; CONTEXT.md `Target`).
 *
 * Every attempt — the immediate one at compose time, an auto-retry, or a
 * manual one — goes through {@link attemptPublish}, which calls the Publisher
 * seam (ADR 0002) once and persists exactly what happened. Nothing here holds
 * a timer: a failed Target is stamped with `next_retry_at`, and it is the
 * retry job (querying "due", not waiting) that calls back in a minute.
 */

/** Spacing between auto-retries (PRD: "twice at one-minute intervals"). */
export const RETRY_INTERVAL_MS = 60_000;

/** How many auto-retries a failed Target gets before it waits for a manual one. */
export const MAX_AUTO_RETRIES = 2;

/**
 * Attempt to publish one Target and persist the outcome.
 *
 * `auto` distinguishes the two ways a failure is handled: `true` (the initial
 * fan-out, or the retry job) schedules another attempt while under
 * {@link MAX_AUTO_RETRIES}; `false` (a User's manual `[Retry]`) always leaves a
 * failure terminal — a manual click is a single explicit attempt, not a re-entry
 * into the automatic chain.
 */
export async function attemptPublish(
  pool: pg.Pool,
  clock: Clock,
  publisher: Publisher,
  post: Post,
  target: Target,
  options: { auto: boolean },
): Promise<Target> {
  const result = await publisher.publish({
    platform: target.platform,
    text: post.text,
    mediaUrl: post.media?.url,
  });

  if (result.ok) {
    return recordTargetOutcome(pool, clock, target.id, {
      status: "published",
      externalId: result.externalId,
      permalink: result.permalink ?? null,
      error: null,
      retryCount: target.retryCount,
      nextRetryAt: null,
    });
  }

  if (options.auto && target.retryCount < MAX_AUTO_RETRIES) {
    return recordTargetOutcome(pool, clock, target.id, {
      status: "pending",
      externalId: null,
      permalink: null,
      error: result.error,
      retryCount: target.retryCount + 1,
      nextRetryAt: new Date(clock.now().getTime() + RETRY_INTERVAL_MS),
    });
  }

  return recordTargetOutcome(pool, clock, target.id, {
    status: "failed",
    externalId: null,
    permalink: null,
    error: result.error,
    retryCount: target.retryCount,
    nextRetryAt: null,
  });
}

/** Recompute a Post's roll-up status from its current Targets, and save it. */
export async function recomputePostStatus(
  pool: pg.Pool,
  clock: Clock,
  postId: string,
): Promise<Target[]> {
  const targets = await listTargets(pool, postId);
  await updatePostStatus(
    pool,
    clock,
    postId,
    rollupStatus(targets.map((target) => target.status)),
  );
  return targets;
}

/**
 * Fan out a freshly-composed Post to every one of its Targets (PRD story 34).
 * Each Target publishes independently — one failing does not stop, delay, or
 * roll back another.
 */
export async function publishPost(
  pool: pg.Pool,
  clock: Clock,
  publisher: Publisher,
  post: Post,
  targets: readonly Target[],
): Promise<Target[]> {
  for (const target of targets) {
    await attemptPublish(pool, clock, publisher, post, target, { auto: true });
  }
  return recomputePostStatus(pool, clock, post.id);
}

/**
 * A User's manual `[Retry]` for one failed Target (PRD story 43).
 *
 * Returns null if there is no such Target or it is not currently `failed` —
 * retrying is only meaningful once the automatic chain has given up.
 */
export async function manualRetryTarget(
  pool: pg.Pool,
  clock: Clock,
  publisher: Publisher,
  post: Post,
  platform: Target["platform"],
): Promise<{ target: Target; targets: Target[] } | null> {
  const target = await findTarget(pool, post.id, platform);
  if (!target || target.status !== "failed") return null;

  await attemptPublish(pool, clock, publisher, post, target, { auto: false });
  const targets = await recomputePostStatus(pool, clock, post.id);
  const updated = targets.find((t) => t.platform === platform)!;
  return { target: updated, targets };
}
