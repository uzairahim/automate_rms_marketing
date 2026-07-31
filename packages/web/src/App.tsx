import { useEffect, useState, type ReactNode } from "react";
import { apiFetch, getSessionToken, setSessionToken } from "./api.js";
import type { Session } from "./session.js";
import { LoginScreen } from "./LoginScreen.jsx";
import { Connections } from "./Connections.jsx";
import { Composer } from "./Composer.jsx";
import { Posts } from "./Posts.jsx";
import { PostDetail } from "./PostDetail.jsx";
import { FacebookCallback } from "./FacebookCallback.jsx";
import { TikTokCallback } from "./TikTokCallback.jsx";
import { BrandLockup, DEFAULT_BRANDING, type Branding } from "./branding.jsx";
import { ClayOrb } from "./ui.jsx";

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
  { label: "Compose", kind: "compose", icon: ComposeIcon, blurb: "Write one post" },
  { label: "Posts", kind: "posts", icon: PostsIcon, blurb: "Scheduled and sent" },
  { label: "Accounts", kind: "connections", icon: AccountsIcon, blurb: "Connected platforms" },
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
    <div
      className="min-h-dvh"
      style={{
        // Expose the primary color as a CSS variable so any descendant can use it
        // as the brand accent, rather than threading the raw value through props.
        // Everything the theme derives from it — tints, focus rings, the active
        // nav pill — hangs off this one declaration.
        ["--brand-primary" as string]: branding.primaryColor,
      }}
    >
      {resolvingSession ? (
        <BootSplash />
      ) : !session ? (
        <LoginScreen branding={branding} onLoggedIn={setSession} />
      ) : path === FACEBOOK_CALLBACK_PATH ? (
        <CallbackFrame branding={branding}>
          <FacebookCallback onDone={returnToWorkspace} />
        </CallbackFrame>
      ) : path === TIKTOK_CALLBACK_PATH ? (
        <CallbackFrame branding={branding}>
          <TikTokCallback onDone={returnToWorkspace} />
        </CallbackFrame>
      ) : (
        <Shell
          branding={branding}
          session={session}
          view={view}
          onNavigate={setView}
          onSignOut={signOut}
        />
      )}
    </div>
  );
}

/**
 * The beat before we know whether anyone is signed in.
 *
 * Deliberately almost nothing — a single drifting clay form on the canvas. It
 * says "loading" without claiming a screen that may be replaced immediately.
 */
function BootSplash() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <ClayOrb tone="var(--color-clay-peach)" className="size-16 opacity-80" drift />
      <span className="sr-only">Loading</span>
    </div>
  );
}

/**
 * The frame an OAuth return lands in.
 *
 * Not the full workspace: a User coming back from Facebook has one thing to
 * finish, and the sidebar would offer them three ways to abandon it. The brand
 * stays, so the page is recognizably still the Client's.
 */
function CallbackFrame({ branding, children }: { branding: Branding; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-10">
      <BrandLockup branding={branding} />
      <div className="flex flex-1 items-center">
        <div className="w-full animate-rise">{children}</div>
      </div>
    </div>
  );
}

/**
 * The signed-in workspace: a persistent rail of destinations beside the screen
 * being worked in.
 *
 * The rail is separated from the canvas by tone and a feathered edge rather
 * than a ruled border, so the page reads as one continuous surface. Below `lg`
 * it becomes a bar pinned to the bottom of the viewport, which is where a thumb
 * already is.
 */
function Shell({
  branding,
  session,
  view,
  onNavigate,
  onSignOut,
}: {
  branding: Branding;
  session: Session;
  view: View;
  onNavigate: (view: View) => void;
  onSignOut: () => void;
}) {
  return (
    <div className="lg:grid lg:grid-cols-[17.5rem_1fr]">
      <Sidebar
        branding={branding}
        session={session}
        view={view}
        onNavigate={onNavigate}
        onSignOut={onSignOut}
      />

      <div className="min-w-0">
        <MobileTopBar branding={branding} session={session} onSignOut={onSignOut} />
        <main className="px-5 pb-28 pt-6 sm:px-8 lg:px-12 lg:pb-16 lg:pt-12">
          {/* Keyed on the destination so each screen animates in on arrival —
              the transition between views is the one place this app can afford
              motion, and it makes the tab-to-content link legible. */}
          <div key={view.kind} className="mx-auto w-full max-w-5xl animate-rise">
            <Workspace session={session} view={view} onNavigate={onNavigate} />
          </div>
        </main>
      </div>

      <MobileNav view={view} onNavigate={onNavigate} />
    </div>
  );
}

