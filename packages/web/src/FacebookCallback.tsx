import { useEffect, useState } from "react";
import {
  ApiError,
  completeFacebookLogin,
  selectFacebookPage,
  type FacebookPageChoice,
} from "./api.js";
import { primaryButtonStyle } from "./LoginScreen.jsx";

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
    <section style={{ marginTop: "2rem", maxWidth: "34rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 600 }}>Connect a Facebook Page</h2>

      {state.phase === "exchanging" && <p style={muted}>Checking with Facebook…</p>}
      {state.phase === "connecting" && <p style={muted}>Connecting…</p>}

      {state.phase === "no-pages" && (
        <div role="alert">
          <p>{state.message}</p>
          <p style={muted}>
            Once the Page exists and your Facebook account manages it, come back and connect
            again.
          </p>
          <a
            href="https://www.facebook.com/pages/create"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--brand-primary)" }}
          >
            Create a Facebook Business Page
          </a>
          <div>
            <button onClick={onDone} style={{ ...primaryButtonStyle }}>
              Back
            </button>
          </div>
        </div>
      )}

      {state.phase === "choosing" && (
        <>
          <p style={muted}>
            {state.pages.length === 1
              ? "Confirm the Page this account should post to."
              : "Choose the Page this account should post to."}
          </p>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {state.pages.map((page) => (
              <li key={page.id} style={choiceRow}>
                <span>{page.name}</span>
                <button onClick={() => void choose(page)} style={{ ...primaryButtonStyle, marginTop: 0 }}>
                  Connect
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {state.phase === "connected" && (
        <div>
          <p>
            Connected to <strong>{state.pageName}</strong>.
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

const choiceRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.75rem 0",
  borderBottom: "1px solid #e2e8f0",
} as const;
