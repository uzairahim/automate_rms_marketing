import { useEffect, useState } from "react";
import { whoAmI, type Superadmin } from "./api.js";
import { SignIn } from "./SignIn.js";
import { Shell } from "./Shell.js";

/**
 * Signed in, or not.
 *
 * The panel cannot read its own session — the cookie is httpOnly — so "am I
 * signed in?" is a question only the server can answer, asked once on load. That
 * is also what makes an expired session behave correctly without any clock in
 * the browser: the probe simply comes back 401.
 */
export function App() {
  const [superadmin, setSuperadmin] = useState<Superadmin | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    whoAmI()
      .then(setSuperadmin)
      .catch(() => setSuperadmin(null))
      .finally(() => setChecked(true));
  }, []);

  // Nothing is rendered until the probe answers, so a signed-in operator never
  // sees the sign-in form flash past on their way in.
  if (!checked) return <p className="loading">Loading…</p>;

  return superadmin ? (
    <Shell superadmin={superadmin} onSignedOut={() => setSuperadmin(null)} />
  ) : (
    <SignIn onSignedIn={setSuperadmin} />
  );
}
