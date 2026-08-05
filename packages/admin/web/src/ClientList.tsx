import { useEffect, useState } from "react";
import { hasLapsed, isSessionEnded, listClients, type Client } from "./api.js";
import { AccessStatusBadge, PlanSummary } from "./client-bits.js";

/**
 * Every Client on the platform, newest first.
 *
 * This is the operator's whole global view, so it is deliberately one
 * unfiltered, unpaged list: any control that could leave a Client off-screen
 * could leave a *lapsed* Client off-screen, which is the one thing this list
 * exists to make obvious.
 */
export function ClientList({
  onOpen,
  onProvision,
  onSessionEnded,
}: {
  onOpen: (clientId: string) => void;
  onProvision: () => void;
  onSessionEnded: () => void;
}) {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listClients()
      .then((loaded) => {
        if (!cancelled) setClients(loaded);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (isSessionEnded(err)) onSessionEnded();
        else setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [onSessionEnded]);

  return (
    <>
      <div className="toolbar">
        <h2 className="section-title">Clients</h2>
        <button type="button" className="button" onClick={onProvision}>
          Add a Client
        </button>
      </div>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {!error && clients === null && <p className="loading">Loading Clients…</p>}

      {clients?.length === 0 && (
        <p className="placeholder">
          No Clients yet. Provisioning one gives it a subdomain to be reached at and a
          Plan to work under.
        </p>
      )}

      {clients && clients.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Subdomain</th>
              <th scope="col">Access</th>
              <th scope="col">Platforms</th>
              <th scope="col">Timezone</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              // A lapsed Client is marked on the row itself, not only in its
              // status cell: the operator is scanning the list, not reading it.
              //
              // The whole row opens the Client, but the button is what makes
              // that reachable by keyboard and announced by a screen reader —
              // the row handler is a convenience over it, not the control.
              <tr
                key={client.id}
                className={`row-open${hasLapsed(client) ? " row-lapsed" : ""}`}
                onClick={() => onOpen(client.id)}
              >
                <td>
                  <button
                    type="button"
                    className="rowlink"
                    onClick={(event) => {
                      // The row would otherwise open it a second time.
                      event.stopPropagation();
                      onOpen(client.id);
                    }}
                  >
                    {client.subdomain}
                  </button>
                </td>
                <td>
                  <AccessStatusBadge status={client.plan.accessStatus} />
                </td>
                <td className="subtle">
                  <PlanSummary plan={client.plan} />
                </td>
                <td className="subtle">{client.timezone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
