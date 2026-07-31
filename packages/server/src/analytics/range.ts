/**
 * The window every analytics read is scoped to, resolved in the Client's own
 * timezone.
 *
 * A Client has a single timezone that all of its scheduling and analytics are
 * anchored to (CONTEXT.md `Client`), so "the last 30 days" is 30 of *that
 * Client's* calendar days — not the server's, and not the browser's. Two Clients
 * asking at the same instant can be looking at different windows, which is the
 * point.
 *
 * Both the stored snapshot series and the publishing activity are cut with the
 * same range, so a dashboard's range control moves every number on the screen
 * together rather than leaving one chart on a different window than its
 * neighbour.
 */

/** The default window: long enough to show a trend, short enough to still read. */
export const DEFAULT_RANGE_DAYS = 30;

/**
 * The widest window this API will cut. Not a storage limit — snapshots are tiny
 * (ADR 0004) — but a chart with more points than a screen has pixels is not a
 * chart anyone reads, and it bounds the work a single request can ask for.
 */
export const MAX_RANGE_DAYS = 365;

export interface DateRange {
  /** How many calendar days the window spans, inclusive of both ends. */
  days: number;
  /** The first day in the window, `YYYY-MM-DD` in the Client's timezone. */
  from: string;
  /** The last day — today in the Client's timezone. */
  to: string;
}

/**
 * The calendar day `now` falls on in `timezone`, as `YYYY-MM-DD`.
 *
 * `en-CA` formats as `YYYY-MM-DD`, which is exactly the form
 * `metric_snapshots.snapshot_date` is stored in — so a day computed here can be
 * compared to a stored one as text without any reparsing.
 */
export function dayIn(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The last `days` calendar days in the Client's timezone, ending today.
 *
 * The subtraction is done on the *date parts* through `Date.UTC` rather than by
 * taking 24-hour steps back from the instant: a day is not always 24 hours long
 * in a zone that observes DST, and stepping by duration would skip or repeat a
 * day twice a year. UTC has no such transitions, so arithmetic on the parts is
 * plain calendar arithmetic.
 *
 * `days` is clamped rather than rejected — a nonsense window is a query-string
 * typo, not a reason to fail a dashboard.
 */
export function analyticsRange(now: Date, timezone: string, days: number): DateRange {
  const span = Math.min(Math.max(Math.trunc(days) || DEFAULT_RANGE_DAYS, 1), MAX_RANGE_DAYS);

  const to = dayIn(now, timezone);
  const [year, month, day] = to.split("-").map(Number) as [number, number, number];
  const from = new Date(Date.UTC(year, month - 1, day - (span - 1))).toISOString().slice(0, 10);

  return { days: span, from, to };
}

/**
 * The `days` a request asked for, or the default. Anything unparseable falls
 * back rather than erroring, for the same reason {@link analyticsRange} clamps.
 */
export function rangeDaysFromQuery(raw: unknown): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RANGE_DAYS;
}
