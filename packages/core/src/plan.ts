import type pg from "pg";
import { ProvisionError } from "./errors.js";

/**
 * A Client's Plan — the Superadmin-configured bundle that gates the Client.
 *
 * Two independent gates live here (CONTEXT.md `Plan`):
 *   - three per-platform toggles, gating what Users see and may act on;
 *   - an access status, gating login and every action entirely.
 *
 * The Plan is a strict 1:1 with the Client, stored as columns on `clients`;
 * this module is the one place that reads and writes those columns, so the
 * gating predicates and the shape of a Plan stay in a single spot.
 */

export const PLATFORMS = ["facebook", "instagram", "tiktok"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ACCESS_STATUSES = ["active", "suspended", "expired"] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

export interface Plan {
  facebook: boolean;
  instagram: boolean;
  tiktok: boolean;
  accessStatus: AccessStatus;
}

/** The `clients` columns a Plan is projected from — used by the mapping helper. */
export interface PlanColumns {
  facebook_enabled: boolean;
  instagram_enabled: boolean;
  tiktok_enabled: boolean;
  access_status: string;
}

/** Whether `value` is one of the three platform names. */
export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** Whether `value` is one of the three access statuses. */
export function isAccessStatus(value: string): value is AccessStatus {
  return (ACCESS_STATUSES as readonly string[]).includes(value);
}

/** Whether the Plan enables acting on a given platform. */
export function planEnables(plan: Plan, platform: Platform): boolean {
  return plan[platform];
}

/** The platforms the Plan enables, in canonical order. */
export function enabledPlatforms(plan: Plan): Platform[] {
  return PLATFORMS.filter((platform) => plan[platform]);
}

/** Project the Plan columns of a `clients` row into a {@link Plan}. */
export function planFromRow(row: PlanColumns): Plan {
  const accessStatus = row.access_status;
  // The CHECK constraint guarantees this, but narrow defensively rather than cast.
  if (!isAccessStatus(accessStatus)) {
    throw new Error(`Unexpected access_status in database: ${accessStatus}`);
  }
  return {
    facebook: row.facebook_enabled,
    instagram: row.instagram_enabled,
    tiktok: row.tiktok_enabled,
    accessStatus,
  };
}

/** The subset of a Plan the Superadmin may change — every field optional. */
export interface PlanPatch {
  facebook?: boolean;
  instagram?: boolean;
  tiktok?: boolean;
  accessStatus?: AccessStatus;
}

/**
 * Apply a {@link PlanPatch} to a Client's Plan. Only the provided fields change;
 * omitted fields keep their current value. Returns the Client's full, updated
 * Plan.
 *
 * @throws {ProvisionError} `client_not_found` if no Client has that id.
 */
export async function updatePlan(
  pool: pg.Pool,
  clientId: string,
  patch: PlanPatch,
): Promise<Plan> {
  // Build a partial UPDATE from only the supplied fields. COALESCE keeps the
  // existing value for any column whose parameter is null (i.e. not in the patch).
  const params = [
    clientId,
    patch.facebook ?? null,
    patch.instagram ?? null,
    patch.tiktok ?? null,
    patch.accessStatus ?? null,
  ];

  let rows: PlanColumns[];
  try {
    ({ rows } = await pool.query<PlanColumns>(
      `UPDATE clients SET
         facebook_enabled  = COALESCE($2, facebook_enabled),
         instagram_enabled = COALESCE($3, instagram_enabled),
         tiktok_enabled    = COALESCE($4, tiktok_enabled),
         access_status     = COALESCE($5, access_status)
       WHERE id = $1
       RETURNING facebook_enabled, instagram_enabled, tiktok_enabled, access_status`,
      params,
    ));
  } catch (err) {
    // A malformed uuid (22P02) names a Client that cannot exist → 404, matching
    // how createUser treats the same class of error.
    if ((err as { code?: string })?.code === "22P02") {
      throw new ProvisionError("client_not_found", `No such Client: ${clientId}`);
    }
    throw err;
  }

  const row = rows[0];
  if (!row) {
    throw new ProvisionError("client_not_found", `No such Client: ${clientId}`);
  }
  return planFromRow(row);
}
