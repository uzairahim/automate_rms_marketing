import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { SecretCipher } from "../core/crypto.js";
import { PublisherError, type Platform, type Publisher } from "../core/publisher.js";
import { openCredential } from "../connections/credentials.js";
import { recordSnapshot } from "./metric-snapshots.js";

/**
 * The daily metric-snapshot job (ADR 0004) — the third of the recurring jobs the
 * PRD calls for, alongside the token-refresh tick and the minute scheduler.
 *
 * Once a day it reads each connected account's current account-level numbers
 * through the Publisher seam (ADR 0002) and stores them, so the dashboard can
 * trend them over time. Like the other recurring jobs it finds its work by
 * querying — nothing is held in memory — and reads each account independently:
 * one platform's outage or throttling skips that one account and the job carries
 * on, exactly as the token-refresh job does, so one Client's dead read can never
 * cost another Client its day's numbers.
 *
 * ADR 0004: trends only exist from the day snapshotting starts for an account —
 * there is no backfill of pre-connection history, and none is attempted here.
 */

export interface SnapshotOutcome {
  /** Accounts whose numbers were recorded this run. */
  recorded: number;
  /** Accounts the platform refused to report on, skipped for today. */
  skipped: number;
}

interface AccountRow {
  id: string;
  platform: string;
  external_id: string;
  credential: string;
  timezone: string;
}

/**
 * The calendar day a snapshot belongs to, in the Client's own timezone
 * (CONTEXT.md `Client`: all analytics are anchored to it). Two Clients snapshotted
 * by the same nightly tick can land on different dates if their timezones put them
 * on different sides of midnight — which is the point: each Client's trend is in
 * its own days, not the server's.
 *
 * `en-CA` formats as `YYYY-MM-DD`, which is exactly the column's stored form.
 */
export function snapshotDateFor(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Snapshot every connected account's account-level numbers for today. Returns
 * what happened, for the caller to log.
 */
export async function recordDailySnapshots(
  pool: pg.Pool,
  clock: Clock,
  cipher: SecretCipher,
  publisher: Publisher,
): Promise<SnapshotOutcome> {
  // Only accounts we can actually read: connected, with a credential and a
  // destination id. A disconnected/expired slot has no token to read with and no
  // day worth recording — its earlier snapshots simply stop.
  const { rows } = await pool.query<AccountRow>(
    `SELECT ca.id, ca.platform, ca.external_id, ca.credential, c.timezone
     FROM connected_accounts ca
     JOIN clients c ON c.id = ca.client_id
     WHERE ca.status = 'connected'
       AND ca.credential IS NOT NULL
       AND ca.external_id IS NOT NULL
     ORDER BY ca.id`,
  );

  const outcome: SnapshotOutcome = { recorded: 0, skipped: 0 };
  const now = clock.now();

  for (const row of rows) {
    const platform = row.platform as Platform;
    try {
      const credential = openCredential(cipher, row.credential);
      const metrics = await publisher.fetchAccountMetrics({
        platform,
        credential,
        externalId: row.external_id,
      });

      await recordSnapshot(pool, {
        connectedAccountId: row.id,
        snapshotDate: snapshotDateFor(now, row.timezone),
        metrics,
      });
      outcome.recorded += 1;
    } catch (err) {
      // A platform refusing a read is ordinary operation (throttled, briefly
      // down) — skip today's snapshot for that account and move on. Anything else
      // (a decrypt failure from the wrong key, a DB error) is a real fault worth
      // surfacing, so it is re-thrown, mirroring the token-refresh job.
      if (!(err instanceof PublisherError)) throw err;
      outcome.skipped += 1;
    }
  }

  return outcome;
}
