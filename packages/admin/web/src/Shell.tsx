import { useState } from "react";
import { signOut, type Superadmin } from "./api.js";

/**
 * The authenticated shell: who is signed in, a way out, and the frame the
 * administrative screens hang inside.
 *
 * It is empty on purpose. This slice delivers the identity and the door; the
 * Client list and the per-Client screens fill this space in the slices after it.
 */
export function Shell({
  superadmin,
  onSignedOut,
}: {
  superadmin: Superadmin;
  onSignedOut: () => void;
}) {
  const [signingOut, setSigningOut] = useState(false);

  async function endSession() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      // Whatever the server said, this browser is done with the session — a
      // failed sign-out must not leave the operator looking signed in.
      onSignedOut();
    }
  }

  return (
    <>
      <header className="topbar">
        <span className="topbar-title">Platform administration</span>
        <div className="topbar-right">
          <span>{superadmin.email}</span>
          <button type="button" className="linkbutton" onClick={endSession} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>

      <main className="main">
        <h2 className="section-title">Clients</h2>
        <p className="placeholder">
          Nothing here yet. The Client list, provisioning, Users, Plan and Branding
          controls land in this shell next.
        </p>
      </main>
    </>
  );
}
