import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  connectInstagram,
  disconnectPlatform,
  listConnections,
  startFacebookConnect,
  startTikTokConnect,
  type ConnectedAccount,
  type Platform,
} from "./api.js";
import { primaryButtonStyle } from "./LoginScreen.jsx";

/**
 * What the Client can post to (PRD stories 21–28).
 *
 * One row per account the API returns, each showing whether it is ready to post
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
    return <p style={{ color: "#64748b" }}>Loading connections…</p>;
  }

  return (
    <section style={{ marginTop: "2rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 600 }}>Connected accounts</h2>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", fontSize: "0.875rem" }}>
          {error}
        </p>
      )}

      <ul style={{ listStyle: "none", padding: 0, maxWidth: "34rem" }}>
        {connections.map((connection) => (
          <li key={connection.platform}>
            <div style={rowStyle}>
              <div>
                <strong style={{ textTransform: "capitalize" }}>{connection.platform}</strong>
                <div style={{ fontSize: "0.875rem", color: "#64748b" }}>
                  <StatusLabel connection={connection} />
                </div>
              </div>

              {connection.status === "connected" ? (
                <button
                  onClick={() => void disconnect(connection.platform)}
                  disabled={busy === connection.platform}
                  style={secondaryButtonStyle}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={() => void connect(connection.platform)}
                  disabled={busy === connection.platform}
                  style={{ ...primaryButtonStyle, marginTop: 0 }}
                >
                  {connection.status === "token_expired" ? "Reconnect" : "Connect"}
                </button>
              )}
            </div>

            {connection.platform === "instagram" && instagramGuidance && (
              <InstagramGuidance message={instagramGuidance} />
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
    <div role="alert" style={guidanceStyle}>
      <p style={{ margin: 0 }}>{message}</p>
      <a
        href="https://help.instagram.com/502981923235522"
        target="_blank"
        rel="noreferrer"
        style={{ color: "var(--brand-primary)", fontSize: "0.875rem" }}
      >
        How to switch to a Business or Creator account
      </a>
    </div>
  );
}

function StatusLabel({ connection }: { connection: ConnectedAccount }) {
  if (connection.status === "connected") {
    return <>Connected{connection.displayName ? ` — ${connection.displayName}` : ""}</>;
  }
  if (connection.status === "token_expired") {
    // The one status that asks the User for something, so it says so plainly.
    return <span style={{ color: "#b45309" }}>Access expired — reconnect to keep posting</span>;
  }
  return <>Not connected</>;
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.875rem 0",
  borderBottom: "1px solid #e2e8f0",
} as const;

const guidanceStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  padding: "0.875rem",
  marginBottom: "0.875rem",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  borderRadius: "0.25rem",
  fontSize: "0.875rem",
} as const;

const secondaryButtonStyle = {
  padding: "0.5rem 1rem",
  background: "transparent",
  color: "#334155",
  border: "1px solid #cbd5e1",
  borderRadius: "0.25rem",
  fontSize: "0.938rem",
  cursor: "pointer",
} as const;
