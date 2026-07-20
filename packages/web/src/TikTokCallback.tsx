import { useEffect, useState } from "react";
import { ApiError, completeTikTokLogin } from "./api.js";
import { primaryButtonStyle } from "./LoginScreen.jsx";

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
    <section style={{ marginTop: "2rem", maxWidth: "34rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 600 }}>Connect TikTok</h2>

      {state.phase === "connecting" && <p style={muted}>Checking with TikTok…</p>}

      {state.phase === "connected" && (
        <div>
          <p>
            Connected{state.displayName ? <> to <strong>{state.displayName}</strong></> : null}.
          </p>
          <button onClick={onDone} style={primaryButtonStyle}>
            Done
          </button>
        </div>
      )}

      {state.phase === "error" && (
        <div role="alert">
          <p style={{ color: "#b91c1c" }}>{state.message}</p>
          <button onClick={onDone} style={primaryButtonStyle}>
            Back
          </button>
        </div>
      )}
    </section>
  );
}

const muted = { color: "#64748b" } as const;
