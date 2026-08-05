import type { AccessStatus, Plan, Platform } from "./api.js";

/**
 * How a Client's Plan is shown, shared by every screen that shows one so the
 * same Client never reads differently in two places.
 */

/**
 * The platforms in canonical order, with the names an operator reads. Purely
 * presentational — which platforms *exist* is `@smma/core`'s to say, and the
 * API is what tells this panel — so it lives here rather than beside the wire
 * shapes it would otherwise be mistaken for.
 */
export const PLATFORM_OPTIONS: ReadonlyArray<{ key: Platform; label: string }> = [
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "tiktok", label: "TikTok" },
];

/**
 * A Client's access status.
 *
 * Active is quiet and lapsed is loud, on purpose: the operator scanning this
 * needs the exceptions to come forward, and a badge shouting on every row would
 * make none of them stand out.
 */
export function AccessStatusBadge({ status }: { status: AccessStatus }) {
  return (
    <span className={status === "active" ? "status" : "status status-lapsed"}>{status}</span>
  );
}

/** Which platforms the Plan enables, or that it enables none. */
export function PlanSummary({ plan }: { plan: Plan }) {
  const enabled = PLATFORM_OPTIONS.filter((platform) => plan[platform.key]);
  if (enabled.length === 0) return <>None</>;
  return <>{enabled.map((platform) => platform.label).join(", ")}</>;
}
