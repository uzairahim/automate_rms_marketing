import { planEnables, type AccessStatus, type Plan, type Platform } from "./plan.js";

/**
 * "May this Client publish to this platform right now?" — the one rule, asked
 * from both layers that can reach a Publisher (ADR 0011).
 *
 * A Client's right to publish is not a fact about a request; it is a fact about
 * the Client at the moment something publishes, and those two moments are days
 * apart for a Scheduled Post. So the rule is deliberately consulted twice:
 *
 *   - at compose time by `@smma/server`'s `routes/posts.ts`, so a User is told
 *     while they can still act on it ("this Client's plan does not include
 *     facebook");
 *   - at fire time by `@smma/server`'s `posts/publish.ts` `attemptPublish`, per Target,
 *     immediately before anything reaches a Publisher — which covers the
 *     scheduler's fan-out, the auto-retry tick, and a User's manual retry alike.
 *
 * Deleting the fire-time call reopens the bugs this exists for: a suspended
 * Client publishing everything it had already scheduled, and a Client
 * downgraded to TikTok-only still publishing tomorrow's Facebook Post. Any
 * future gate on publishing belongs *here*, not in route middleware — the
 * scheduler is a second entrypoint into the publishing domain and never sees a
 * guard.
 */

/**
 * Why a Client may not publish. Distinguished per cause because `Failed` alone
 * cannot tell a User whether to contact their administrator or wait.
 */
export type PublishBlockReason =
  | Exclude<AccessStatus, "active">
  | "platform_not_in_plan"
  | "unknown_client";

export interface PublishBlock {
  reason: PublishBlockReason;
  /** What a blocked Target reports to the User — never the grace-window message. */
  message: string;
}

/**
 * The blocking reason for this Client publishing *anything* right now, or null
 * if its access status allows it. Names no platform, because access status is a
 * whole-Client gate — which is what lets the scheduler fail a whole Post with
 * one honest reason before it ever looks at the grace window.
 *
 * `plan` is nullable because the fire-time callers read it fresh from the
 * database and a Client can, in principle, be gone by then; no Plan is no
 * entitlement, never a reason to publish anyway.
 */
export function accessBlock(plan: Plan | null): PublishBlock | null {
  if (!plan) {
    // Deliberately not phrased as "account" — that word means Connected Account
    // here, and a Target failed for *that* reason already has its own message.
    return { reason: "unknown_client", message: "Not published: this Client no longer exists." };
  }
  if (plan.accessStatus === "active") return null;
  return {
    reason: plan.accessStatus,
    message:
      plan.accessStatus === "suspended"
        ? "Not published: access has been suspended. Please contact your administrator."
        : "Not published: access has expired. Please contact your administrator.",
  };
}

/**
 * The blocking reason for publishing to `platform` on this Plan, or null if the
 * Client may publish. The full rule: the whole-Client gate above, and then the
 * Plan's toggle for this one platform.
 */
export function publishBlock(plan: Plan | null, platform: Platform): PublishBlock | null {
  // Access status first: a Client that may not act at all should not be told
  // which platforms its plan happens to include.
  const denied = accessBlock(plan);
  // `plan` is non-null past here — accessBlock always blocks a missing one.
  if (denied || !plan) return denied;

  if (!planEnables(plan, platform)) {
    return {
      reason: "platform_not_in_plan",
      message: `Not published: your plan no longer includes ${platform}. Please contact your administrator.`,
    };
  }

  return null;
}
