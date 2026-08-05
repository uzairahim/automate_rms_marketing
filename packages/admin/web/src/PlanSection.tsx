import { useState } from "react";
import {
  ApiError,
  isSessionEnded,
  scheduledPostCounts,
  updatePlan,
  type AccessStatus,
  type Client,
  type Plan,
  type PlanPatch,
  type Platform,
  type ScheduledPostCounts,
} from "./api.js";
import { PLATFORM_OPTIONS } from "./client-bits.js";

/**
 * A Client's Plan — the operator's two real levers, and the previews that make
 * their consequences visible before either is committed.
 *
 * The shape of this screen follows from one asymmetry: giving a Client more
 * costs nothing, and taking something away breaks work it has already scheduled.
 * So enabling a platform and restoring access apply straight away, while
 * disabling a platform and suspending a Client first say how many Scheduled
 * Posts they are about to break, and can be backed out of.
 *
 * The confirmations are a courtesy, never the enforcement. A downgrade or a
 * suspension stops publishing whether or not anyone read the number first
 * (ADR 0011) — so a preview that fails to load is worth saying plainly and worth
 * proceeding past, and is never allowed to be the thing that makes the platform
 * safe.
 *
 * Every control is driven by the Plan the API last returned, never by local
 * optimism. A checkbox that flipped before its confirmation was answered would
 * be showing the operator something untrue at exactly the moment they are
 * deciding.
 */

/** A change that is waiting on the operator to confirm or back out of it. */
type Pending =
  | { kind: "platform"; platform: Platform }
  | { kind: "access"; status: Exclude<AccessStatus, "active"> };

/** The patch a confirmed change sends. */
function patchFor(pending: Pending): PlanPatch {
  return pending.kind === "platform"
    ? { [pending.platform]: false }
    : { accessStatus: pending.status };
}

/** How many Scheduled Posts a pending change would break, from a loaded count. */
function affected(pending: Pending, counts: ScheduledPostCounts): number {
  return pending.kind === "platform" ? counts.byPlatform[pending.platform] : counts.total;
}

/** "1 Scheduled Post" / "3 Scheduled Posts" — the count reads as prose, not data. */
function scheduledPosts(count: number): string {
  return `${count} Scheduled ${count === 1 ? "Post" : "Posts"}`;
}

/**
 * What the operator is about to break, in their own terms.
 *
 * Careful, in both cases, not to imply that anything waits. A Post that comes
 * due while it is ineligible is **Failed**, never held for later — holding was
 * rejected in ADR 0011, because reactivating after a lapse would dump stale
 * Posts onto live accounts at the wrong hours. An operator told that Posts
 * "will not publish while suspended" would reasonably expect them to publish
 * afterwards, and would be choosing on the strength of something untrue.
 */
function consequence(pending: Pending, counts: ScheduledPostCounts): string {
  const count = affected(pending, counts);

  if (pending.kind === "platform") {
    const label =
      PLATFORM_OPTIONS.find((p) => p.key === pending.platform)?.label ?? pending.platform;
    if (count === 0) return `No Scheduled Post targets ${label}.`;
    return (
      `${scheduledPosts(count)} target ${label}. Each of those Targets fails when its Post ` +
      `fires — any other platform the same Post targets still publishes normally.`
    );
  }

  const state = pending.status === "suspended" ? "suspended" : "expired";
  if (count === 0) {
    return `This Client has no Scheduled Posts. It publishes nothing while it is ${state}.`;
  }
  return (
    `This Client has ${scheduledPosts(count)}. Each one fails when its time comes rather ` +
    `than waiting, so restoring access later does not publish them.`
  );
}

