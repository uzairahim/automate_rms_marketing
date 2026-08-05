import { useEffect, useState } from "react";
import { getClient, isSessionEnded, type Client } from "./api.js";
import { AccessStatusBadge, PlanSummary } from "./client-bits.js";

/**
 * One Client — where the operator manages it, and where provisioning lands them.
 *
 * It reads rather than edits for now: the Users, Plan, and Branding sections
 * land in the slices after this one. What it shows is what an operator needs to
 * confirm they are looking at the right Client before doing anything to it.
 */
export function ClientDetail({
  clientId,
  onBack,
  onSessionEnded,
}: {
  clientId: string;
  onBack: () => void;
  onSessionEnded: () => void;
}) {
  const [client, setClient] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setClient(null);
    setError(null);
    getClient(clientId)
      .then((loaded) => {
        if (!cancelled) setClient(loaded);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (isSessionEnded(err)) onSessionEnded();
        else setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, onSessionEnded]);

  return (
    <>
      <button type="button" className="backlink" onClick={onBack}>
        ← All Clients
      </button>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {!error && !client && <p className="loading">Loading…</p>}

      {client && (
        <>
          <div className="toolbar">
            <h2 className="section-title">{client.subdomain}</h2>
            <AccessStatusBadge status={client.plan.accessStatus} />
          </div>

          <div className="card">
            <dl className="detail">
              <dt>Subdomain</dt>
              <dd>
                {client.subdomain}
                <span className="hint"> — permanent; the Client's URL</span>
              </dd>

              <dt>Timezone</dt>
              <dd>{client.timezone}</dd>

              {/* Access status is the badge beside the heading — stating it twice
                  on one screen would be two things to keep in agreement. */}
              <dt>Platforms</dt>
              <dd>
                <PlanSummary plan={client.plan} />
              </dd>
            </dl>
          </div>

          <p className="placeholder">
            This Client's Users, Plan, and Branding are administered here — those sections
            land next.
          </p>
        </>
      )}
    </>
  );
}
