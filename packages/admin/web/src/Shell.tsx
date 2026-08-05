import { useState } from "react";
import { signOut, type Superadmin } from "./api.js";
import { ClientList } from "./ClientList.js";
import { ClientDetail } from "./ClientDetail.js";
import { NewClient } from "./NewClient.js";

/**
 * The authenticated shell: who is signed in, a way out, and the frame the
 * administrative screens hang inside.
 *
 * Where the operator is, is held in state rather than in the URL — as in the
 * Client SPA, and for the same reason: there is no router here, and three
 * destinations do not earn one. A reload lands back on the Client list, which is
 * the right place to land anyway.
 */
type View = { kind: "list" } | { kind: "new" } | { kind: "detail"; clientId: string };

export function Shell({
  superadmin,
  onSignedOut,
}: {
  superadmin: Superadmin;
  onSignedOut: () => void;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });

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
        <button
          type="button"
          className="topbar-title"
          onClick={() => setView({ kind: "list" })}
        >
          Platform administration
        </button>
        <div className="topbar-right">
          <span>{superadmin.email}</span>
          <button type="button" className="linkbutton" onClick={endSession} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>

      <main className="main">
        {/*
         * `onSessionEnded` is `onSignedOut`: an admin session expires on its own
         * and deliberately soon, so a screen being told 401 mid-session is the
         * normal end of an operator's day. That belongs at the sign-in form, not
         * in a red box inside a shell that can no longer load anything.
         */}
        {view.kind === "list" && (
          <ClientList
            onOpen={(clientId) => setView({ kind: "detail", clientId })}
            onProvision={() => setView({ kind: "new" })}
            onSessionEnded={onSignedOut}
          />
        )}

        {view.kind === "new" && (
          <NewClient
            onCreated={(clientId) => setView({ kind: "detail", clientId })}
            onCancel={() => setView({ kind: "list" })}
            onSessionEnded={onSignedOut}
          />
        )}

        {view.kind === "detail" && (
          <ClientDetail
            clientId={view.clientId}
            onBack={() => setView({ kind: "list" })}
            onSessionEnded={onSignedOut}
          />
        )}
      </main>
    </>
  );
}
