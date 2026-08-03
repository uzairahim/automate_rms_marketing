import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { Publisher } from "../core/publisher.js";
import type { SecretCipher } from "../core/crypto.js";
import { markTokenExpiredForPlatform, openAccountCredential } from "../connections/accounts.js";
import { findClientById } from "../tenancy/clients.js";
import { publishBlock } from "../tenancy/eligibility.js";
import { findMediaForPost, settleMediaForPost } from "../media/media.js";
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

/** What {@link attemptPublish} did to a Target. */
export interface PublishAttempt {
  target: Target;
  /**
   * Whether the Client was entitled to publish this Target at all (ADR 0011).
   * `false` means nothing was sent and nothing will be retried — so a caller
   * counting work for an operator must not report it as an attempt.
   */
  eligible: boolean;
}

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
  cipher: SecretCipher,
  post: Post,
  target: Target,
  options: { auto: boolean },
): Promise<PublishAttempt> {
  // The eligibility gate, asked at the moment work fires rather than the moment
  // the request that scheduled it arrived (ADR 0011). Every path that reaches a
  // Publisher — the initial fan-out, the auto-retry tick, a User's manual retry —
  // comes through here, so this one call covers all three. Read fresh: the whole
  // point is that the Plan can have changed since the Post was composed.
  //
  // Terminal, and deliberately *before* the credential is opened: a Target that
  // was never eligible is not retried, because no amount of retrying makes a
  // suspended Client entitled.
  const client = await findClientById(pool, post.clientId);
  const blocked = publishBlock(client?.plan ?? null, target.platform);
  if (blocked) {
    return {
      eligible: false,
      target: await recordTargetOutcome(pool, clock, target.id, {
        status: "failed",
        externalId: null,
        permalink: null,
        error: blocked.message,
        retryCount: target.retryCount,
        nextRetryAt: null,
      }),
    };
  }

  return {
    eligible: true,
    target: await publishOnce(pool, clock, publisher, cipher, post, target, options),
  };
}

/**
 * One eligible publish attempt: open the Connected Account's credential, hand it
 * to the Publisher, and persist whatever came back. Split from the gate above so
 * that adding a reason a Target *never gets here* does not have to thread through
 * every outcome this records.
 */
async function publishOnce(
  pool: pg.Pool,
  clock: Clock,
  publisher: Publisher,
  cipher: SecretCipher,
  post: Post,
  target: Target,
  options: { auto: boolean },
): Promise<Target> {
  // Publishing acts *as* the Connected Account, so its credential is opened here
  // and handed to the transport — which has no database of its own and no other
  // way to reach a token (ADR 0006).
  const account = await openAccountCredential(pool, cipher, post.clientId, target.platform);

  // Connected at compose time, gone by publish time: a Scheduled Post whose
  // account was disconnected or expired while it waited. Terminal on the spot —
  // there is no credential for a retry to use, so burning the auto-retries (and,
  // for a Scheduled Post, the grace window) would only delay the same answer.
  // Not routed through the `auth` path below, because that flips the account to
  // `token_expired`, and a link the User deliberately dropped must stay dropped.
  if (!account) {
    return recordTargetOutcome(pool, clock, target.id, {
      status: "failed",
      externalId: null,
      permalink: null,
      error: `${target.platform} is no longer connected — reconnect it and retry.`,
      retryCount: target.retryCount,
      nextRetryAt: null,
    });
  }

  const result = await publisher.publish({
    platform: target.platform,
    text: post.text,
    mediaUrl: post.media?.url,
    mediaType: post.media?.type,
    credential: account.credential,
    externalId: account.externalId,
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

  // A dead token (ADR 0008) will not come back in a minute, so retrying it only
  // burns the 2x1-min budget and, for a Scheduled Post, the 60-minute grace
  // window before anyone learns the token needs regenerating (PRD #1). Fail this
  // Target now — even on the auto path — and flip the Connected Account to
  // `token_expired` so the User is sent to reconnect rather than left to a Post
  // that quietly failed.
  if (result.reason === "auth") {
    await markTokenExpiredForPlatform(pool, clock, post.clientId, target.platform);
    return recordTargetOutcome(pool, clock, target.id, {
      status: "failed",
      externalId: null,
      permalink: null,
      error: result.error,
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

/**
 * Recompute a Post's roll-up status from its current Targets, save it, and
 * settle its Media's retention accordingly (Slice 9; ADR 0003) — purged
 * immediately if every Target is now Published, scheduled for a 24-hour purge
 * on a partial/total failure, or left untouched if any Target is still
 * non-terminal. This is the *only* place that decision is made, so every
 * caller that can move a Post to a terminal state (initial publish, an
 * auto-retry tick, or a manual retry) goes through it.
 */
export async function recomputePostStatus(
  pool: pg.Pool,
  clock: Clock,
  mediaDir: string,
  postId: string,
): Promise<Target[]> {
  const targets = await listTargets(pool, postId);
  const status = rollupStatus(targets.map((target) => target.status));
  await updatePostStatus(pool, clock, postId, status);
  await settleMediaForPost(pool, clock, mediaDir, postId, status);
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
  cipher: SecretCipher,
  mediaDir: string,
  post: Post,
  targets: readonly Target[],
): Promise<Target[]> {
  for (const target of targets) {
    await attemptPublish(pool, clock, publisher, cipher, post, target, { auto: true });
  }
  return recomputePostStatus(pool, clock, mediaDir, post.id);
}

/** Why a manual retry did not attempt a publish. */
export type ManualRetryBlockedReason = "not_failed" | "media_purged";

export type ManualRetryResult =
  | { ok: true; target: Target; targets: Target[] }
  | { ok: false; reason: ManualRetryBlockedReason };

/**
 * A User's manual `[Retry]` for one failed Target (PRD story 43).
 *
 * Blocked with `not_failed` if there is no such Target or it is not currently
 * `failed` — retrying is only meaningful once the automatic chain has given
 * up. Blocked with `media_purged` if the Post had Media and it has since been
 * purged (Slice 9): retrying with a dead Media URL would only fail again, so
 * the User must re-upload ({@link ../posts/posts.js#attachMedia}) first.
 */
export async function manualRetryTarget(
  pool: pg.Pool,
  clock: Clock,
  publisher: Publisher,
  cipher: SecretCipher,
  mediaDir: string,
  post: Post,
  platform: Target["platform"],
): Promise<ManualRetryResult> {
  const target = await findTarget(pool, post.id, platform);
  if (!target || target.status !== "failed") return { ok: false, reason: "not_failed" };

  if (post.mediaId) {
    const media = await findMediaForPost(pool, post.id);
    if (media && media.status === "purged") {
      return { ok: false, reason: "media_purged" };
    }
  }

  await attemptPublish(pool, clock, publisher, cipher, post, target, { auto: false });
  const targets = await recomputePostStatus(pool, clock, mediaDir, post.id);
  const updated = targets.find((t) => t.platform === platform)!;
  return { ok: true, target: updated, targets };
}
