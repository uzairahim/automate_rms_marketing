/**
 * A Client's white-label identity, and the one component that renders it.
 *
 * Its own module rather than a corner of `App.tsx` because the login screen and
 * the OAuth callbacks show the lockup too, and importing it from the shell they
 * are rendered *by* would make a cycle. Keeping it here also means the logo, the
 * name, and the no-logo fallback have exactly one definition — including the two
 * `data-testid`s the branding checks look for.
 */

/** Mirrors the server's `Branding` shape, resolved from the request subdomain. */
export interface Branding {
  appName: string;
  primaryColor: string;
  logoUrl: string | null;
}

/**
 * The neutral fallback used before branding loads and if the fetch fails — kept
 * in sync with the server's `DEFAULT_BRANDING`. It mentions no operator, so a
 * Client surface never shows anything but the Client's own (or a plain) identity.
 */
export const DEFAULT_BRANDING: Branding = {
  appName: "Social Media Studio",
  primaryColor: "#334155",
  logoUrl: null,
};

export function BrandLockup({
  branding,
  size = "md",
}: {
  branding: Branding;
  size?: "md" | "lg";
}) {
  return (
    <div className="flex items-center gap-3">
      {branding.logoUrl ? (
        <img
          src={branding.logoUrl}
          alt={`${branding.appName} logo`}
          className={size === "lg" ? "h-11 w-auto" : "h-9 w-auto"}
          data-testid="brand-logo"
        />
      ) : (
        // With no logo the Client still gets a mark: a clay tile carrying the
        // first letter of its own app name, in its own color.
        <span
          className={`clay-pill grid shrink-0 place-items-center font-semibold text-white ${
            size === "lg" ? "size-11 text-title-md" : "size-9 text-title-sm"
          }`}
          style={{ ["--orb" as string]: "var(--brand-primary)" }}
          aria-hidden="true"
        >
          {branding.appName.charAt(0)}
        </span>
      )}
      <span
        className={`font-display font-semibold tracking-[-0.4px] text-ink ${
          size === "lg" ? "text-title-lg" : "text-title-md"
        }`}
        data-testid="brand-name"
      >
        {branding.appName}
      </span>
    </div>
  );
}
