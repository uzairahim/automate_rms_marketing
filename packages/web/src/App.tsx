import { useEffect, useState } from "react";

interface Health {
  status: string;
  time: string;
}

type Load =
  | { state: "loading" }
  | { state: "ok"; health: Health }
  | { state: "error"; message: string };

/**
 * Walking-skeleton UI: fetches the API health endpoint (which reads a value from
 * Postgres) and renders it. This proves the SPA → API → Postgres path is wired
 * end-to-end in the browser.
 */
export function App() {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Health>;
      })
      .then((health) => {
        if (!cancelled) setLoad({ state: "ok", health });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setLoad({ state: "error", message: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Social Media Marketing Automation</h1>
      <p>Walking skeleton — Slice 1</p>
      {load.state === "loading" && <p>Checking API health…</p>}
      {load.state === "error" && (
        <p style={{ color: "crimson" }}>API health check failed: {load.message}</p>
      )}
      {load.state === "ok" && (
        <p>
          API health: <strong data-testid="health-status">{load.health.status}</strong>{" "}
          (as of {load.health.time})
        </p>
      )}
    </main>
  );
}
