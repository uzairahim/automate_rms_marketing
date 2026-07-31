import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  connectInstagram,
  disconnectPlatform,
  listConnections,
  provideFacebookToken,
  startFacebookConnect,
  startTikTokConnect,
  type ConnectedAccount,
  type Platform,
} from "./api.js";
import { PLATFORM_LABELS } from "./postRules.js";
import { ErrorNote, LoadingNote, PlatformTile, SectionHeading } from "./ui.jsx";

/**
 * What the Client can post to (PRD stories 21–28).
 *
 * One card per account the API returns, each showing whether it is ready to post
 * to — because "nothing is connected" is exactly the thing a User needs to be
 * told, not an empty space. Which platforms appear is the API's call (the Plan
 * decides, and a still-linked account is always listed), so this renders what it
 * is given rather than filtering again and disagreeing with it.
 *
 * The three platforms connect differently, and the screen shows that rather than
 * hiding it behind three identical buttons: Facebook and TikTok leave for the
 * platform's login, while Instagram connects in place from the Facebook Page it
 * hangs off (ADR 0005) — so it is the one row that can finish, or dead-end,
 * without the page ever going anywhere.
 */
export function Connections() {
  const [connections, setConnections] = useState<ConnectedAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Platform | null>(null);
  /**
   * Instagram's "no eligible account" dead-end (PRD story 22). Kept apart from
   * `error` because it is not a failure to report and retry — it is a task to go
   * do in the Instagram app, and it needs room to say so.
   */
  const [instagramGuidance, setInstagramGuidance] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setConnections(await listConnections());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load connections.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Run a connect action, keeping one platform's row busy while it does. */
  async function run(platform: Platform, action: () => Promise<void>) {
    setBusy(platform);
    setError(null);
    setInstagramGuidance(null);
    try {
      await action();
    } catch (err) {
      // The dead-end gets its own treatment; everything else is an error.
      if (err instanceof ApiError && err.code === "no_instagram_account") {
        setInstagramGuidance(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not connect.");
      }
    } finally {
      setBusy(null);
    }
  }

  /** Leave for the platform's login. The state minted server-side comes back with us. */
  const leaveFor = (start: () => Promise<{ authorizeUrl: string }>) => async () => {
    const { authorizeUrl } = await start();
    window.location.assign(authorizeUrl);
  };

  function connect(platform: Platform) {
    if (platform === "facebook") return run(platform, leaveFor(startFacebookConnect));
    if (platform === "tiktok") return run(platform, leaveFor(startTikTokConnect));
    // Instagram has no login to leave for — it connects and lands right here.
    return run(platform, async () => {
      await connectInstagram();
      await refresh();
    });
  }

  function disconnect(platform: Platform) {
    return run(platform, async () => {
      await disconnectPlatform(platform);
      await refresh();
    });
  }

  if (!connections) {
    return <LoadingNote>Loading connections…</LoadingNote>;
  }

  return (
    <section className="max-w-3xl">
      <SectionHeading
        eyebrow="Accounts"
        title="Connected accounts"
      />

      <p className="-mt-2 mb-6 max-w-md text-body-sm text-muted">
        Link a business account per platform. Anything connected here becomes a
        destination in the composer.
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}

      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {connections.map((connection) => (
          <li key={connection.platform} className="card p-5">
            <div className="flex flex-wrap items-center gap-4">
              <PlatformTile platform={connection.platform} />

              <div className="min-w-0 flex-1">
                <p className="m-0 text-title-md text-ink">
                  {PLATFORM_LABELS[connection.platform]}
                </p>
                <div className="mt-0.5 text-body-sm">
                  <StatusLabel connection={connection} />
                </div>
              </div>

              {/* `w-full` below `sm` makes the action its own flex line rather
                  than a third column — squeezed beside the name, the status
                  wraps to three lines on a phone. */}
              {connection.status === "connected" ? (
                <button
                  onClick={() => void disconnect(connection.platform)}
                  disabled={busy === connection.platform}
                  className="btn btn-secondary w-full sm:w-auto"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={() => void connect(connection.platform)}
                  disabled={busy === connection.platform}
                  className="btn btn-primary w-full sm:w-auto"
                >
                  {connection.status === "token_expired" ? "Reconnect" : "Connect"}
                </button>
              )}
            </div>

            {connection.platform === "instagram" && instagramGuidance && (
              <InstagramGuidance message={instagramGuidance} />
            )}

            {/* The bring-your-own-token fallback (ADR 0008): shown on the Facebook
                row whenever it isn't connected — to link a Page without our own
                app review, or to regenerate a token that expired. */}
            {connection.platform === "facebook" && connection.status !== "connected" && (
              <FacebookTokenForm
                busy={busy === "facebook"}
                expired={connection.status === "token_expired"}
                onSubmit={async (token, pageId, displayName) =>
                  run("facebook", async () => {
                    await provideFacebookToken(token, pageId, displayName);
                    await refresh();
                  })
                }
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The convert-to-Business dead-end (PRD story 22). Shown on the Instagram row
 * itself, because that is where the User just pressed a button and where the
 * answer to "why didn't that work?" belongs.
 */
function InstagramGuidance({ message }: { message: string }) {
  return (
    <div role="alert" className="callout mt-4 animate-rise">
      <p className="m-0">{message}</p>
      <a
        href="https://help.instagram.com/502981923235522"
        target="_blank"
        rel="noreferrer"
        className="btn-link"
      >
        How to switch to a Business or Creator account
        <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}

/**
 * Paste a long-lived Page token instead of running Facebook login (ADR 0008,
 * Option E). A collapsible affordance so the ordinary OAuth button stays the
 * headline; it opens to three fields — the token, the Page id, and an optional
 * name — because that is exactly what a Client copies out of the Graph API
 * Explorer. When a Page's token has expired this is also how it is regenerated,
 * so the copy leads with that.
 */
function FacebookTokenForm({
  busy,
  expired,
  onSubmit,
}: {
  busy: boolean;
  expired: boolean;
  onSubmit: (token: string, pageId: string, displayName: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [pageId, setPageId] = useState("");
  const [displayName, setDisplayName] = useState("");

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-link mt-4">
        {expired ? "Paste a new Page token" : "Paste a Page token instead"}
      </button>
    );
  }

  return (
    <form
      className="card-soft mt-4 flex animate-rise flex-col gap-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(token.trim(), pageId.trim(), displayName.trim());
      }}
    >
      <label className="field">
        <span className="field-label">Page access token</span>
        {/* Masked and never autofilled: the token grants full Page control and
            must not be shoulder-surfed or stored by the browser (ADR 0006/0008). */}
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          className="input"
        />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">
          <span className="field-label">Page ID</span>
          <input value={pageId} onChange={(e) => setPageId(e.target.value)} className="input" />
        </label>
        <label className="field">
          <span className="field-label">
            Page name <span className="font-normal text-muted">optional</span>
          </span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="input"
          />
        </label>
      </div>

      <div className="flex gap-2.5">
        <button
          type="submit"
          disabled={busy || !token.trim() || !pageId.trim()}
          className="btn btn-primary"
        >
          Save token
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function StatusLabel({ connection }: { connection: ConnectedAccount }) {
  if (connection.status === "connected") {
    return (
      <span className="flex items-center gap-1.5 text-muted">
        <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
        Connected{connection.displayName ? ` — ${connection.displayName}` : ""}
      </span>
    );
  }
  if (connection.status === "token_expired") {
    // The one status that asks the User for something, so it says so plainly.
    return (
      <span className="text-[#85560a]">Access expired — reconnect to keep posting</span>
    );
  }
  return <span className="text-muted">Not connected</span>;
}
