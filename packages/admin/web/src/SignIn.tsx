import { useState, type FormEvent } from "react";
import { ApiError, signIn, type Superadmin } from "./api.js";

/**
 * The operator's sign-in screen.
 *
 * It says nothing about which accounts exist, because the API says nothing: a
 * wrong email and a wrong password come back identically, and the screen simply
 * shows what it was told. No password reset link either — the recovery path is
 * the `create-superadmin` CLI, run by someone with access to the host.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (superadmin: Superadmin) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onSignedIn(await signIn(email, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="signin">
      <div className="signin-panel">
        <p className="signin-eyebrow">Platform administration</p>
        <h1 className="signin-title">Sign in</h1>
        <p className="signin-note">
          Operator access. Every Client on the platform is administered from here.
        </p>

        <form className="card" onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}

          <button type="submit" className="button button-block" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
