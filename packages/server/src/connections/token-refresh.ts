import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { SecretCipher } from "../core/crypto.js";
import { PublisherError, type Platform, type Publisher } from "../core/publisher.js";
import { openCredential, sealCredential } from "./credentials.js";

/**
 * Keeping a Connected Account's token valid.
 *
 * A Page token that expires unnoticed doesn't announce itself — the Client just
 * finds their Posts failing, for a reason no one can see from inside the app.
 * So this job renews tokens well before expiry, and when a token can't be
 * renewed it says so on the account (`token_expired`) instead of leaving the
 * User to discover it at publish time.
 *
 * Due accounts are found by querying for them each tick, mirroring the
 * scheduler's approach (ADR/PRD): nothing is held in memory, so a restart never
 * drops a refresh.
 *
 * ADR 0002: the renewal itself goes through the Publisher seam, so this logic is
 * exercised entirely against the fake.
 */

/**
 * How far ahead of expiry a token is renewed.
 *
 * Meta's long-lived Page tokens last ~60 days, so a week's head start leaves
 * ample room for the job (or the whole server) to be down for days without a
 * Client ever noticing — while still being short enough that we aren't
 * needlessly churning tokens.
 */
export const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RefreshOutcome {
  /** Accounts whose token was renewed. */
  refreshed: number;
  /** Accounts the platform refused to renew, now marked `token_expired`. */
  expired: number;
}

interface DueRow {
  id: string;
  platform: string;
  credential: string;
  external_id: string;
}

/**
 * Renew every Connected Account token nearing expiry. Returns what happened, for
 * the caller to log.
 *
 * Each account is refreshed independently: one Client's dead token must not stop
 * another Client's from being renewed, so a failure marks that account and the
 * job carries on.
 */
export async function refreshDueTokens(
  pool: pg.Pool,
  clock: Clock,
  cipher: SecretCipher,
  publisher: Publisher,
): Promise<RefreshOutcome> {
  const dueBy = new Date(clock.now().getTime() + REFRESH_WINDOW_MS);

  // Only accounts that are connected, refreshable (ADR 0008: a hand-pasted token
  // isn't), have a known expiry, and are inside the window. An account already
  // marked token_expired is excluded by `status` — we've said our piece; it is
  // the User's move now.
  const { rows } = await pool.query<DueRow>(
    `SELECT id, platform, credential, external_id
     FROM connected_accounts
     WHERE status = 'connected'
       AND refreshable
       AND credential IS NOT NULL
       AND external_id IS NOT NULL
       AND token_expires_at IS NOT NULL
       AND token_expires_at <= $1
     ORDER BY token_expires_at ASC`,
    [dueBy.toISOString()],
  );

  const outcome: RefreshOutcome = { refreshed: 0, expired: 0 };

  for (const row of rows) {
    const platform = row.platform as Platform;
    try {
      const current = openCredential(cipher, row.credential);
      const renewed = await publisher.refreshCredential({
        platform,
        credential: current,
        // Which destination this credential is for: a transport may have to
        // re-derive the token per-destination rather than extend it in place.
        externalId: row.external_id,
      });

      await pool.query(
        `UPDATE connected_accounts SET
           credential       = $2,
           token_expires_at = $3,
           refreshable      = $4,
           updated_at       = $5
         WHERE id = $1`,
        [
          row.id,
          sealCredential(cipher, renewed),
          renewed.expiresAt?.toISOString() ?? null,
          renewed.refreshable,
          clock.now().toISOString(),
        ],
      );
      outcome.refreshed += 1;
    } catch (err) {
      // A platform refusal is expected operation, not a bug: the person may have
      // changed their password or revoked us. Anything else (a decrypt failure —
      // e.g. the wrong key — or a DB error) is not something to paper over by
      // blaming the Client's token, so it is re-thrown.
      if (!(err instanceof PublisherError)) throw err;

      await pool.query(
        `UPDATE connected_accounts SET
           status     = 'token_expired',
           updated_at = $2
         WHERE id = $1`,
        [row.id, clock.now().toISOString()],
      );
      outcome.expired += 1;
    }
  }

  return outcome;
}
