import { useEffect, useState } from "react";
import { ApiError, completeTikTokLogin } from "./api.js";
import { ClayOrb, LoadingNote, PlatformTile } from "./ui.jsx";

/**
 * Where a User lands coming back from TikTok.
 *
 * Deliberately thinner than {@link FacebookCallback}: TikTok's OAuth authorizes
 * exactly one account, so there is no list to render, nothing to pick, and no
 * dead-end to guide out of. The screen exists only because the callback URL has
 * to land somewhere — it reports what happened and gets out of the way.
 */

type State =
  | { phase: "connecting" }
  | { phase: "connected"; displayName: string | null }
  | { phase: "error"; message: string };

export function TikTokCallback({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<State>({ phase: "connecting" });
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const oauthState = params.get("state");
  const denied = params.get("error");

  useEffect(() => {
    // The User declined at TikTok's consent screen. Not an error of ours.
    if (denied) {
      setState({ phase: "error", message: "TikTok login was cancelled." });
      return;
    }
    if (!code || !oauthState) {
      setState({ phase: "error", message: "This link is missing information from TikTok." });
      return;
    }

    let cancelled = false;
    completeTikTokLogin(oauthState, code)
      .then(({ connection }) => {
        if (!cancelled) setState({ phase: "connected", displayName: connection.displayName });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          phase: "error",
          message: err instanceof ApiError ? err.message : "Could not finish connecting.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [code, oauthState, denied]);

  return (
    <section className="card relative overflow-hidden p-7 sm:p-9">
      {/* The same corner wash as the Facebook return — the two screens are
          siblings and should read as a pair. Mint rather than TikTok's own
          teal: teal is the palette's one dark tone, and a wash of it reads as
          a smudge rather than warmth. Held flush to the corner so the gradient
          has reached transparent by the card's edge; pulled beyond it, the
          card's clip would slice it off mid-fade. */}
      <span
        aria-hidden="true"
        className="clay-wash pointer-events-none absolute right-0 top-0 size-64 opacity-70"
        style={{ ["--orb" as string]: "var(--color-clay-mint)" }}
      />

      <div className="relative">
        <div className="flex items-center gap-3">
          <PlatformTile platform="tiktok" />
          <h2 className="m-0 text-title-lg text-ink">Connect TikTok</h2>
        </div>

        <div className="mt-6">
          {state.phase === "connecting" && <LoadingNote>Checking with TikTok…</LoadingNote>}

          {state.phase === "connected" && (
            <div>
              <div className="flex items-center gap-3">
                <ClayOrb tone="var(--color-clay-mint)" className="size-9 shrink-0" />
                <p className="m-0 text-body-md text-ink-strong">
                  Connected
                  {state.displayName ? (
                    <>
                      {" "}
                      to <strong>{state.displayName}</strong>
                    </>
                  ) : null}
                  .
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
