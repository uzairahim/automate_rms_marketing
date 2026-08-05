import { useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  isSessionEnded,
  timezoneShift,
  updateTimezone,
  type Client,
  type TimezoneShift,
} from "./api.js";
import { TimezoneInput } from "./client-bits.js";

/**
 * The clock this Client's scheduling and analytics are anchored to, and its
 * immutable address.
 *
 * The timezone is editable because a typo at provisioning is otherwise
 * unfixable without re-creating the Client and losing its history. The subdomain
 * is not, and is shown here read-only with the reason, because it is the
 * Client's URL: it lives in bookmarks and in its Users' habits, and renaming it
 * would silently break every existing link.
 *
 * Between the two sits the trap this screen exists to defuse. Scheduled Posts
 * are stored as UTC instants and *displayed* in the Client's timezone, so
 * changing it moves nothing — a Post its author set for 9am goes out at the same
 * second and now reads as noon. An operator has no reason to expect that, and a
 * count would not convey it, so the confirmation lists every affected Post's
 * time on both sides and can be backed out of.
 */

/** A proposed change, waiting on the operator to confirm or cancel it. */
interface Pending {
  timezone: string;
  /** The preview: null while it is still being read. */
  shift: TimezoneShift | null;
  /** Set when the preview could not be read — the change is still offered. */
  unavailable: boolean;
}

export function TimezoneSection({
  client,
  onClientChanged,
  onSessionEnded,
}: {
  client: Client;
  onClientChanged: (client: Client) => void;
  onSessionEnded: () => void;
}) {
  const [timezone, setTimezone] = useState(client.timezone);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Which proposal the answers coming back belong to.
   *
   * Cancel has to mean cancelled: without this, a preview still in flight when
   * the operator backs out would land afterwards and re-open the confirmation
   * for a change they had already declined — with a live Confirm button under
   * it. Bumped on every proposal and on every cancel, so a late answer to a
   * question nobody is asking any more is dropped.
   */
  const proposal = useRef(0);

  /** Ask what the change would look like, then put it to the operator. */
  async function propose(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (timezone.trim() === client.timezone) return;

    const asked = ++proposal.current;
    setPending({ timezone, shift: null, unavailable: false });
    try {
      const shift = await timezoneShift(client.id, timezone);
      if (asked === proposal.current) setPending({ timezone, shift, unavailable: false });
    } catch (err) {
      if (asked !== proposal.current) return;
      if (isSessionEnded(err)) return onSessionEnded();
      // A refused *timezone* is not a failed preview — the change itself would
      // be refused for the same reason, so there is nothing to confirm and the
      // operator is told what the platform objected to.
      if (err instanceof ApiError && err.status === 400) {
        setPending(null);
        return setError(err.message);
      }
      // Anything else: the numbers are a courtesy, and a preview that would not
      // load is not a reason to stand in the way of the change it explains.
      setPending({ timezone, shift: null, unavailable: true });
    }
  }

  /** Commit it. Nothing about the Client's Posts moves; only their labels do. */
  async function confirm(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      onClientChanged(await updateTimezone(client.id, pending.timezone));
      setPending(null);
    } catch (err) {
      if (isSessionEnded(err)) return onSessionEnded();
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not change the timezone. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Backing out restores the field, so the screen states what is actually true. */
  function cancel(): void {
    proposal.current += 1;
    setPending(null);
    setTimezone(client.timezone);
  }

  const posts = pending?.shift?.posts ?? [];

  return (
    <section className="section">
      <h3 className="subsection-title">Subdomain and timezone</h3>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {pending && (
        <div
          className="confirm confirm-note"
          role="alertdialog"
          aria-labelledby="timezone-confirm-title"
        >
          <p id="timezone-confirm-title" className="confirm-title">
            Re-anchor {client.subdomain} to {pending.timezone}?
          </p>

          <p className="confirm-body">
            {pending.unavailable
              ? "Could not read how this Client's Scheduled Posts would read afterwards. " +
                "The change can still be made — no Post moves either way."
              : pending.shift
                ? posts.length === 0
                  ? "This Client has no Scheduled Posts, so nothing changes but the clock " +
                    "its Users compose and read against."
                  : "No Post moves: each one still publishes at the same moment it would " +
                    "have. What changes is the time it is shown as, to this Client's Users " +
                    "and here."
                : "Checking what this changes…"}
          </p>

          {posts.length > 0 && (
            <div className="shift-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Reads now ({pending.shift?.from})</th>
                    <th scope="col">Will read ({pending.timezone})</th>
                  </tr>
                </thead>
                <tbody>
                  {posts.map((post) => (
                    <tr key={post.id}>
                      <td>{post.before}</td>
                      <td>{post.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="confirm-actions">
            {/* Held back until the preview has resolved one way or the other:
                confirming while the body still reads "checking…" would be
                committing having been told nothing. */}
            <button
              type="button"
              className="button"
              onClick={() => void confirm()}
              disabled={busy || (pending.shift === null && !pending.unavailable)}
            >
              {busy ? "Applying…" : "Change the timezone"}
            </button>
            <button type="button" className="linkbutton" onClick={cancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <form className="card card-form" onSubmit={(e) => void propose(e)}>
        <div className="field">
          <label htmlFor="client-subdomain">Subdomain</label>
          {/* Read-only rather than absent: an operator needs to see the Client's
              address, and a field they cannot edit says more plainly than a
              missing one that this is not something to be changed. */}
          <input id="client-subdomain" value={client.subdomain} readOnly />
          <p className="hint">
            Permanent — it is this Client's URL, and every link and bookmark its Users
            have points at it. A wrong one is fixed by provisioning again.
          </p>
        </div>

        <div className="field">
          <label htmlFor="client-timezone">Timezone</label>
          <TimezoneInput
            id="client-timezone"
            value={timezone}
            onChange={setTimezone}
            disabled={busy || pending !== null}
          />
          <p className="hint">
            Everything this Client schedules and reviews is read against this clock.
            Changing it does not move a single Scheduled Post — it changes what time each
            one appears to fire, and you are shown exactly how before it is applied.
          </p>
        </div>

        <button
          type="submit"
          className="button"
          disabled={busy || pending !== null || timezone.trim() === client.timezone}
        >
          Change timezone
        </button>
      </form>
    </section>
  );
}
