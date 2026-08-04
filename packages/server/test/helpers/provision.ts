import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { createClient, createUser, type PlanPatch } from "@smma/core";
import { TEST_BASE_DOMAIN } from "./app.js";

/**
 * Provisioning a Client and its Users — the setup almost every suite needs
 * before it can exercise anything.
 *
 * This calls `@smma/core`'s provisioning functions directly rather than driving
 * the Superadmin HTTP API. Provisioning is *setup* for the publishing,
 * scheduling, and analytics suites, never the behavior under assertion, so it
 * has no business being coupled to an administrative endpoint — and that
 * endpoint moves to its own service in #15's final slice. The suites that do
 * assert on the Superadmin API still drive it directly; they are testing it.
 *
 * The Client API itself is still entered through the front door: a User arrives
 * with a session token obtained from the real login route, exactly as before.
 */

/** The password every provisioned User gets unless a suite asks for another. */
export const TEST_PASSWORD = "correct horse battery";

/** The Host header that puts a request on a Client's subdomain. */
export function clientHost(subdomain: string, baseDomain = TEST_BASE_DOMAIN): string {
  return `${subdomain}.${baseDomain}`;
}

export interface ClientInput {
  subdomain?: string;
  timezone?: string;
  /** Platform toggles; omitted platforms default off, as at the real front door. */
  plan?: PlanPatch;
}

export interface UserInput {
  email?: string;
  password?: string;
}

/** A provisioned Client. */
export interface ClientFixture {
  clientId: string;
  subdomain: string;
}

/** A provisioned User, and the Client it belongs to. */
export interface UserFixture {
  clientId: string;
  userId: string;
  email: string;
  password: string;
}

/** A Client provisioned together with its first User. */
export interface ClientWithUserFixture extends ClientFixture, UserFixture {}

/** A provisioned User with a live session on their Client's subdomain. */
export interface LoggedInFixture extends ClientWithUserFixture {
  /** The session token itself, for suites that assert on it directly. */
  token: string;
  /** Headers that authenticate the User: their Client's Host plus the bearer. */
  auth: Record<string, string>;
}

/** Provision a Client, with no Users yet. */
export async function provisionClient(
  pool: pg.Pool,
  input: ClientInput = {},
): Promise<ClientFixture> {
  const subdomain = input.subdomain ?? "acme";
  const client = await createClient(pool, {
    subdomain,
    timezone: input.timezone ?? "America/New_York",
    plan: input.plan,
  });
  return { clientId: client.id, subdomain };
}

/** Provision one more User under an already-provisioned Client. */
export async function provisionUser(
  pool: pg.Pool,
  clientId: string,
  input: { email: string; password?: string },
): Promise<UserFixture> {
  const password = input.password ?? TEST_PASSWORD;
  const user = await createUser(pool, { clientId, email: input.email, password });
  return { clientId, userId: user.id, email: input.email, password };
}

/** Provision a Client and its first User — the common case. */
export async function provisionClientWithUser(
  pool: pg.Pool,
  input: ClientInput & UserInput = {},
): Promise<ClientWithUserFixture> {
  const client = await provisionClient(pool, input);
  const user = await provisionUser(pool, client.clientId, {
    email: input.email ?? `u@${client.subdomain}.test`,
    password: input.password,
  });
  return { ...client, ...user };
}

/**
 * Log a provisioned User in through the real login route, returning their
 * session token and the headers that authenticate them.
 */
export async function loginAs(
  app: FastifyInstance,
  user: { subdomain: string; email: string; password: string },
  baseDomain = TEST_BASE_DOMAIN,
): Promise<{ token: string; auth: Record<string, string> }> {
  const host = clientHost(user.subdomain, baseDomain);
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { host },
    payload: { email: user.email, password: user.password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Login failed for ${user.email} (${res.statusCode}): ${res.body}`);
  }
  const token = res.json().token as string;
  return { token, auth: { host, authorization: `Bearer ${token}` } };
}

/** Provision a Client and its first User, and log that User in. */
export async function provisionAndLogin(
  app: FastifyInstance,
  pool: pg.Pool,
  input: ClientInput & UserInput = {},
  baseDomain = TEST_BASE_DOMAIN,
): Promise<LoggedInFixture> {
  const user = await provisionClientWithUser(pool, input);
  return { ...user, ...(await loginAs(app, user, baseDomain)) };
}