export function PlanSection({
  client,
  onPlanChanged,
  onSessionEnded,
}: {
  client: Client;
  onPlanChanged: (plan: Plan) => void;
  onSessionEnded: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  /** The preview for `pending`: null while it is still being read. */
  const [counts, setCounts] = useState<ScheduledPostCounts | null>(null);
  /** Set when the preview could not be read — the change is still offered. */
  const [countsError, setCountsError] = useState(false);

  const plan = client.plan;
  const lapsed = plan.accessStatus !== "active";

  /** Send a patch and adopt whatever Plan comes back. */
  async function apply(patch: PlanPatch): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onPlanChanged(await updatePlan(client.id, patch));
      setPending(null);
    } catch (err) {
      if (isSessionEnded(err)) return onSessionEnded();
      setError(err instanceof ApiError ? err.message : "Could not change the Plan. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Open a confirmation, and read what the change would cost while it is open. */
  async function confirm(next: Pending): Promise<void> {
    setError(null);
    setCounts(null);
    setCountsError(false);
    setPending(next);
    try {
      setCounts(await scheduledPostCounts(client.id));
    } catch (err) {
      if (isSessionEnded(err)) return onSessionEnded();
      // Deliberately not fatal: the numbers are a courtesy, and refusing to let
      // the operator suspend a Client because a count would not load would be
      // the preview standing in the way of the control it exists to explain.
      setCountsError(true);
    }
  }

  function togglePlatform(platform: Platform, enabled: boolean): void {
    // Turning one on breaks nothing, so there is nothing to warn about.
    if (enabled) void apply({ [platform]: true });
    else void confirm({ kind: "platform", platform });
  }

  return (
    <section className="section">
      <h3 className="subsection-title">Plan</h3>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {pending && (
        <div className="confirm" role="alertdialog" aria-labelledby="confirm-title">
          <p id="confirm-title" className="confirm-title">
            {pending.kind === "platform"
              ? `Turn off ${PLATFORM_OPTIONS.find((p) => p.key === pending.platform)?.label}?`
              : pending.status === "suspended"
                ? "Suspend this Client?"
                : "Mark this Client expired?"}
          </p>

          <p className="confirm-body">
            {countsError
              ? "Could not read how many Scheduled Posts this affects. The change can still be made."
              : counts
                ? consequence(pending, counts)
                : "Checking what this affects…"}
          </p>

          <div className="confirm-actions">
            {/* Held back until the preview has resolved one way or the other.
                The whole point of this panel is that the operator decides
                *knowing* the cost, and a Confirm that is live while the body
                still reads "checking…" lets them commit having been told
                nothing. A preview that failed outright still enables it — see
                `confirm` above for why that is deliberate. */}
            <button
              type="button"
              className="button button-danger"
              onClick={() => void apply(patchFor(pending))}
              disabled={busy || (counts === null && !countsError)}
            >
              {busy ? "Applying…" : "Confirm"}
            </button>
            <button
              type="button"
              className="linkbutton"
              onClick={() => setPending(null)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <fieldset className="field fieldset">
          <legend>Platforms</legend>
          {PLATFORM_OPTIONS.map((platform) => (
            <label key={platform.key} className="checkline">
              <input
                type="checkbox"
                checked={plan[platform.key]}
                disabled={busy || pending !== null}
                onChange={(e) => togglePlatform(platform.key, e.target.checked)}
              />
              {platform.label}
            </label>
          ))}
          <p className="hint">
            What this Client's Users may see and act on. Turning one off is confirmed
            first, with how much of what they have already scheduled it breaks.
          </p>
        </fieldset>

        <div className="field access">
          <span className="access-label">Access</span>
          <div className="access-actions">
            {lapsed ? (
              <button
                type="button"
                className="button"
                onClick={() => void apply({ accessStatus: "active" })}
                disabled={busy || pending !== null}
              >
                Restore to active
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => void confirm({ kind: "access", status: "suspended" })}
                  disabled={busy || pending !== null}
                >
                  Suspend
                </button>
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => void confirm({ kind: "access", status: "expired" })}
                  disabled={busy || pending !== null}
                >
                  Mark expired
                </button>
              </>
            )}
          </div>
          <p className="hint">
            Payment is handled off the platform; this is the whole mechanism. A Client
            that is not active cannot log in and publishes nothing. Nothing of theirs is
            deleted — but a Post that comes due meanwhile fails rather than waiting, so
            restoring access does not send it late.
          </p>
        </div>
      </div>
    </section>
  );
}
