import type pg from "pg";
import { ProvisionError } from "./errors.js";

/**
 * A Client's white-label branding — logo, primary color, and app display name.
 *
 * Branding is a strict 1:1 with the Client (one look per Client), stored as
 * columns on `clients` alongside the Plan; this module is the one place that
 * reads and writes those columns, so the shape of Branding, its validation, and
 * its neutral fallback all live in a single spot.
 *
 * The point of branding is that the app feels like the Client's own tool: the
 * Client SPA resolves it from the subdomain and applies it at load, and no
 * operator identity is ever shown to a Client's Users (CONTEXT.md `Client` and
 * `Superadmin`). A Client with nothing configured therefore falls back to a
 * neutral default — a plain name and color that mention no operator.
 */

/** The neutral fallback shown when a Client has set no custom branding. */
export const DEFAULT_BRANDING = {
  appName: "Social Media Studio",
  primaryColor: "#334155",
  logoUrl: null,
} as const satisfies Branding;

export interface Branding {
  /** The display name shown in the SPA. Never empty — defaults are applied. */
  appName: string;
  /** A `#rrggbb` hex color the SPA uses as its primary accent. */
  primaryColor: string;
  /** An absolute http(s) URL to the Client's logo, or null for name-only. */
  logoUrl: string | null;
}

/** The `clients` columns Branding is projected from. Each is NULL when unset. */
export interface BrandingColumns {
  app_name: string | null;
  primary_color: string | null;
  logo_url: string | null;
}

/**
 * Project the branding columns of a `clients` row into a {@link Branding},
 * substituting the neutral default for any column left NULL. A stored value is
 * always already-normalized (validated on write), so it is passed through as-is.
 */
export function brandingFromRow(row: BrandingColumns): Branding {
  return {
    appName: row.app_name ?? DEFAULT_BRANDING.appName,
    primaryColor: row.primary_color ?? DEFAULT_BRANDING.primaryColor,
    logoUrl: row.logo_url ?? DEFAULT_BRANDING.logoUrl,
  };
}

const APP_NAME_MAX = 80;
const LOGO_URL_MAX = 2048;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * Normalize and validate a custom app name: trimmed, non-empty, and within a
 * sane length. Returns the value to store.
 *
 * @throws {ProvisionError} `invalid_app_name`
 */
export function normalizeAppName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > APP_NAME_MAX) {
    throw new ProvisionError(
      "invalid_app_name",
      `App name must be 1–${APP_NAME_MAX} characters.`,
    );
  }
  return name;
}

/**
 * Normalize and validate a `#rrggbb` hex color, lowercased for a stable stored
 * form. A 3-digit shorthand or a named color is rejected — the SPA needs one
 * unambiguous form.
 *
 * @throws {ProvisionError} `invalid_color`
 */
export function normalizePrimaryColor(value: string): string {
  const color = value.trim().toLowerCase();
  if (!HEX_COLOR_PATTERN.test(color)) {
    throw new ProvisionError(
      "invalid_primary_color",
      "Primary color must be a #rrggbb hex value.",
    );
  }
  return color;
}

/**
 * Normalize and validate a logo URL: an absolute http(s) URL within a sane
 * length. A relative path or a non-http scheme is rejected so the SPA can render
 * it directly as an image source.
 *
 * @throws {ProvisionError} `invalid_logo_url`
 */
export function normalizeLogoUrl(value: string): string {
  const raw = value.trim();
  if (raw.length === 0 || raw.length > LOGO_URL_MAX) {
    throw new ProvisionError("invalid_logo_url", "Logo URL is empty or too long.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProvisionError("invalid_logo_url", "Logo URL must be an absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProvisionError("invalid_logo_url", "Logo URL must use http or https.");
  }
  return parsed.toString();
}

/**
 * The subset of Branding the Superadmin may change. Each field is tri-state:
 *   - absent (`undefined`) — leave the stored value unchanged;
 *   - `null` — reset to the neutral default (clears the logo, drops a custom
 *     name/color back to the fallback);
 *   - a string — set that custom value.
 */
export interface BrandingPatch {
  appName?: string | null;
  primaryColor?: string | null;
  logoUrl?: string | null;
}

/** Read a Client's Branding, or throw if no Client has that id. */
export async function getBranding(pool: pg.Pool, clientId: string): Promise<Branding> {
  let rows: BrandingColumns[];
  try {
    ({ rows } = await pool.query<BrandingColumns>(
      `SELECT app_name, primary_color, logo_url FROM clients WHERE id = $1`,
      [clientId],
    ));
  } catch (err) {
    // A malformed uuid (22P02) names a Client that cannot exist → 404.
    if ((err as { code?: string })?.code === "22P02") {
      throw new ProvisionError("client_not_found", `No such Client: ${clientId}`);
    }
    throw err;
  }
  const row = rows[0];
  if (!row) {
    throw new ProvisionError("client_not_found", `No such Client: ${clientId}`);
  }
  return brandingFromRow(row);
}

/**
 * Apply a {@link BrandingPatch} to a Client's Branding. Only the fields present
 * in the patch are written (absent fields are left as-is); a `null` field stores
 * NULL, which the read path renders as the neutral default. Returns the Client's
 * full, resolved Branding.
 *
 * @throws {ProvisionError} `client_not_found` if no Client has that id.
 */
export async function updateBranding(
  pool: pg.Pool,
  clientId: string,
  patch: BrandingPatch,
): Promise<Branding> {
  // Build the SET clause from only the fields the patch actually carries, so an
  // absent field is untouched while an explicit null column-resets to default.
  const sets: string[] = [];
  const params: Array<string | null> = [clientId];
  const assign = (column: string, value: string | null): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.appName !== undefined) assign("app_name", patch.appName);
  if (patch.primaryColor !== undefined) assign("primary_color", patch.primaryColor);
  if (patch.logoUrl !== undefined) assign("logo_url", patch.logoUrl);

  // An empty patch is a no-op write: just read back the current branding.
  if (sets.length === 0) return getBranding(pool, clientId);

  let rows: BrandingColumns[];
  try {
    ({ rows } = await pool.query<BrandingColumns>(
      `UPDATE clients SET ${sets.join(", ")}
       WHERE id = $1
       RETURNING app_name, primary_color, logo_url`,
      params,
    ));
  } catch (err) {
    if ((err as { code?: string })?.code === "22P02") {
      throw new ProvisionError("client_not_found", `No such Client: ${clientId}`);
    }
    throw err;
  }
  const row = rows[0];
  if (!row) {
    throw new ProvisionError("client_not_found", `No such Client: ${clientId}`);
  }
  return brandingFromRow(row);
}
