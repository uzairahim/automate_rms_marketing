import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { SecretCipher } from "../core/crypto.js";
import type { Platform, PlatformCredential } from "../core/publisher.js";
import { sealCredential } from "./credentials.js";

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
 * Unlink every account a person authorized on a platform — the platform's own
 * "this person revoked you" signal (Meta's deauthorization callback).
 *
 * Keyed by the authorizing person rather than the Client, because that is all
 * the platform tells us. Returns how many accounts were unlinked.
 */
export async function disconnectByPlatformUser(
  pool: pg.Pool,
  clock: Clock,
  input: { platform: Platform; platformUserId: string },
): Promise<number> {
  // The WHERE reads platform_user_id, which CLEARED_ON_DISCONNECT nulls — that
  // is fine (Postgres evaluates the predicate against the pre-update row) and is
  // what makes a repeated deauthorization a no-op rather than an error.
  const { rowCount } = await pool.query(
    `UPDATE connected_accounts SET ${CLEARED_ON_DISCONNECT}
     WHERE platform = $1 AND platform_user_id = $2 AND status <> 'disconnected'`,
    [input.platform, input.platformUserId, clock.now().toISOString()],
  );
  return rowCount ?? 0;
}
