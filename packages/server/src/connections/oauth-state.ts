import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { SecretCipher } from "../core/crypto.js";
import type { Platform, PlatformCredential } from "../core/publisher.js";
import { openCredential, sealCredential } from "./credentials.js";

/**
 * An in-flight OAuth handshake.
 *
 * The `state` parameter is the only thing of ours that survives the round-trip
 * through the platform, so it does the work a session cannot: it names which
 * Client and User the returning callback belongs to. That matters because every
 * Client's handshake comes back through one canonical redirect URI (Meta will
 * not whitelist a wildcard per Client subdomain), so the callback cannot be
 * tenanted by the host it lands on — and must never be trusted to name its own
 * Client. Being unguessable, single-use, and expiring is also what makes it CSRF
 * protection.
 *
 * The handshake is two steps, because between them the User chooses a Page
 * (ADR 0005 — never auto-pick). The user token obtained at the callback is
 * parked here, encrypted (ADR 0006), only until that choice is made.
 */

/**
 * How long a User has to finish the handshake. Long enough to read the Facebook
 * consent screen and pick a Page; short enough that an abandoned state (holding
 * a real user token) does not linger.
 */
const STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface OAuthState {
  state: string;
  clientId: string;
  userId: string;
  platform: Platform;
  /** The user token from the callback — absent until the callback stores one. */
  credential?: PlatformCredential;
}

interface StateRow {
  state: string;
  client_id: string;
  user_id: string;
  platform: string;
  credential: string | null;
  expires_at: Date;
}


/** Begin a handshake: mint a state bound to this Client and User. */
export async function startOAuthState(
  pool: pg.Pool,
  clock: Clock,
  input: { clientId: string; userId: string; platform: Platform },
): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const expiresAt = new Date(clock.now().getTime() + STATE_TTL_MS);
  await pool.query(
    `INSERT INTO oauth_states (state, client_id, user_id, platform, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [state, input.clientId, input.userId, input.platform, expiresAt.toISOString()],
  );
  return state;
}

/**
 * Look up a live handshake, or null if the state is unknown, expired, or for a
 * different platform. Unknown and expired are deliberately indistinguishable to
 * the caller — both mean "start again".
 */
export async function findOAuthState(
  pool: pg.Pool,
  clock: Clock,
  cipher: SecretCipher,
  input: { state: string; platform: Platform },
): Promise<OAuthState | null> {
  const { rows } = await pool.query<StateRow>(
    `SELECT state, client_id, user_id, platform, credential, expires_at
     FROM oauth_states
     WHERE state = $1 AND platform = $2`,
    [input.state, input.platform],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() <= clock.now().getTime()) return null;

  return {
    state: row.state,
    clientId: row.client_id,
    userId: row.user_id,
    platform: input.platform,
    credential: row.credential ? openCredential(cipher, row.credential) : undefined,
  };
}

/** Park the callback's user token on the handshake until a Page is chosen. */
export async function attachCredentialToState(
  pool: pg.Pool,
  cipher: SecretCipher,
  input: { state: string; credential: PlatformCredential },
): Promise<void> {
  await pool.query(`UPDATE oauth_states SET credential = $2 WHERE state = $1`, [
    input.state,
    sealCredential(cipher, input.credential),
  ]);
}

/**
 * End a handshake, dropping the parked user token with it. Called the moment the
 * Page is connected — the state is single-use, and the token it held has been
 * traded for the Page token we actually publish with.
 */
export async function consumeOAuthState(pool: pg.Pool, state: string): Promise<void> {
  await pool.query(`DELETE FROM oauth_states WHERE state = $1`, [state]);
}

/**
 * Drop every handshake that has passed its expiry. Abandoned states hold a real
 * user token, so they are garbage-collected rather than left to accumulate.
 */
export async function purgeExpiredOAuthStates(pool: pg.Pool, clock: Clock): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM oauth_states WHERE expires_at <= $1`, [
    clock.now().toISOString(),
  ]);
  return rowCount ?? 0;
}
