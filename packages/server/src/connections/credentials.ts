import type { SecretCipher } from "../core/crypto.js";
import type { PlatformCredential } from "../core/publisher.js";

/**
 * The single boundary between a usable {@link PlatformCredential} and its form at
 * rest (ADR 0006).
 *
 * A credential is more than one field — the token, its expiry, who authorized
 * it, and the parent token it was derived from — so it is sealed as one JSON
 * blob into one column rather than spread across columns some of which would end
 * up in plaintext. Everything that persists or recovers a credential goes
 * through here, so there is exactly one place to audit that a token is never
 * written unencrypted.
 *
 * (`token_expires_at` is *also* stored as a plain column, deliberately: the
 * refresh job has to query on it, and an expiry date is not a secret. The token
 * itself only ever exists inside the sealed blob.)
 */

/** The sealed JSON shape. Kept explicit so a field is never silently added. */
interface CredentialJson {
  accessToken: string;
  expiresAt?: string;
  refreshable: boolean;
  platformUserId?: string;
  parentToken?: string;
}

/** Encrypt a credential for storage. The only form it is ever persisted in. */
export function sealCredential(cipher: SecretCipher, credential: PlatformCredential): string {
  const json: CredentialJson = {
    accessToken: credential.accessToken,
    expiresAt: credential.expiresAt?.toISOString(),
    refreshable: credential.refreshable,
    platformUserId: credential.platformUserId,
    parentToken: credential.parentToken,
  };
  return cipher.encrypt(JSON.stringify(json));
}

/**
 * Recover a credential sealed by {@link sealCredential}.
 *
 * @throws if the blob was sealed under a different key — which, per ADR 0006, is
 * an operational emergency (the key was lost or rotated without re-encrypting),
 * not something a caller should paper over.
 */
export function openCredential(cipher: SecretCipher, sealed: string): PlatformCredential {
  const json = JSON.parse(cipher.decrypt(sealed)) as CredentialJson;
  return {
    accessToken: json.accessToken,
    expiresAt: json.expiresAt ? new Date(json.expiresAt) : undefined,
    refreshable: json.refreshable,
    platformUserId: json.platformUserId,
    parentToken: json.parentToken,
  };
}
