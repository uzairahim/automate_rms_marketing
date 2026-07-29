import { useEffect, useState } from "react";
import { apiFetch, getSessionToken, setSessionToken } from "./api.js";
import type { Session } from "./session.js";
import { LoginScreen } from "./LoginScreen.jsx";
import { Connections } from "./Connections.jsx";
import { Composer } from "./Composer.jsx";
import { Posts } from "./Posts.jsx";
import { PostDetail } from "./PostDetail.jsx";
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
 * Where a signed-in User is inside the workspace.
 *
 * Held in state rather than in the URL, matching how the OAuth callbacks are
 * already the only paths this SPA reads: there is no router here, and adding one
 * for three destinations would be more machinery than the app has earned. The
 * cost is that a reload lands back on the composer, which is the right place to
 * land anyway.
 *
 * `compose` carries an optional Post id because finishing a Draft and writing
 * something new are the same screen — the composer just starts populated.
 */
type View =
  | { kind: "compose"; postId: string | null }
  | { kind: "posts" }
  | { kind: "post"; id: string }
  | { kind: "connections" };

const TABS = [
  { label: "Compose", kind: "compose" },
  { label: "Posts", kind: "posts" },
  { label: "Accounts", kind: "connections" },
] as const;

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
  // Composing is the app's reason to exist, so it is where a signed-in User lands.
  const [view, setView] = useState<View>({ kind: "compose", postId: null });

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
    setView({ kind: "compose", postId: null });
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
        <>
          <Nav view={view} onNavigate={setView} />
          <Workspace session={session} view={view} onNavigate={setView} />
        </>
      )}
    </main>
  );
}

/**
 * The three places a User works. A tab is underlined in the Client's own accent
 * rather than a generic blue, for the same reason the primary button is.
 *
 * A Post's detail is not a tab — it is reached *from* the Posts list and keeps
 * that tab lit, because that is where the back button returns to.
 */
function Nav({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const activeTab = view.kind === "post" ? "posts" : view.kind;

  return (
    <nav style={navStyle}>
      {TABS.map((tab) => {
        const active = tab.kind === activeTab;
        return (
          <button
            key={tab.kind}
            type="button"
            onClick={() =>
              onNavigate(tab.kind === "compose" ? { kind: "compose", postId: null } : { kind: tab.kind })
            }
            aria-current={active ? "page" : undefined}
            style={{
              ...tabStyle,
              color: active ? "var(--brand-primary)" : "#64748b",
              fontWeight: active ? 600 : 400,
              borderBottomColor: active ? "var(--brand-primary)" : "transparent",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * The current view, wired to the navigation each screen needs to hand off to:
 * publishing goes to the outcome, saving goes to the list of what is waiting,
 * and editing a Draft goes back to the composer holding it.
 */
function Workspace({
  session,
  view,
  onNavigate,
}: {
  session: Session;
  view: View;
  onNavigate: (view: View) => void;
}) {
  switch (view.kind) {
    case "compose":
      return (
        <Composer
          session={session}
          postId={view.postId}
          onPublished={(id) => onNavigate({ kind: "post", id })}
          onSaved={() => onNavigate({ kind: "posts" })}
          onLeaveEdit={() => onNavigate({ kind: "posts" })}
        />
      );
    case "posts":
      return (
        <Posts
          session={session}
          onEdit={(postId) => onNavigate({ kind: "compose", postId })}
          onOpen={(id) => onNavigate({ kind: "post", id })}
        />
      );
    case "post":
      return (
        <PostDetail
          session={session}
          postId={view.id}
          onBack={() => onNavigate({ kind: "posts" })}
        />
      );
    case "connections":
      return <Connections />;
  }
}

const navStyle = {
  display: "flex",
  gap: "1.5rem",
  marginTop: "1.25rem",
  borderBottom: "1px solid #e2e8f0",
} as const;

const tabStyle = {
  padding: "0 0 0.625rem",
  background: "none",
  border: "none",
  borderBottom: "2px solid transparent",
  fontSize: "0.938rem",
  cursor: "pointer",
} as const;

const linkButtonStyle = {
  background: "none",
  border: "none",
  padding: 0,
  color: "#64748b",
  fontSize: "0.875rem",
  textDecoration: "underline",
  cursor: "pointer",
} as const;
