import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  disconnectFacebook,
  listConnections,
  startFacebookConnect,
  type ConnectedAccount,
  type Platform,
} from "./api.js";
import { primaryButtonStyle } from "./LoginScreen.jsx";

/**
 * What the Client can post to (PRD stories 25–28).
 *
 * One row per account the API returns, each showing whether it is ready to post
 * to — because "nothing is connected" is exactly the thing a User needs to be
 * told, not an empty space. Which platforms appear is the API's call (the Plan
 * decides, and a still-linked account is always listed), so this renders what it
 * is given rather than filtering again and disagreeing with it.
 *
 * Starting a connection hands off to Facebook and comes back through
 * {@link FacebookCallback}.
 */
export function Connections() {
  const [connections, setConnections] = useState<ConnectedAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Platform | null>(null);

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

  async function connect(platform: Platform) {
    setBusy(platform);
    setError(null);
    try {
      const { authorizeUrl } = await startFacebookConnect();
      // Leave for Facebook. The state minted server-side comes back with us.
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the connection.");
      setBusy(null);
    }
  }

  async function disconnect(platform: Platform) {
    setBusy(platform);
    setError(null);
    try {
      await disconnectFacebook();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disconnect.");
    } finally {
      setBusy(null);
    }
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
          <li key={connection.platform} style={rowStyle}>
            <div>
              <strong style={{ textTransform: "capitalize" }}>{connection.platform}</strong>
              <div style={{ fontSize: "0.875rem", color: "#64748b" }}>
                <StatusLabel connection={connection} />
              </div>
            </div>

            {/* Only Facebook can be connected today; Instagram and TikTok land in
                Slice 7 and are shown as not-yet-connectable rather than hidden. */}
            {connection.platform === "facebook" ? (
              connection.status === "connected" ? (
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
              )
            ) : (
              <span style={{ fontSize: "0.875rem", color: "#94a3b8" }}>Coming soon</span>
            )}
          </li>
        ))}
      </ul>
    </section>
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

const secondaryButtonStyle = {
  padding: "0.5rem 1rem",
  background: "transparent",
  color: "#334155",
  border: "1px solid #cbd5e1",
  borderRadius: "0.25rem",
  fontSize: "0.938rem",
  cursor: "pointer",
} as const;
