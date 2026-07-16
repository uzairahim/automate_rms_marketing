import { useEffect, useState } from "react";

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

interface Health {
  status: string;
  time: string;
}

/**
 * Client SPA shell. Applies the Client's white-label branding (logo, primary
 * color, app name) resolved from the subdomain, so the app feels like the
 * Client's own tool. Branding is applied at load and, on failure, degrades to a
 * neutral default rather than showing nothing. The health probe below proves the
 * SPA → API → Postgres path end-to-end (walking skeleton, Slice 1).
 */
export function App() {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [health, setHealth] = useState<Health | null>(null);

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

    fetch("/api/health")
      .then((r) => (r.ok ? (r.json() as Promise<Health>) : null))
      .then((h) => {
        if (!cancelled && h) setHealth(h);
      })
      .catch(() => {
        /* health is a non-blocking probe */
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
      <header style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
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
      </header>

      {health && (
        <p style={{ marginTop: "2rem", color: "#64748b" }}>
          API health: <strong data-testid="health-status">{health.status}</strong> (as of{" "}
          {health.time})
        </p>
      )}
    </main>
  );
}
