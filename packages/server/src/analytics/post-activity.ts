import type pg from "pg";
import { PLATFORMS, type Platform } from "../core/publisher.js";
import type { PostStatus } from "../posts/posts.js";
import type { DateRange } from "./range.js";

/**
 * What this Client actually published, read out of our own records.
 *
 * The other half of the dashboard ({@link ./metric-snapshots.ts}) trends what the
 * *platforms* report about an account. This half trends what *we* did: how many
 * Targets landed, which ones did not, and what is still queued to go out. It
 * needs no platform round-trip at all — every number here is already in our
 * database the moment a Target settles — which is what keeps the dashboard an
 * instant read rather than three authenticated API calls deep (contrast the Post
 * history list, which pays a live fetch per row for its thumbnail, ADR 0003).
 *
 * The grain is the **Target**, not the Post, everywhere a delivery is counted. A
 * Post fans out to several platforms and each one publishes independently — one
 * can succeed while a sibling fails, and neither is rolled back for the other
 * (CONTEXT.md `Target`). Counting Posts would have to pick a winner between them;
 * counting Targets says exactly what happened.
 *
 * A delivery is dated by the Target's `updated_at`, which is when its outcome was
 * recorded — so a Target that failed on Monday and was retried into success on
 * Tuesday counts as Tuesday's delivery, which is the day it is actually live.
 */

/** One day's deliveries. Every day in the range is present, zeros included. */
export interface DeliveryPoint {
  /** The calendar day, `YYYY-MM-DD`, in the Client's timezone. */
  date: string;
  published: number;
  failed: number;
}

/** One platform's outcomes over the range — its share of the work, and its reliability. */
export interface PlatformDelivery {
  platform: Platform;
  published: number;
  failed: number;
}

/** How many Posts *composed* in the range ended in each state. */
export type PostStatusCounts = Record<PostStatus, number>;

/**
 * What is still ahead. Deliberately *not* scoped to the range: a Post scheduled
 * for next month is not in the last 30 days, and a User looking at the dashboard
 * still needs to know it is coming.
 */
export interface Upcoming {
  scheduled: number;
  drafts: number;
  /** The soonest Scheduled Post's time, UTC — null when nothing is scheduled. */
  nextScheduledAt: string | null;
}

export interface PostActivity {
  daily: DeliveryPoint[];
  byPlatform: PlatformDelivery[];
  posts: PostStatusCounts;
  upcoming: Upcoming;
}

/** Postgres returns `count(*)` as a bigint, which `pg` hands back as a string. */
function count(value: string | number | null): number {
  return Number(value ?? 0);
}

const ZERO_STATUS_COUNTS = (): PostStatusCounts => ({
  draft: 0,
  scheduled: 0,
  publishing: 0,
  published: 0,
  partially_published: 0,
  failed: 0,
});

/**
 * A Client's publishing activity over `range`.
 *
 * Four reads rather than one join: they answer four different questions at three
 * different grains (a day, a platform, a Post, and the backlog), and forcing them
 * into a single statement would produce a cross-product that each consumer then
 * has to undo. Each is a cheap indexed scan over one Client's own rows.
 */
export async function postActivity(
  pool: pg.Pool,
  clientId: string,
  timezone: string,
  range: DateRange,
): Promise<PostActivity> {
  const scope = [clientId, timezone, range.from, range.to];

  // `generate_series` supplies the calendar, so a day with nothing published
  // arrives as a zero rather than as a missing point. A bar chart with holes in
  // it reads as "no data" where the truth is "nothing went out that day".
  const daily = await pool.query<{ date: string; published: string; failed: string }>(
    `WITH days AS (
       SELECT generate_series($3::date, $4::date, interval '1 day')::date AS day
     ),
     deliveries AS (
       SELECT t.status, (t.updated_at AT TIME ZONE $2)::date AS day
       FROM targets t
       JOIN posts p ON p.id = t.post_id
       WHERE p.client_id = $1 AND t.status IN ('published', 'failed')
     )
     SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
            COUNT(*) FILTER (WHERE deliveries.status = 'published') AS published,
            COUNT(*) FILTER (WHERE deliveries.status = 'failed')    AS failed
     FROM days
     LEFT JOIN deliveries ON deliveries.day = days.day
     GROUP BY days.day
     ORDER BY days.day ASC`,
    scope,
  );

  const byPlatform = await pool.query<{ platform: string; published: string; failed: string }>(
    `SELECT t.platform,
            COUNT(*) FILTER (WHERE t.status = 'published') AS published,
            COUNT(*) FILTER (WHERE t.status = 'failed')    AS failed
     FROM targets t
     JOIN posts p ON p.id = t.post_id
     WHERE p.client_id = $1
       AND t.status IN ('published', 'failed')
       AND (t.updated_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
     GROUP BY t.platform`,
    scope,
  );

  // Dated by composition, not delivery: this is "of what we wrote in this window,
  // how did it end up" — a different question from the per-day deliveries above,
  // and the one a `failed` or `partially_published` count is actually about.
  const posts = await pool.query<{ status: string; total: string }>(
    `SELECT status, COUNT(*) AS total
     FROM posts
     WHERE client_id = $1
       AND (created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
     GROUP BY status`,
    scope,
  );

  const upcoming = await pool.query<{
    scheduled: string;
    drafts: string;
    next_scheduled_at: Date | null;
  }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'scheduled') AS scheduled,
            COUNT(*) FILTER (WHERE status = 'draft')     AS drafts,
            MIN(scheduled_at) FILTER (WHERE status = 'scheduled') AS next_scheduled_at
     FROM posts
     WHERE client_id = $1`,
    [clientId],
  );

  const statusCounts = ZERO_STATUS_COUNTS();
  for (const row of posts.rows) {
    statusCounts[row.status as PostStatus] = count(row.total);
  }

  const deliveryByPlatform = new Map(
    byPlatform.rows.map((row) => [
      row.platform as Platform,
      {
        platform: row.platform as Platform,
        published: count(row.published),
        failed: count(row.failed),
      },
    ]),
  );

  const backlog = upcoming.rows[0];

  return {
    daily: daily.rows.map((row) => ({
      date: row.date,
      published: count(row.published),
      failed: count(row.failed),
    })),
    // Canonical platform order, and only platforms that actually did something —
    // a row of zeros for a platform this Client never posted to is noise, and the
    // per-account section above it already says what is connected.
    byPlatform: PLATFORMS.filter((platform) => deliveryByPlatform.has(platform)).map(
      (platform) => deliveryByPlatform.get(platform)!,
    ),
    posts: statusCounts,
    upcoming: {
      scheduled: count(backlog?.scheduled ?? 0),
      drafts: count(backlog?.drafts ?? 0),
      nextScheduledAt: backlog?.next_scheduled_at?.toISOString() ?? null,
    },
  };
}
