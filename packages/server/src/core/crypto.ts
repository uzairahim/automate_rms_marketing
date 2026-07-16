import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for secrets held at rest (ADR 0006).
 *
 * Platform tokens are the crown jewels: they grant full publishing control over
 * every Client's social presence, so a database dump alone must be useless. The
 * key lives outside the database — in the environment / a secrets manager — and
 * is injected here, never read from the DB and never committed.
 *
 * AES-256-GCM is authenticated: tampering with a stored ciphertext fails to
 * decrypt rather than silently yielding a different token.
 *
 * **Key custody is an operational responsibility.** Lose the key and every
 * Client must reconnect all their social accounts; rotating it requires
 * re-encrypting everything already stored.
 */

/** Bytes in an AES-256 key. */
const KEY_BYTES = 32;
/** Bytes in a GCM nonce. 96 bits is the size GCM is specified around. */
const IV_BYTES = 12;
/** Format tag, so a future key rotation or algorithm change stays decodable. */
const VERSION = "v1";

export interface SecretCipher {
  /** Encrypt a secret for storage. The result is safe to put in a DB column. */
  encrypt(plaintext: string): string;
  /**
   * Recover a secret encrypted by {@link encrypt}.
   *
   * @throws if the ciphertext is malformed, or was encrypted under another key —
   * authentication failure is an error, never a silently wrong value.
   */
  decrypt(ciphertext: string): string;
}

/**
 * Read the token-encryption key from its configured (base64) form.
 *
 * @throws if the key is not exactly 32 bytes — a short key is a silent downgrade
 * of every token's protection, so it fails at startup rather than at rest.
 */
export function parseEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Token encryption key must be ${KEY_BYTES} bytes (base64-encoded); got ${key.length}. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

/** A {@link SecretCipher} backed by AES-256-GCM under the given 32-byte key. */
export function createSecretCipher(key: Buffer): SecretCipher {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Token encryption key must be ${KEY_BYTES} bytes; got ${key.length}.`);
  }

  return {
    encrypt(plaintext: string): string {
      // A fresh random nonce per encryption: reusing one under the same key is
      // the way GCM breaks catastrophically.
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return [
        VERSION,
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        ciphertext.toString("base64"),
      ].join(":");
    },

    decrypt(stored: string): string {
      const [version, iv, tag, ciphertext] = stored.split(":");
      if (version !== VERSION || !iv || !tag || !ciphertext) {
        throw new Error("Malformed encrypted secret.");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return (
        decipher.update(Buffer.from(ciphertext, "base64")).toString("utf8") +
        decipher.final("utf8")
      );
    },
  };
}
