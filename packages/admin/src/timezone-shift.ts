import type pg from "pg";
import { ProvisionError, isValidTimezone, type Client } from "@smma/core";
import { listScheduledPostTimes } from "./scheduled-posts.js";

/**
 * What re-anchoring a Client to another timezone will look like to its Users —
 * every Scheduled Post's displayed time, before and after (PRD #15 story 52).
 *
 * This exists because the change is a trap. Posts are stored as UTC instants and
 * displayed in the Client's timezone, so moving the anchor moves *nothing*: a
 * Post its author scheduled for 9am is still going out at the same second, but
 * now reads as 10pm. An operator fixing a typo has no reason to expect that, and
 * a count ("12 Scheduled Posts affected") would not tell them — the surprise is
 * in the individual times, so the individual times are what this returns.
 *
 * The formatting happens here rather than in the browser, deliberately. What the
 * operator was shown at the moment they decided is the whole substance of this
 * feature, and answering it from the API is what makes it assertable through the
 * seam this repo tests behavior through — there is no DOM-rendering seam here,
 * and PRD #15 was explicit that this work adds no new kinds of one.
 */

/** One Post's firing instant, written out on both sides of the change. */
export interface ShiftedPost {
  id: string;
  /** The UTC instant, unchanged by any of this — the fixed point of the whole shape. */
  scheduledAt: string;
  /** How it reads today, in the Client's current timezone. */
  before: string;
  /** How the same instant would read in the proposed one. */
  after: string;
}

export interface TimezoneShift {
  /** The Client's current anchor. */
  from: string;
  /** The one being proposed. */
  to: string;
  /**
   * Every Scheduled Post this Client has, soonest first — not only the ones
   * whose reading changes. Two zones that agree today can disagree the week a
   * daylight-saving rule differs between them, so "unchanged" is a property of a
   * particular Post's instant rather than of the pair of zones, and a preview
   * that silently dropped the rows it judged uninteresting would be answering a
   * question the operator did not ask.
   */
  posts: ShiftedPost[];
}

/**
 * A UTC instant as wall-clock time in `timeZone`, for an operator to read.
 *
 * A fixed `en-US` locale, not the operator's: the API has no way to know what a
 * browser would have picked, and a preview whose wording depends on the reader's
 * machine is a preview two people cannot compare notes on. The panel is English
 * throughout, so this is the one place that has to say so. The Client SPA formats
 * the same instants in the *reader's* locale, so these strings are how the times
 * read to the operator — the hour and the date are what the preview is about, and
 * those are the same either way.
 *
 * The narrow no-break space some ICU builds put before AM/PM is flattened to an
 * ordinary space — it copies and pastes as a character nothing else matches,
 * which is a needless surprise in a string an operator may well paste into a
 * message to a Client.
 */
function formatInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  })
    .format(instant)
    .replace(/\u202f/g, " ");
}

/**
 * How `client`'s Scheduled Posts would read if it were re-anchored to
 * `timezone`.
 *
 * A pure read, and that is what makes the panel's Cancel real: looking at the
 * cost of the change cannot have committed it, so an operator who backs out has
 * provably changed nothing. Proposing a zone the runtime does not know is
 * refused here rather than formatted into nonsense, with the same error the
 * write path would answer.
 *
 * @throws {ProvisionError} `invalid_timezone`
 */
export async function previewTimezoneShift(
  pool: pg.Pool,
  client: Client,
  timezone: string,
): Promise<TimezoneShift> {
  const to = timezone.trim();
  if (!isValidTimezone(to)) {
    throw new ProvisionError("invalid_timezone", `Unknown timezone: ${timezone}`);
  }

  const posts = await listScheduledPostTimes(pool, client.id);
  return {
    from: client.timezone,
    to,
    posts: posts.map((post) => ({
      id: post.id,
      scheduledAt: post.scheduledAt.toISOString(),
      before: formatInZone(post.scheduledAt, client.timezone),
      after: formatInZone(post.scheduledAt, to),
    })),
  };
}
