import {
  ACCESS_STATUSES,
  PLATFORMS,
  ProvisionError,
  isAccessStatus,
  type PlanPatch,
} from "@smma/core";

/**
 * How a Plan arrives on the wire, for the two routes that accept one — creating
 * a Client, and patching its Plan.
 *
 * Its own module rather than either route's, because both read the same fields
 * and a second reading of them would be free to disagree about what a toggle is:
 * the create route accepting `"true"` where the patch route rejects it is exactly
 * the drift this prevents. Companion to {@link ./provision-errors.js} and
 * {@link ./require-client.js} — the pieces every administrative route shares.
 */

/**
 * Read the platform toggles out of a body. Only the toggles actually present are
 * returned; what an *absent* one means is the caller's to decide — off, at
 * creation, where a Client sees and pays for only what it needs; unchanged, on a
 * patch, so one platform can be flipped without restating the other two.
 */
export function parsePlanToggles(plan: Record<string, unknown>): PlanPatch {
  const toggles: PlanPatch = {};
  for (const platform of PLATFORMS) {
    const value = plan[platform];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new ProvisionError("invalid_plan", `${platform} must be true or false.`);
    }
    toggles[platform] = value;
  }
  return toggles;
}

/**
 * Read a whole Plan patch — the toggles above, plus the access status.
 *
 * Deliberately not used by the create route: a new Client is always `active`, so
 * there is nothing there for a caller to set, correctly or otherwise, and a
 * create body naming one should be ignored rather than argued with.
 */
export function parsePlanPatch(body: Record<string, unknown>): PlanPatch {
  const patch = parsePlanToggles(body);

  const accessStatus = body.accessStatus;
  if (accessStatus !== undefined) {
    if (typeof accessStatus !== "string" || !isAccessStatus(accessStatus)) {
      throw new ProvisionError(
        "invalid_access_status",
        `accessStatus must be one of: ${ACCESS_STATUSES.join(", ")}.`,
      );
    }
    patch.accessStatus = accessStatus;
  }

  return patch;
}
