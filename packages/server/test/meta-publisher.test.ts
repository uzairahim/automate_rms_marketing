import { describe, it, expect } from "vitest";
import { graphFailureReason } from "../src/platforms/meta-publisher.js";

/**
 * The one piece of genuinely new logic in the real Meta transport: telling a
 * dead token (`auth`) apart from a transient refusal (ADR 0008, PRD #1). The
 * rest of the transport is integration-verified against a test Page (ADR 0002),
 * but this classification decides whether a background read flips an account to
 * `token_expired` — a wrong call there either strands a live account on a
 * reconnect prompt (a throttle misread as auth) or lets a dead token go
 * unnoticed until a scheduled Post burns its grace window. So it is worth a fast,
 * fetch-free unit test of its own.
 */
describe("graphFailureReason (Meta error classification)", () => {
  it("classifies code 190 — the canonical invalid/expired token — as auth", () => {
    expect(
      graphFailureReason({
        message: "Error validating access token: Session has expired.",
        type: "OAuthException",
        code: 190,
      }),
    ).toBe("auth");
  });

  it("treats a rate limit as transient even though Meta stamps it OAuthException", () => {
    // Codes 4/17/32/613 all arrive as type OAuthException; keying on the type
    // would wrongly flip a perfectly live account to token_expired.
    for (const code of [4, 17, 32, 613]) {
      expect(
        graphFailureReason({ message: "Application request limit reached.", type: "OAuthException", code }),
      ).toBe("transient");
    }
  });

  it("treats a non-OAuth platform error as transient", () => {
    expect(
      graphFailureReason({ message: "An unexpected error occurred.", type: "GraphMethodException", code: 100 }),
    ).toBe("transient");
  });

  it("treats an absent/shapeless error as transient rather than guessing auth", () => {
    expect(graphFailureReason(undefined)).toBe("transient");
    expect(graphFailureReason({})).toBe("transient");
  });
});
