import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { SecretCipher } from "../core/crypto.js";
import type { Platform, PlatformCredential } from "../core/publisher.js";
import { openCredential, sealCredential } from "./credentials.js";

/**
 * The Connected Account store — a Client's social destinations.
 *
 * A Client has at most one account per platform (CONTEXT.md `Client`), enforced
 * by a DB constraint rather than a check-then-insert — so "connect" is an upsert
 * onto the Client's one slot for that platform, and reconnecting after a
 * disconnect reuses it.
 *
 * No read path here returns a credential: {@link ConnectedAccount} has no field
 * for one, so a token cannot reach a route by accident. Credentials are sealed
 * on the way in by {@link sealCredential} and only unsealed where they are
 * actually used — today that is the token-refresh job (ADR 0006).
 */

/**
 * A Connected Account's state.
 *
 * `disconnected` is the resting state of a slot nobody is using — whether it was
 * never connected, the User disconnected it, or the person revoked us from
 * Facebook's side. `token_expired` is distinct because the User must *do*
 * something: the link is broken but intended, so we say "reconnect" rather than
 * quietly showing nothing.
 */
export const CONNECTION_STATUSES = ["connected", "disconnected", "token_expired"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** A Connected Account as any read path sees it — never including a credential. */
export interface ConnectedAccount {
  platform: Platform;
  status: ConnectionStatus;
  /** The Page id we publish to. Null once disconnected. */
  externalId: string | null;
  /** The Page's name, for the User to recognize what is linked. */
  displayName: string | null;
  connectedAt: string | null;
  /** When the stored token stops working, if the platform told us. */
  tokenExpiresAt: string | null;
}

interface AccountRow {
  platform: string;
  status: string;
  external_id: string | null;
  display_name: string | null;
  connected_at: Date | null;
  token_expires_at: Date | null;
}

const ACCOUNT_COLUMNS = `platform, status, external_id, display_name, connected_at, token_expires_at`;

function accountFromRow(row: AccountRow): ConnectedAccount {
  return {
    platform: row.platform as Platform,
    status: row.status as ConnectionStatus,
    externalId: row.external_id,
    displayName: row.display_name,
    connectedAt: row.connected_at?.toISOString() ?? null,
    tokenExpiresAt: row.token_expires_at?.toISOString() ?? null,
  };
}

/**
 * Everything a disconnect clears, so a slot that was unlinked is indistinguishable
 * from one that was never linked — the User sees one "not connected" state, and
 * there is no stale Page id or token left behind to be used by mistake. `$3` is
 * the disconnect time.
 */
const CLEARED_ON_DISCONNECT = /* sql */ `
  status           = 'disconnected',
  credential       = NULL,
  external_id      = NULL,
  display_name     = NULL,
  platform_user_id = NULL,
  token_expires_at = NULL,
  connected_at     = NULL,
  updated_at       = $3
`;

/**
 * Link a destination to a Client's one slot for that platform, replacing
 * whatever was there. Reconnecting a platform is the same operation as
 * connecting it for the first time.
 */
export async function connectAccount(
  pool: pg.Pool,
  clock: Clock,
  cipher: SecretCipher,
  input: {
    clientId: string;
    platform: Platform;
    externalId: string;
    displayName: string;
    credential: PlatformCredential;
  },
): Promise<ConnectedAccount> {
  const now = clock.now().toISOString();
  const { rows } = await pool.query<AccountRow>(
    `INSERT INTO connected_accounts
       (client_id, platform, status, external_id, display_name, platform_user_id,
        credential, token_expires_at, refreshable, connected_at, updated_at)
     VALUES ($1, $2, 'connected', $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT ON CONSTRAINT connected_accounts_client_platform_key DO UPDATE SET
       status           = 'connected',
       external_id      = EXCLUDED.external_id,
       display_name     = EXCLUDED.display_name,
       platform_user_id = EXCLUDED.platform_user_id,
       credential       = EXCLUDED.credential,
       token_expires_at = EXCLUDED.token_expires_at,
       refreshable      = EXCLUDED.refreshable,
       connected_at     = EXCLUDED.connected_at,
       updated_at       = EXCLUDED.updated_at
     RETURNING ${ACCOUNT_COLUMNS}`,
    [
      input.clientId,
      input.platform,
      input.externalId,
      input.displayName,
      input.credential.platformUserId ?? null,
      sealCredential(cipher, input.credential),
      input.credential.expiresAt?.toISOString() ?? null,
      input.credential.refreshable,
      now,
    ],
  );
  return accountFromRow(rows[0]!);
}

/** A Client's Connected Accounts, in canonical platform order. */
export async function listAccounts(
  pool: pg.Pool,
  clientId: string,
): Promise<ConnectedAccount[]> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM connected_accounts WHERE client_id = $1`,
    [clientId],
  );
  return rows.map(accountFromRow);
}

/** One Client's account for a platform, or null if it has never had one. */
export async function findAccount(
  pool: pg.Pool,
  clientId: string,
  platform: Platform,
): Promise<ConnectedAccount | null> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM connected_accounts
     WHERE client_id = $1 AND platform = $2`,
    [clientId, platform],
  );
  const row = rows[0];
  return row ? accountFromRow(row) : null;
}

