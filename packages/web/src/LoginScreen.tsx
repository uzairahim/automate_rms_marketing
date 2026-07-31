import { useState, type FormEvent } from "react";
import { ApiError, apiFetch, setSessionToken } from "./api.js";
import type { Session } from "./session.js";
import { BrandLockup, type Branding } from "./branding.jsx";
import { ClayOrb } from "./ui.jsx";

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
 *
 * The layout is the one place the app gets a proper hero: a panel of modeled
 * clay beside the form, stating in one line what the tool does. On a narrow
 * viewport the panel drops away entirely rather than stacking — a sign-in form
 * pushed below a decorative block is worse than no decoration.
 */
export function LoginScreen({
  branding,
  onLoggedIn,
}: {
  branding: Branding;
  onLoggedIn: (session: Session) => void;
}) {
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
    <div className="min-h-dvh lg:grid lg:grid-cols-[1.05fr_1fr]">
      <HeroPanel appName={branding.appName} />

      <div className="flex min-h-dvh flex-col px-6 py-10 sm:px-10 lg:min-h-0 lg:justify-center lg:px-14">
        <div className="lg:hidden">
          <BrandLockup branding={branding} />
        </div>

        <form onSubmit={submit} className="mx-auto w-full max-w-sm animate-rise lg:mx-0">
          <h1 className="m-0 mt-10 text-display-md text-ink lg:mt-0">Sign in</h1>
          <p className="mt-2 mb-8 text-body-sm text-muted">
            Welcome back. Pick up wherever you left off.
          </p>

          <div className="flex flex-col gap-5">
            <label className="field">
              <span className="field-label">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
                className="input"
              />
            </label>

            <label className="field">
              <span className="field-label">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="input"
              />
            </label>
          </div>

          {error && (
            <p role="alert" className="callout callout-error mt-5">
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting} className="btn btn-primary mt-7 w-full">
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * The clay hero.
 *
 * DESIGN.md's brand voltage is 3D claymation art, which cannot ship as a token —
 * so this composes the same read out of the system's own modeled surfaces:
 * overlapping forms in four of the six palette colors, drifting slowly, on the
 * cream canvas. Hidden below `lg`, and inert to assistive tech.
 */
function HeroPanel({ appName }: { appName: string }) {
  return (
    <section className="relative hidden overflow-hidden bg-[color-mix(in_oklab,var(--color-surface-soft)_80%,transparent)] px-14 py-12 lg:flex lg:flex-col">
      {/* The composition: a large form anchoring the panel, two mid-size ones
          crossing it, and a small accent. Sizes and offsets are deliberate
          rather than a grid, so it reads as arranged by hand. They bleed off
          the top and left of the viewport, where an edge is expected — never
          into the seam with the form, which is feathered over them below.
          The negative animation delays start each form partway through its
          drift, so they never rise and fall together. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <ClayOrb
          tone="var(--color-clay-peach)"
          className="absolute -left-24 -top-24 size-[26rem] opacity-90"
          drift
        />
        <ClayOrb
          tone="var(--color-clay-lavender)"
          className="absolute left-[17rem] top-40 size-36 opacity-95 [animation-delay:-5s]"
          alt
          drift
        />
        <ClayOrb
          tone="var(--color-clay-ochre)"
          className="absolute right-16 top-12 size-28 opacity-80 [animation-delay:-9s]"
          drift
        />
        <ClayOrb
          tone="var(--color-clay-mint)"
          className="absolute left-40 top-[21rem] size-16 opacity-90"
          alt
        />
      </div>

      {/* The panel's inner edge, feathered so the two halves of the screen bleed
          into each other instead of meeting at a seam. Painted *after* the
          forms so it softens them too — underneath, it would leave any shape
          that reaches the edge sliced off by the panel's own clip. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-40 bg-gradient-to-r from-transparent to-canvas"
      />

      <div className="relative z-10 mt-auto max-w-md">
        <p className="m-0 mb-4 text-overline uppercase text-muted">{appName}</p>
        <h2 className="m-0 text-display-lg text-ink">Write once. Post everywhere.</h2>
        <p className="mt-5 mb-0 max-w-sm text-body-md text-prose">
          One composer for Facebook, Instagram and TikTok — with every schedule,
          draft and result in a single place.
        </p>
      </div>

    </section>
  );
}
