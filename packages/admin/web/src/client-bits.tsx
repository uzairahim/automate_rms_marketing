import type { AccessStatus, Plan, Platform } from "./api.js";

/**
 * How a Client is shown and edited, shared by every screen that does either, so
 * the same Client never reads differently in two places and the same field never
 * behaves differently on two forms.
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

/**
 * Every timezone the browser knows, for a field a typo would otherwise ruin.
 *
 * Read once at module load rather than per render: it is a few hundred entries
 * that cannot change while the page is open, and rebuilding them on every
 * keystroke in the field they are attached to would be the one place it shows.
 * Empty on a runtime without the API — the field still takes a typed value, and
 * the API is what actually decides whether a timezone is real.
 */
const KNOWN_TIMEZONES: string[] = Intl.supportedValuesOf?.("timeZone") ?? [];

/**
 * The timezone field, shared by provisioning a Client and re-anchoring one.
 *
 * A free-text input with suggestions rather than a `<select>`: the list is
 * hundreds long, an operator knows the name they want, and typing it is faster
 * than finding it. What is typed is still only a proposal — the API decides
 * whether a zone is real, and says so in words this form shows.
 */
export function TimezoneInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (timezone: string) => void;
  disabled?: boolean;
}) {
  const listId = `${id}-options`;
  return (
    <>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        disabled={disabled}
        list={listId}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <datalist id={listId}>
        {KNOWN_TIMEZONES.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </>
  );
}

/** Which platforms the Plan enables, or that it enables none. */
export function PlanSummary({ plan }: { plan: Plan }) {
  const enabled = PLATFORM_OPTIONS.filter((platform) => plan[platform.key]);
  if (enabled.length === 0) return <>None</>;
  return <>{enabled.map((platform) => platform.label).join(", ")}</>;
}
