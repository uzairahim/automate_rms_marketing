import { useEffect, useState } from "react";
import { getClient, isSessionEnded, type Client, type Plan } from "./api.js";
import { AccessStatusBadge } from "./client-bits.js";
import { PlanSection } from "./PlanSection.js";
import { Users } from "./Users.js";
import { BrandingSection } from "./BrandingSection.js";
import { TimezoneSection } from "./TimezoneSection.js";

/**
 * One Client — where the operator manages it, and where provisioning lands them.
 *
 * It opens with what an operator needs to confirm they are looking at the right
 * Client before doing anything to it, and then the sections that act on it: its
 * Plan, its Users, its Branding, and the clock it is anchored to.
 *
 * The sections are ordered by how often an operator has business in them: the
 * Plan and the Users are what a working day is made of, where a Client's look
 * and its timezone are set once and then rarely touched.
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

          {/* Nothing about the Client is restated here as a summary. Its
              subdomain, its timezone, its platforms and its access status are
              all live controls further down the screen, and a summary that
              agrees with them until it doesn't is worse than no summary — the
              badge beside the heading is the one at-a-glance statement, and it
              comes from the same state. */}

          <PlanSection
            client={client}
            onPlanChanged={(plan: Plan) => setClient({ ...client, plan })}
            onSessionEnded={onSessionEnded}
          />

          <Users
            clientId={client.id}
            subdomain={client.subdomain}
            onSessionEnded={onSessionEnded}
          />

          <BrandingSection
            clientId={client.id}
            subdomain={client.subdomain}
            onSessionEnded={onSessionEnded}
          />

          <TimezoneSection
            client={client}
            onClientChanged={setClient}
            onSessionEnded={onSessionEnded}
          />
        </>
      )}
    </>
  );
}