function Sidebar({
  branding,
  session,
  view,
  onNavigate,
  onSignOut,
}: {
  branding: Branding;
  session: Session;
  view: View;
  onNavigate: (view: View) => void;
  onSignOut: () => void;
}) {
  return (
    <aside className="relative hidden lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:bg-[color-mix(in_oklab,var(--color-surface-soft)_72%,transparent)] lg:px-5 lg:py-7">
      {/* The rail's edge, feathered top and bottom so it never cuts the page. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-hairline to-transparent"
      />

      <div className="px-2">
        <BrandLockup branding={branding} />
      </div>

      <nav className="mt-9 flex flex-col gap-1" aria-label="Workspace">
        <NavItems view={view} onNavigate={onNavigate} withBlurb />
      </nav>

      <div className="mt-auto pt-8">
        <AccountCard session={session} onSignOut={onSignOut} />
      </div>
    </aside>
  );
}

/** The three destinations, shared by the rail and the mobile bar. */
function NavItems({
  view,
  onNavigate,
  withBlurb = false,
}: {
  view: View;
  onNavigate: (view: View) => void;
  withBlurb?: boolean;
}) {
  // A Post's detail is not a destination — it is reached *from* the Posts list
  // and keeps that entry lit, because that is where the back button returns to.
  const activeTab = view.kind === "post" ? "posts" : view.kind;

  return (
    <>
      {TABS.map((tab) => {
        const active = tab.kind === activeTab;
        const Icon = tab.icon;
        return (
          <button
            key={tab.kind}
            type="button"
            onClick={() =>
              onNavigate(
                tab.kind === "compose" ? { kind: "compose", postId: null } : { kind: tab.kind },
              )
            }
            aria-current={active ? "page" : undefined}
            className="nav-item"
          >
            <span className="nav-dot" aria-hidden="true" />
            <Icon />
            <span className="flex flex-col">
              {tab.label}
              {withBlurb && (
                <span className="text-note font-normal text-muted">{tab.blurb}</span>
              )}
            </span>
          </button>
        );
      })}
    </>
  );
}

/** Who is signed in, and the way out. */
function AccountCard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  return (
    <div className="card-soft flex items-center gap-3 p-3">
      <span
        className="clay-pill grid size-9 shrink-0 place-items-center text-title-sm font-semibold text-white"
        style={{ ["--orb" as string]: "var(--brand-primary)" }}
        aria-hidden="true"
      >
        {session.user.email.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-note font-medium text-ink" title={session.user.email}>
          {session.user.email}
        </p>
        <button type="button" onClick={onSignOut} className="btn-link btn-quiet text-note">
          Sign out
        </button>
      </div>
    </div>
  );
}

/** The brand and the way out, for viewports with no room for a rail. */
function MobileTopBar({
  branding,
  session,
  onSignOut,
}: {
  branding: Branding;
  session: Session;
  onSignOut: () => void;
}) {
  return (
    <header className="flex items-center justify-between gap-3 px-5 pt-6 sm:px-8 lg:hidden">
      <BrandLockup branding={branding} />
      <button
        type="button"
        onClick={onSignOut}
        className="btn-link btn-quiet"
        title={session.user.email}
      >
        Sign out
      </button>
    </header>
  );
}

/**
 * The rail, folded into a bar at the bottom of the viewport. Floating and
 * rounded rather than a full-width strip with a border across the top — the
 * same reason nothing else here is separated by a hard line.
 */
function MobileNav({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const activeTab = view.kind === "post" ? "posts" : view.kind;

  return (
    <nav
      aria-label="Workspace"
      className="fixed inset-x-4 bottom-4 z-20 flex justify-around gap-1 rounded-xl bg-[color-mix(in_oklab,var(--color-canvas)_88%,#fff)] p-1.5 shadow-clay-lifted backdrop-blur lg:hidden"
    >
      {TABS.map((tab) => {
        const active = tab.kind === activeTab;
        const Icon = tab.icon;
        return (
          <button
            key={tab.kind}
            type="button"
            onClick={() =>
              onNavigate(
                tab.kind === "compose" ? { kind: "compose", postId: null } : { kind: tab.kind },
              )
            }
            aria-current={active ? "page" : undefined}
            className="nav-item flex-1 flex-col justify-center gap-1 px-2 py-2 text-note"
          >
            <Icon />
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

/* -------------------------------------------------------------------- Icons */

/**
 * Drawn inline rather than pulled from an icon set: three icons do not justify
 * a dependency, and hand-drawing them keeps the stroke weight matched to the
 * type. All three share a 24px box, a 1.6 stroke, and round joins.
 */
const iconProps = {
  width: 19,
  height: 19,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  className: "shrink-0",
} as const;

function ComposeIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 20h16" />
      <path d="M14.5 4.5a2.1 2.1 0 0 1 3 3L9 16l-4 1 1-4Z" />
    </svg>
  );
}

function PostsIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
    </svg>
  );
}

function AccountsIcon() {
  return (
    <svg {...iconProps}>
      <path d="M10 13a4 4 0 0 0 5.7.4l3-3A4 4 0 0 0 13 4.7l-1.4 1.4" />
      <path d="M14 11a4 4 0 0 0-5.7-.4l-3 3A4 4 0 0 0 11 19.3l1.4-1.4" />
    </svg>
  );
}
