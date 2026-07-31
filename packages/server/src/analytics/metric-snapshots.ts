import type pg from "pg";
import { PLATFORMS, type AccountMetrics, type Platform } from "../core/publisher.js";
import type { DateRange } from "./range.js";

/**
 * The Metric Snapshot store (CONTEXT.md `Metric Snapshot`; ADR 0004).
 *
 * A daily record of one Connected Account's account-level numbers — followers,
 * reach/impressions, engagement, posts published — kept so the dashboard can show
 * trends over time. This is the one place the design stores platform data rather
 * than live-fetching it: the numbers are tiny and the dashboard needs uniform,
 * instant, cross-platform trend lines that no platform's native history could
 * give on its own (ADR 0004). Per-post metrics, by contrast, stay live-only
 * ({@link ../posts/post-reads.ts}).
 *
 * Writes go through {@link recordSnapshot}, which the daily job calls once per
 * connected account; reads go through {@link accountAnalytics}, which the
 * dashboard calls once per Client.
 */

/** One day's point on an account's trend line — every metric nullable (ADR 0004). */
export interface DailyMetricPoint {
  /** The calendar day, `YYYY-MM-DD`, in the Client's timezone. */
  date: string;
  followers: number | null;
  reach: number | null;
  engagement: number | null;
  postsPublished: number | null;
}

/**
 * One connected platform's whole trend, as the dashboard renders it. The shape is
 * identical for Facebook, Instagram, and TikTok — the dashboard charts one thing,
 * not three (ADR 0004) — and `series` starts at the account's first snapshot, so
 * an account only just connected simply has an empty series rather than a gap to
 * explain (there is no backfill of pre-connection history).
 */
export interface AccountSeries {
  platform: Platform;
  /** The account's name, for the User to recognize which destination this is. */
  displayName: string | null;
  series: DailyMetricPoint[];
}

/**
 * Record (or update) one account's snapshot for a given day. Upserts on
 * (account, day): re-running the daily job overwrites the day's row rather than
 * stacking duplicates, so a retried or double-fired tick is harmless.
 *
 * `snapshotDate` is a `YYYY-MM-DD` string already resolved in the Client's
 * timezone by the caller — the store does not decide what day it is.
 */
export async function recordSnapshot(
  pool: pg.Pool,
  input: {
    connectedAccountId: string;
    snapshotDate: string;
    metrics: AccountMetrics;
  },
): Promise<void> {
  const { metrics } = input;
  await pool.query(
    `INSERT INTO metric_snapshots
       (connected_account_id, snapshot_date, followers, reach, engagement, posts_published)
     VALUES ($1, $2::date, $3, $4, $5, $6)
     ON CONFLICT ON CONSTRAINT metric_snapshots_account_date_key DO UPDATE SET
       followers       = EXCLUDED.followers,
       reach           = EXCLUDED.reach,
       engagement      = EXCLUDED.engagement,
       posts_published = EXCLUDED.posts_published`,
    [
      input.connectedAccountId,
      input.snapshotDate,
      metrics.followers ?? null,
      metrics.reach ?? null,
      metrics.engagement ?? null,
      metrics.postsPublished ?? null,
    ],
  );
}

interface SeriesRow {
  platform: string;
  display_name: string | null;
  // Null for a connected account that has no snapshot yet (the LEFT JOIN below).
  snapshot_date: string | null;
  followers: number | null;
  reach: number | null;
  engagement: number | null;
  posts_published: number | null;
}

/**
 * A Client's account-level analytics: one trend per *connected* platform, each an
 * ordered series of daily points within `range`.
 *
 * Scoped to the Client's currently-connected accounts, so the dashboard reflects
 * what the Client has connected right now — a platform it never connected does
 * not appear, and one Client can never read another's numbers. A LEFT JOIN keeps
 * a freshly-connected account (no snapshots yet) in the result with an empty
 * series, so the dashboard renders it gracefully rather than dropping it.
 *
 * The range is applied in the JOIN rather than in the WHERE for exactly that
 * reason: filtering afterwards would drop an account whose snapshots all fall
 * outside the window, when what the dashboard needs is the account present and
 * the series empty.
 *
 * `snapshot_date` is read back as text (`::text`) so a day is exactly the
 * `YYYY-MM-DD` that was stored, never shifted by the driver's date parsing.
 */
export async function accountAnalytics(
  pool: pg.Pool,
  clientId: string,
  range: DateRange,
): Promise<AccountSeries[]> {
  const { rows } = await pool.query<SeriesRow>(
    `SELECT ca.platform,
            ca.display_name,
            ms.snapshot_date::text AS snapshot_date,
            ms.followers,
            ms.reach,
            ms.engagement,
            ms.posts_published
     FROM connected_accounts ca
     LEFT JOIN metric_snapshots ms
            ON ms.connected_account_id = ca.id
           AND ms.snapshot_date BETWEEN $2::date AND $3::date
     WHERE ca.client_id = $1 AND ca.status = 'connected'
     ORDER BY ca.platform ASC, ms.snapshot_date ASC`,
    [clientId, range.from, range.to],
  );

  const byPlatform = new Map<Platform, AccountSeries>();
  for (const row of rows) {
    const platform = row.platform as Platform;
    let account = byPlatform.get(platform);
    if (!account) {
      account = { platform, displayName: row.display_name, series: [] };
      byPlatform.set(platform, account);
    }
    // A null date is the LEFT JOIN's "connected but no snapshot yet" — it keeps
    // the account in the result, but contributes no point to the series.
    if (row.snapshot_date) {
      account.series.push({
        date: row.snapshot_date,
        followers: row.followers,
        reach: row.reach,
        engagement: row.engagement,
        postsPublished: row.posts_published,
      });
    }
  }

  // Canonical platform order, so the dashboard lays the platforms out the same
  // way every load regardless of connect order.
  return PLATFORMS.filter((platform) => byPlatform.has(platform)).map(
    (platform) => byPlatform.get(platform)!,
  );
}
