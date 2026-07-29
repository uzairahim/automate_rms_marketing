/**
 * Wall-clock time in the Client's timezone ↔ the UTC instants the API speaks.
 *
 * A Client has a single timezone that all of its scheduling is anchored to
 * (CONTEXT.md `Client`), and it is emphatically *not* the browser's: a User in
 * Lisbon scheduling a Post for an Acme Client set to `America/New_York` means
 * 9am in New York. So a `datetime-local` input — which knows nothing but the
 * machine's own zone — cannot be read or written directly. Everything here
 * converts through the Client's zone explicitly.
 *
 * Done with `Intl` rather than a date library because it is the one thing in the
 * platform that actually knows the IANA rules, including the DST transitions
 * that make this conversion non-trivial.
 */

/**
 * How far ahead of UTC `timeZone` is at `instant`, in milliseconds.
 *
 * Derived by asking `Intl` what wall clock `timeZone` shows at that instant and
 * subtracting the instant itself — the only way to get an offset for an
 * arbitrary zone at an arbitrary moment, since the offset changes across the
 * year.
 */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const wallClock = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    // `hour12: false` renders midnight as "24" in some engines; 24:00 of a day
    // is 00:00 of it as far as Date.UTC's arithmetic is concerned.
    field("hour") % 24,
    field("minute"),
    field("second"),
  );
  return wallClock - instant.getTime();
}

/**
 * The UTC instant at which `local` — a `datetime-local` value like
 * `2026-08-01T14:30`, meant as wall-clock time in `timeZone` — occurs.
 *
 * Two passes, not one: the first guess uses the offset in force at the *wrong*
 * instant (the value read as if it were UTC), which is off by an hour for times
 * near a DST transition. Re-reading the offset at the guessed instant lands on
 * the right side of the boundary.
 */
export function zonedToUtc(local: string, timeZone: string): Date {
  const asIfUtc = new Date(`${local}:00Z`);
  if (Number.isNaN(asIfUtc.getTime())) return asIfUtc;

  const guess = new Date(asIfUtc.getTime() - offsetMs(asIfUtc, timeZone));
  return new Date(asIfUtc.getTime() - offsetMs(guess, timeZone));
}

/**
 * `iso` as a `datetime-local` value (`YYYY-MM-DDTHH:mm`) in `timeZone` — what
 * fills the schedule field when a User reopens a Scheduled Post to change its
 * time, so they see the time they originally set.
 *
 * Assembled from parts rather than by reformatting a locale's string: an input
 * of this type accepts exactly one shape, and no locale can be relied on to
 * produce it (even the ISO-shaped ones differ in the date/time separator).
 */
export function utcToZonedInput(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));

  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  // Midnight can render as "24"; the input will not accept it for the same day.
  const hour = field("hour") === "24" ? "00" : field("hour");
  return `${field("year")}-${field("month")}-${field("day")}T${hour}:${field("minute")}`;
}

/** A UTC instant written out in the Client's timezone, for reading. */
export function formatInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

/**
 * The soonest schedule the API will accept, as a `datetime-local` value — the
 * `min` on the schedule field, so the browser refuses a past time before the
 * API has to (it rejects anything not strictly in the future).
 */
export function nowInZoneInput(timeZone: string): string {
  return utcToZonedInput(new Date().toISOString(), timeZone);
}

/** The Client's timezone as a short label (`EDT`, `GMT+1`) for a field's hint. */
export function zoneAbbreviation(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(new Date());
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}
