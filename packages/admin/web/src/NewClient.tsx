import { useState, type FormEvent } from "react";
import { ApiError, createClient, isSessionEnded, type Platform } from "./api.js";
import { PLATFORM_OPTIONS, TimezoneInput } from "./client-bits.js";

/**
 * Provisioning a Client.
 *
 * The rules are the platform's, not this form's: the subdomain must be a usable
 * DNS label and free, and the timezone must be real. The form asks the API and
 * shows what it said, rather than re-implementing a second, drifting copy of
 * those rules in the browser — the API's message already names the collision or
 * the bad value.
 *
 * There is no access status field: a new Client is always active.
 */

/** The operator's own timezone — the likeliest answer for a Client they just sold. */
function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function NewClient({
  onCreated,
  onCancel,
  onSessionEnded,
}: {
  onCreated: (clientId: string) => void;
  onCancel: () => void;
  onSessionEnded: () => void;
}) {
  const [subdomain, setSubdomain] = useState("");
  const [timezone, setTimezone] = useState(localTimezone());
  const [plan, setPlan] = useState<Record<Platform, boolean>>({
    facebook: false,
    instagram: false,
    tiktok: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const client = await createClient({ subdomain, timezone, plan });
      // Straight to the Client's own screen: the next thing to do is add its
      // first User, and that is where it happens.
      onCreated(client.id);
    } catch (err) {
      if (isSessionEnded(err)) return onSessionEnded();
      setError(
        err instanceof ApiError ? err.message : "Could not create the Client. Please try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <h2 className="section-title">Add a Client</h2>
        <button type="button" className="linkbutton" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <form className="card card-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="subdomain">Subdomain</label>
          <input
            id="subdomain"
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value)}
            required
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="acme"
          />
          <p className="hint">
            Where the Client is reached, and permanent — it cannot be changed once every
            link and bookmark points at it.
          </p>
        </div>

        <div className="field">
          <label htmlFor="timezone">Timezone</label>
          <TimezoneInput id="timezone" value={timezone} onChange={setTimezone} />
          <p className="hint">
            The local clock everything the Client schedules and reviews is anchored to.
            Correctable later, unlike the subdomain.
          </p>
        </div>

        <fieldset className="field fieldset">
          <legend>Platforms</legend>
          {PLATFORM_OPTIONS.map((platform) => (
            <label key={platform.key} className="checkline">
              <input
                type="checkbox"
                checked={plan[platform.key]}
                onChange={(e) => setPlan({ ...plan, [platform.key]: e.target.checked })}
              />
              {platform.label}
            </label>
          ))}
          <p className="hint">What the Client's Plan includes. Changeable later.</p>
        </fieldset>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        <button type="submit" className="button button-block" disabled={submitting}>
          {submitting ? "Creating…" : "Create Client"}
        </button>
      </form>
    </>
  );
}
