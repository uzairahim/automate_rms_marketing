import type pg from "pg";
import { PLATFORMS, type Platform } from "@smma/core";

/**
 * How many Scheduled Posts a Client has, and how many of them target each
 * platform — the numbers behind the panel's consequence previews (PRD #15
 * stories 38–39).
 *
 * **This is the one place the admin service reads the Client-facing service's
 * tables, and it sits in tension with ADR 0010.** That ADR gives `posts` and
 * `targets` to `@smma/server` and puts the SQL for tables both services touch in
 * `@smma/core`, so that a column change breaks a build rather than production.
 * The read is here anyway, for two reasons: `@smma/core` is the *tenancy and
 * credential* package — pulling the publishing domain's tables into it to serve
 * one panel screen would widen the thing every service depends on — and nothing
 * is duplicated, since the Client-facing service has no such count. The cost is
 * real and is the one PRD #15 already names: a change to a shared table has to
 * ship in an order that keeps the older service working. Move this into
 * `@smma/core` the moment a second caller wants it.
 *
 * It is deliberately read-only and deliberately narrow. Nothing here writes,
 * interprets, or restates any of that domain's rules — it counts rows so an
 * operator can be told what a change is about to break.
 *
 * The counts are a courtesy layer over the invariant in ADR 0011, never a
 * substitute for it: a downgrade or a suspension stops publishing whether or not
 * anyone looked at these numbers first. So this being slightly stale by the time
 * the operator confirms is a cosmetic problem, not a correctness one — which is
 * why it is a plain read with no locking or transaction around it.
 */

/** A Client's Scheduled Posts, totalled and broken down by targeted platform. */
export interface ScheduledPostCounts {
  /** Scheduled Posts this Client has — what suspending it would stop entirely. */
  total: number;
  /**
   * Scheduled Posts with a Target aimed at each platform — what disabling that
   * platform would break. These do not sum to {@link total}: one Post targeting
   * two platforms is counted under both, because it is one Post that each of
   * those two downgrades would partly break.
   */
  byPlatform: Record<Platform, number>;
}

/** Every platform at zero — what a Client with nothing scheduled reports. */
function noneScheduled(): Record<Platform, number> {
  return Object.fromEntries(PLATFORMS.map((platform) => [platform, 0])) as Record<
    Platform,
    number
  >;
}

/**
 * Count one Client's Scheduled Posts, overall and per targeted platform.
 *
 * Only `scheduled` Posts are counted, because they are exactly the ones a change
 * can still break: a Draft has no schedule to miss, and a Post that has already
 * fired is beyond the reach of anything the operator does now.
 *
 * The caller is expected to have established that the Client exists — a Client
 * that does not is not a Client with nothing scheduled, and the two must not
 * report the same thing.
 */
export async function countScheduledPosts(
  pool: pg.Pool,
  clientId: string,
): Promise<ScheduledPostCounts> {
  const [totals, perPlatform] = await Promise.all([
    pool.query<{ total: string }>(
      `SELECT count(*) AS total
       FROM posts
       WHERE client_id = $1 AND status = 'scheduled'`,
      [clientId],
    ),
    // One row per platform. No DISTINCT needed: `targets_post_platform_key`
    // makes a Post's Target for a platform unique, so a row per Target is
    // already a row per Post.
    pool.query<{ platform: string; posts: string }>(
      `SELECT targets.platform, count(*) AS posts
       FROM posts
       JOIN targets ON targets.post_id = posts.id
       WHERE posts.client_id = $1 AND posts.status = 'scheduled'
       GROUP BY targets.platform`,
      [clientId],
    ),
  ]);

  const byPlatform = noneScheduled();
  for (const row of perPlatform.rows) {
    // A platform this build does not know about is skipped rather than added:
    // the shape this returns is the three platforms, and a Target written by a
    // newer deploy of the other service must not widen it.
    if (row.platform in byPlatform) {
      byPlatform[row.platform as Platform] = Number(row.posts);
    }
  }

  return { total: Number(totals.rows[0]?.total ?? 0), byPlatform };
}
