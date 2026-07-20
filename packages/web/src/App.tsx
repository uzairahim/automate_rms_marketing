import { useEffect, useState } from "react";
import { apiFetch, getSessionToken, setSessionToken } from "./api.js";
import type { Session } from "./session.js";
import { LoginScreen } from "./LoginScreen.jsx";
import { Connections } from "./Connections.jsx";
import { FacebookCallback } from "./FacebookCallback.jsx";
import { TikTokCallback } from "./TikTokCallback.jsx";

/**
 * A Client's white-label branding, fetched from the API at load and resolved
 * from the request subdomain (Slice 5). Mirrors the server's `Branding` shape.
 */
interface Branding {
  appName: string;
  primaryColor: string;
  logoUrl: string | null;
}

/**
 * The neutral fallback used before branding loads and if the fetch fails — kept
 * in sync with the server's `DEFAULT_BRANDING`. It mentions no operator, so a
 * Client surface never shows anything but the Client's own (or a plain) identity.
 */
const DEFAULT_BRANDING: Branding = {
  appName: "Social Media Studio",
  primaryColor: "#334155",
  logoUrl: null,
};

/**
 * The paths each platform returns a User to. One per platform, matching the
 * server's `redirectUriFor` — see `OAUTH_REDIRECT_BASE_URL`. Instagram has none:
 * it connects in place, without ever leaving the app (ADR 0005).
 */
const FACEBOOK_CALLBACK_PATH = "/oauth/facebook/callback";
const TIKTOK_CALLBACK_PATH = "/oauth/tiktok/callback";

/**
 * Client SPA shell. Applies the Client's white-label branding (logo, primary
 * color, app name) resolved from the subdomain, so the app feels like the
 * Client's own tool — including on the login screen, before anyone
 * authenticates. Branding is applied at load and, on failure, degrades to a
 * neutral default rather than showing nothing.
 */
export function App() {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [session, setSession] = useState<Session | null>(null);
  // Until the stored token is checked, we don't know whether to show the login
  // screen — rendering it and then yanking it away would be worse than a beat of
  // nothing.
  const [resolvingSession, setResolvingSession] = useState(true);
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    let cancelled = false;

    // Branding is applied on next load: a fresh fetch each mount picks up any
    // change the Superadmin made. On any failure we keep the neutral default.
    fetch("/api/branding")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ branding: Branding }>;
      })
      .then((body) => {
        if (!cancelled) setBranding(body.branding);
      })
      .catch(() => {
        /* keep DEFAULT_BRANDING */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Restore a session from a stored token. It may have expired, or the Client
  // may have been suspended since — in which case /api/me refuses it and we fall
  // back to the login screen, which then explains why.
  useEffect(() => {
    let cancelled = false;
    if (!getSessionToken()) {
      setResolvingSession(false);
      return;
    }

    apiFetch<Session>("/api/me")
      .then((me) => {
        if (!cancelled) setSession({ ...me, token: getSessionToken()! });
      })
      .catch(() => {
        setSessionToken(null);
      })
      .finally(() => {
        if (!cancelled) setResolvingSession(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Reflect the app name in the browser tab too — part of feeling like the
  // Client's own tool.
  useEffect(() => {
    document.title = branding.appName;
  }, [branding.appName]);

  function signOut() {
    setSessionToken(null);
    setSession(null);
  }

  /** Leave the OAuth callback URL behind, so a reload doesn't replay it. */
  function returnToWorkspace() {
    window.history.replaceState({}, "", "/");
    setPath("/");
  }

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        // Expose the primary color as a CSS variable so any descendant can use it
        // as the brand accent, rather than threading the raw value through props.
        ["--brand-primary" as string]: branding.primaryColor,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          borderBottom: "1px solid #e2e8f0",
          paddingBottom: "1rem",
        }}
      >
        {branding.logoUrl && (
          <img
            src={branding.logoUrl}
            alt={`${branding.appName} logo`}
            style={{ height: "2.5rem", width: "auto" }}
            data-testid="brand-logo"
          />
        )}
        <h1 style={{ color: "var(--brand-primary)", margin: 0 }} data-testid="brand-name">
          {branding.appName}
        </h1>

        {session && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "1rem" }}>
            <span style={{ fontSize: "0.875rem", color: "#64748b" }}>{session.user.email}</span>
            <button onClick={signOut} style={linkButtonStyle}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {resolvingSession ? null : !session ? (
        <LoginScreen onLoggedIn={setSession} />
      ) : path === FACEBOOK_CALLBACK_PATH ? (
        <FacebookCallback onDone={returnToWorkspace} />
      ) : path === TIKTOK_CALLBACK_PATH ? (
        <TikTokCallback onDone={returnToWorkspace} />
      ) : (
        <Connections />
      )}
    </main>
  );
}

const linkButtonStyle = {
  background: "none",
  border: "none",
  padding: 0,
  color: "#64748b",
  fontSize: "0.875rem",
  textDecoration: "underline",
  cursor: "pointer",
} as const;
