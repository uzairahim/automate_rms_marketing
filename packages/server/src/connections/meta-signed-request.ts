import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta's `signed_request` — how a Meta callback proves it is from Meta.
 *
 * The format is `<signature>.<payload>`, both base64url, where the signature is
 * HMAC-SHA256 over the *encoded payload string* under our app secret. Only Meta
 * and we know that secret, which is the entire basis on which a public,
 * unauthenticated endpoint can be trusted to disconnect a Client's account.
 *
 * Everything here is written to fail closed: any malformed, unsigned, or
 * differently-signed request is simply not from Meta.
 */

/** The subset of Meta's payload we act on. */
export interface SignedRequestPayload {
  /** The Meta user id — the person who authorized us, and now revoked us. */
  userId: string;
}

/**
 * Verify a `signed_request` and return its payload, or null if it is not
 * genuinely from Meta. Null is deliberately undifferentiated: a caller must not
 * be able to tell a bad signature from a bad payload, and neither is actionable.
 */
export function verifySignedRequest(
  appSecret: string,
  signedRequest: string,
): SignedRequestPayload | null {
  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const [signature, encodedPayload] = parts as [string, string];
  if (!signature || !encodedPayload) return null;

  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  const actual = Buffer.from(signature, "base64url");
  // Length-check first: timingSafeEqual throws on a length mismatch.
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const { algorithm, user_id: userId } = payload as Record<string, unknown>;
  // Only the algorithm we actually verified with is acceptable. A payload naming
  // anything else was not checked by the code above, whatever it claims.
  if (algorithm !== "HMAC-SHA256") return null;
  if (typeof userId !== "string" || !userId) return null;

  return { userId };
}
