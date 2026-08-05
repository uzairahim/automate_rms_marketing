import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  createUser,
  isSessionEnded,
  listUsers,
  resetUserPassword,
  type IssuedCredential,
  type User,
} from "./api.js";
import { OneTimePassword } from "./OneTimePassword.js";

/**
 * Who can log in to this Client, and how they got their credentials.
 *
 * The section an operator opens the panel for. Its whole shape follows from one
 * decision: the operator never types a password. They supply an email, the
 * platform generates the credential, and it is shown once — so this screen has
 * an "add" form with a single field, and a place for something that exists for
 * one moment and then does not.
 *
 * That once-shown credential is held in its own state rather than in the list,
 * and is cleared the moment anything else happens here. A password sitting on
 * screen after the operator has moved on is the failure mode worth designing
 * against — it is the one piece of data on this panel that is worth stealing off
 * an unattended monitor.
 */
export function Users({
  clientId,
  subdomain,
  onSessionEnded,
}: {
  clientId: string;
  subdomain: string;
  onSessionEnded: () => void;
}) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  /** Which User a reset is in flight for, so only that row's button is busy. */
  const [resetting, setResetting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listUsers(clientId)
      .then((loaded) => {
        if (!cancelled) setUsers(loaded);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (isSessionEnded(err)) onSessionEnded();
        else setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, onSessionEnded]);

  /**
   * Run an action that issues a credential, and show what came back.
   *
   * Any password already on screen is cleared *before* the request rather than
   * after it, so a failure cannot leave the previous one sitting there looking
   * like the result of what the operator just did.
   */
  async function issuing(
    action: () => Promise<IssuedCredential>,
    fallback: string,
  ): Promise<void> {
    setError(null);
    setIssued(null);
    try {
      setIssued(await action());
    } catch (err) {
      if (isSessionEnded(err)) return onSessionEnded();
      setError(err instanceof ApiError ? err.message : fallback);
      return;
    }

    // Refreshing the list is a separate concern from issuing the credential, and
    // deliberately cannot disturb it: the password above exists nowhere else, so
    // a stale list is a far smaller problem than dropping the operator at the
    // sign-in form — or telling them the create failed — while holding the only
    // copy of something that actually succeeded.
    try {
      setUsers(await listUsers(clientId));
    } catch {
      setError("The User list may be out of date — reopen this Client to refresh it.");
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await issuing(
      async () => {
        const credential = await createUser(clientId, email);
        setEmail("");
        return credential;
      },
      "Could not create the User. Please try again.",
    );
    setBusy(false);
  }

  async function reset(user: User) {
    setResetting(user.id);
    await issuing(
      () => resetUserPassword(clientId, user.id),
      "Could not reset the password. Please try again.",
    );
    setResetting(null);
  }

  return (
    <section className="section">
      <h3 className="subsection-title">Users</h3>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {issued && (
        <OneTimePassword credential={issued} onDismiss={() => setIssued(null)} />
      )}

      {!error && users === null && <p className="loading">Loading Users…</p>}

      {users?.length === 0 && (
        <p className="placeholder">
          No Users yet. Nobody can log in at {subdomain} until one is added.
        </p>
      )}

      {users && users.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Added</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.email}</td>
                <td className="subtle">{new Date(user.createdAt).toLocaleDateString()}</td>
                <td className="cell-actions">
                  <button
                    type="button"
                    className="linkbutton"
                    onClick={() => reset(user)}
                    disabled={resetting !== null || busy}
                  >
                    {resetting === user.id ? "Resetting…" : "Reset password"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="card card-form" onSubmit={add}>
        <div className="field">
          <label htmlFor="user-email">Add a User</label>
          <input
            id="user-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="name@example.com"
          />
          <p className="hint">
            An email address is all that is needed — the password is generated here and
            shown once. It must not already be in use by any Client on the platform.
          </p>
        </div>

        <button type="submit" className="button" disabled={busy || resetting !== null}>
          {busy ? "Creating…" : "Create User"}
        </button>
      </form>
    </section>
  );
}
