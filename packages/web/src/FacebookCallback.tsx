import { useEffect, useState } from "react";
import {
  ApiError,
  completeFacebookLogin,
  selectFacebookPage,
  type FacebookPageChoice,
} from "./api.js";
import { ClayOrb, LoadingNote, PlatformTile } from "./ui.jsx";

/**
 * Where a User lands coming back from Facebook (ADR 0005).
 *
 * This screen is the visible half of the enforcement: it shows the Pages the
 * Graph API actually returned and makes the User pick one. The two outcomes that
 * matter most are the awkward ones — managing no Page at all, which is a
 * dead-end with a way forward, and managing several, where picking wrong means
 * posting as the wrong business.
 */

type State =
  | { phase: "exchanging" }
  | { phase: "choosing"; pages: FacebookPageChoice[] }
  | { phase: "connecting" }
  | { phase: "connected"; pageName: string }
  | { phase: "no-pages"; message: string }
  | { phase: "error"; message: string };

export function FacebookCallback({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<State>({ phase: "exchanging" });
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const oauthState = params.get("state");
  const denied = params.get("error");

  useEffect(() => {
    // The User declined at Facebook's consent screen. Not an error of ours.
    if (denied) {
      setState({ phase: "error", message: "Facebook login was cancelled." });
      return;
    }
    if (!code || !oauthState) {
      setState({ phase: "error", message: "This link is missing information from Facebook." });
      return;
    }

    let cancelled = false;
    completeFacebookLogin(oauthState, code)
      .then(({ pages }) => {
        if (!cancelled) setState({ phase: "choosing", pages });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "no_facebook_pages") {
          setState({ phase: "no-pages", message: err.message });
          return;
        }
        setState({
          phase: "error",
          message: err instanceof ApiError ? err.message : "Could not finish connecting.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [code, oauthState, denied]);

  async function choose(page: FacebookPageChoice) {
    if (!oauthState) return;
    setState({ phase: "connecting" });
    try {
      await selectFacebookPage(oauthState, page.id);
      setState({ phase: "connected", pageName: page.name });
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof ApiError ? err.message : "Could not connect that Page.",
      });
    }
  }

  return (
    <section className="card relative overflow-hidden p-7 sm:p-9">
      {/* A wash of the platform's own card color in the corner, so the screen
          belongs to the thing being connected without a colored header band
          cutting across it. Held flush to the corner so the gradient has
          reached transparent by the card's edge; pulled beyond it, the card's
          clip would slice it off mid-fade. */}
      <span
        aria-hidden="true"
        className="clay-wash pointer-events-none absolute right-0 top-0 size-64 opacity-70"
        style={{ ["--orb" as string]: "var(--color-clay-lavender)" }}
      />

      <div className="relative">
        <div className="flex items-center gap-3">
          <PlatformTile platform="facebook" />
          <h2 className="m-0 text-title-lg text-ink">Connect a Facebook Page</h2>
        </div>

        <div className="mt-6">
          {state.phase === "exchanging" && <LoadingNote>Checking with Facebook…</LoadingNote>}
          {state.phase === "connecting" && <LoadingNote>Connecting…</LoadingNote>}

          {state.phase === "no-pages" && (
            <div role="alert">
              <p className="m-0 text-body-md text-ink-strong">{state.message}</p>
              <p className="mt-3 text-body-sm text-muted">
                Once the Page exists and your Facebook account manages it, come back and connect
                again.
              </p>
              <a
                href="https://www.facebook.com/pages/create"
                target="_blank"
                rel="noreferrer"
                className="btn-link mt-4"
              >
                Create a Facebook Business Page
                <span aria-hidden="true">↗</span>
              </a>
              <div className="mt-6">
                <button onClick={onDone} className="btn btn-primary">
                  Back
                </button>
              </div>
            </div>
          )}

          {state.phase === "choosing" && (
            <>
              <p className="m-0 text-body-sm text-muted">
                {state.pages.length === 1
                  ? "Confirm the Page this account should post to."
                  : "Choose the Page this account should post to."}
              </p>
              <ul className="m-0 mt-4 flex list-none flex-col gap-2 p-0">
                {state.pages.map((page) => (
                  <li
                    key={page.id}
                    className="card-soft flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <span className="text-title-sm text-ink">{page.name}</span>
                    <button onClick={() => void choose(page)} className="btn btn-primary btn-sm">
                      Connect
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {state.phase === "connected" && (
            <div>
              <div className="flex items-center gap-3">
                <ClayOrb tone="var(--color-clay-mint)" className="size-9 shrink-0" />
                <p className="m-0 text-body-md text-ink-strong">
                  Connected to <strong>{state.pageName}</strong>.
                </p>
              </div>
              <button onClick={onDone} className="btn btn-primary mt-6">
                Done
              </button>
            </div>
          )}

          {state.phase === "error" && (
            <div role="alert">
              <p className="callout callout-error m-0">{state.message}</p>
              <button onClick={onDone} className="btn btn-primary mt-6">
                Back
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
