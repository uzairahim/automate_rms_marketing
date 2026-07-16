import { useState, type FormEvent } from "react";
import { ApiError, apiFetch, setSessionToken } from "./api.js";
import type { Session } from "./session.js";

/**
 * The login screen — a Client's front door, and the first thing anyone sees.
 *
 * It is rendered inside the Client's branding (already resolved from the
 * subdomain before anyone authenticates), so a User never sees an unbranded
 * screen or any hint of the operator.
 *
 * A suspended or expired Client is refused here with the API's own reason, which
 * is the point: the User is told why they cannot get in rather than being left
 * to think they mistyped their password.
 */
export function LoginScreen({ onLoggedIn }: { onLoggedIn: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const session = await apiFetch<Session>("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      setSessionToken(session.token);
      onLoggedIn(session);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not sign in. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: "22rem", marginTop: "2rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 600 }}>Sign in</h2>

      <label style={labelStyle}>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="username"
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          style={inputStyle}
        />
      </label>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", fontSize: "0.875rem" }}>
          {error}
        </p>
      )}

      <button type="submit" disabled={submitting} style={primaryButtonStyle}>
        {submitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

const labelStyle = {
  display: "block",
  marginTop: "1rem",
  fontSize: "0.875rem",
  color: "#334155",
} as const;

const inputStyle = {
  display: "block",
  width: "100%",
  marginTop: "0.25rem",
  padding: "0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: "0.25rem",
  fontSize: "1rem",
} as const;

export const primaryButtonStyle = {
  marginTop: "1.25rem",
  padding: "0.5rem 1rem",
  // The Client's own accent, so even the primary action is theirs.
  background: "var(--brand-primary)",
  color: "#fff",
  border: "none",
  borderRadius: "0.25rem",
  fontSize: "0.938rem",
  cursor: "pointer",
} as const;
