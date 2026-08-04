/**
 * `@smma/core` — what a Client is, in one place (ADR 0010).
 *
 * The tenancy and credential modules the two deployables share: the Client-facing
 * service (`@smma/server`) and the Superadmin panel (`@smma/admin`). Both
 * provision Clients and Users, both read a Plan, and both must agree on what a
 * subdomain, a Branding, and a valid password are — encoding those twice would
 * drift the first time a column changed, and the drift would surface as a
 * provisioning bug rather than a type error.
 *
 * The package deliberately depends on nothing but `pg` and `bcryptjs`: no
 * Publisher, no Redis/BullMQ, no Clock, no media, no cipher. That is what makes
 * it cheap for a second service to consume, and what keeps the Superadmin
 * surface from dragging the publishing domain along with it.
 */

export { ProvisionError, type ProvisionErrorCode } from "./errors.js";

export {
  ADMIN_SUBDOMAIN,
  isValidSubdomain,
  resolveSurface,
  type Surface,
} from "./subdomain.js";

// `planFromRow`/`brandingFromRow` and their column types stay internal: they map
// raw `clients` rows, and a consumer reaching for them is writing its own SQL
// against a table this package exists to own.
export {
  ACCESS_STATUSES,
  PLATFORMS,
  enabledPlatforms,
  isAccessStatus,
  isPlatform,
  planEnables,
  updatePlan,
  type AccessStatus,
  type Plan,
  type PlanPatch,
  type Platform,
} from "./plan.js";

export {
  DEFAULT_BRANDING,
  getBranding,
  normalizeAppName,
  normalizeLogoUrl,
  normalizePrimaryColor,
  updateBranding,
  type Branding,
  type BrandingPatch,
} from "./branding.js";

export {
  createClient,
  createUser,
  findClientById,
  findClientBySubdomain,
  listClients,
  setUserPassword,
  type Client,
  type User,
} from "./clients.js";

export {
  MIN_PASSWORD_LENGTH,
  WEAK_PASSWORD_MESSAGE,
  hashPassword,
  isStrongPassword,
  verifyPassword,
} from "./passwords.js";

export {
  accessBlock,
  publishBlock,
  type PublishBlock,
  type PublishBlockReason,
} from "./eligibility.js";
