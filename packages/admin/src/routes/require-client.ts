import type pg from "pg";
import { ProvisionError, findClientById, type Client } from "@smma/core";

/**
 * Resolve the Client named in a path, or refuse.
 *
 * Read explicitly rather than left to a foreign-key violation, because most of
 * these routes have no insert to fail: without it, listing the Users of a Client
 * that does not exist would answer an empty list, and previewing the
 * consequences of changing one would answer "nothing scheduled" — both of which
 * read exactly like a Client that exists and has none.
 *
 * Raised rather than answered here, so "no such Client" has one status and one
 * message across every route that can say it.
 */
export async function requireClient(pool: pg.Pool, clientId: string): Promise<Client> {
  const client = await findClientById(pool, clientId);
  if (!client) {
    throw new ProvisionError("client_not_found", `No such Client: ${clientId}`);
  }
  return client;
}