/**
 * A live account's destination *and* its usable credential — the one read path
 * that unseals one, and deliberately the only one.
 *
 * It exists because connecting Instagram is an act of the connected Page: the IG
 * account is reachable only through the Page's own token (ADR 0005), and by then
 * the authorizing person's token is long gone. So the Page's stored credential is
 * genuinely the input to that flow.
 *
 * Kept separate from {@link findAccount} rather than folded into it, so that the
 * ordinary read path still cannot return a token by accident: reaching a
 * credential takes calling the function whose name says so.
 *
 * Returns null unless the account is `connected` — a disconnected or expired slot
 * has no credential we may use.
 */
export async function openAccountCredential(
  pool: pg.Pool,
  cipher: SecretCipher,
  clientId: string,
  platform: Platform,
): Promise<{ externalId: string; credential: PlatformCredential } | null> {
  const { rows } = await pool.query<{ external_id: string; credential: string }>(
    `SELECT external_id, credential FROM connected_accounts
     WHERE client_id = $1 AND platform = $2 AND status = 'connected'
       AND credential IS NOT NULL AND external_id IS NOT NULL`,
    [clientId, platform],
  );
  const row = rows[0];
  if (!row) return null;
  return { externalId: row.external_id, credential: openCredential(cipher, row.credential) };
}

/**
 * Move a Connected Account into the `token_expired` reconnect state — the single
 * place that transition is made, so every discoverer of a dead token (the token
 * refresh job, the daily snapshot, a publish that hits a dead token) records it
 * the same way.
 *
 * Guarded to `status = 'connected'`: a slot that was disconnected or already
 * expired is left as it is, so a stray dead-token signal can never resurrect a
 * link the User deliberately dropped. The credential is deliberately *kept* —
 * unlike a disconnect — because the whole point of the state is that the same
 * Page is still linked and the User is regenerating a token for it (ADR 0008).
 */
async function expireTokenWhere(
  pool: pg.Pool,
  clock: Clock,
  predicate: string,
  params: unknown[],
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE connected_accounts
       SET status = 'token_expired', updated_at = $${params.length + 1}
     WHERE ${predicate} AND status = 'connected'`,
    [...params, clock.now().toISOString()],
  );
  return (rowCount ?? 0) > 0;
}

/** Expire a Connected Account by its id — the background jobs, which hold the row id. */
export async function markTokenExpired(
  pool: pg.Pool,
  clock: Clock,
  accountId: string,
): Promise<boolean> {
  return expireTokenWhere(pool, clock, "id = $1", [accountId]);
}

/**
 * Expire a Client's account for a platform — the publish path, which knows a
 * Target by its Client and platform rather than the account row id.
 */
export async function markTokenExpiredForPlatform(
  pool: pg.Pool,
  clock: Clock,
  clientId: string,
  platform: Platform,
): Promise<boolean> {
  return expireTokenWhere(pool, clock, "client_id = $1 AND platform = $2", [clientId, platform]);
}

/**
 * Unlink a Client's account for a platform, dropping the credential with it —
 * a token we no longer have permission to use is a liability, not an
 * optimization for a possible reconnect.
 *
 * Returns whether anything was actually connected.
 */
export async function disconnectAccount(
  pool: pg.Pool,
  clock: Clock,
  input: { clientId: string; platform: Platform },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE connected_accounts SET ${CLEARED_ON_DISCONNECT}
     WHERE client_id = $1 AND platform = $2 AND status <> 'disconnected'`,
    [input.clientId, input.platform, clock.now().toISOString()],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Unlink every account a person authorized across the given platforms — the
 * platform's own "this person revoked you" signal (Meta's deauthorization
 * callback).
 *
 * Keyed by the authorizing person rather than the Client, because that is all
 * the platform tells us. Takes several platforms because one revocation can void
 * more than one kind of account: a person revoking us on Facebook also voids the
 * Instagram accounts we reach through their Pages, since those publish with a
 * Page token that revocation just killed.
 *
 * Returns how many accounts were unlinked.
 */
export async function disconnectByPlatformUser(
  pool: pg.Pool,
  clock: Clock,
  input: { platforms: readonly Platform[]; platformUserId: string },
): Promise<number> {
  // The WHERE reads platform_user_id, which CLEARED_ON_DISCONNECT nulls — that
  // is fine (Postgres evaluates the predicate against the pre-update row) and is
  // what makes a repeated deauthorization a no-op rather than an error.
  const { rowCount } = await pool.query(
    `UPDATE connected_accounts SET ${CLEARED_ON_DISCONNECT}
     WHERE platform = ANY($1) AND platform_user_id = $2 AND status <> 'disconnected'`,
    [input.platforms, input.platformUserId, clock.now().toISOString()],
  );
  return rowCount ?? 0;
}
