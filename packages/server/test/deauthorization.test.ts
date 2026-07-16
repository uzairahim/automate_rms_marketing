import { createHmac } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  TEST_BASE_DOMAIN,
  TEST_META_APP_SECRET,
  TEST_SUPERADMIN_TOKEN,
} from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher, FAKE_PLATFORM_USER_ID } from "../src/core/fake-publisher.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Slice 6 — Meta's deauthorization callback. Mandatory for App Review, and the
 * one path where a connection ends from the platform's side rather than ours:
 * the person removes our app in their Facebook settings and Meta tells us.
 *
 * It is a public, unauthenticated endpoint — anyone can POST to it — so what
 * makes it safe is the signature: Meta signs the payload with our app secret,
 * which only Meta and we know. These tests therefore care as much about what it
 * *refuses* as what it does.
 */

const ADMIN_HOST = `admin.${TEST_BASE_DOMAIN}`;
const host = (subdomain: string) => `${subdomain}.${TEST_BASE_DOMAIN}`;

const PASSWORD = "correct horse battery";

/** Build a `signed_request` exactly as Meta does: `<signature>.<payload>`. */
function signedRequest(payload: object, secret = TEST_META_APP_SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${signature}.${encoded}`;
}

describe("Meta deauthorization callback", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(new Date("2026-07-16T09:00:00.000Z"));
  const publisher = new FakePublisher();

  const adminAuth = { authorization: `Bearer ${TEST_SUPERADMIN_TOKEN}` };

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildTestApp({ pool: db.pool, clock, publisher });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query(
      "TRUNCATE clients, users, sessions, connected_accounts, oauth_states RESTART IDENTITY CASCADE",
    );
    publisher.reset();
  });

  /** Provision a Facebook-enabled Client and connect a Page to it. */
  async function clientWithConnectedPage(
    subdomain: string,
  ): Promise<Record<string, string>> {
    const clientRes = await app.inject({
      method: "POST",
      url: "/api/admin/clients",
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: { subdomain, timezone: "America/New_York", plan: { facebook: true } },
    });
    const clientId = clientRes.json().id as string;
    const email = `u@${subdomain}.test`;
    await app.inject({
      method: "POST",
      url: `/api/admin/clients/${clientId}/users`,
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: { email, password: PASSWORD },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: host(subdomain) },
      payload: { email, password: PASSWORD },
    });
    const auth = {
      host: host(subdomain),
      authorization: `Bearer ${loginRes.json().token}`,
    };

    publisher.scriptPages({ id: `${subdomain}-page`, name: `${subdomain} Page` });
    const start = await app.inject({
      method: "POST",
      url: "/api/connections/facebook/start",
      headers: auth,
    });
    const state = start.json().state as string;
    await app.inject({
      method: "POST",
      url: "/api/connections/facebook/callback",
      payload: { state, code: "auth-code" },
    });
    const select = await app.inject({
      method: "POST",
      url: "/api/connections/facebook/select",
      payload: { state, pageId: `${subdomain}-page` },
    });
    expect(select.statusCode).toBe(200);
    return auth;
  }

  async function deauthorize(body: string) {
    return app.inject({
      method: "POST",
      url: "/api/webhooks/meta/deauthorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: body,
    });
  }

  const statusOf = async (auth: Record<string, string>) => {
    const res = await app.inject({ method: "GET", url: "/api/connections", headers: auth });
    return res.json().connections[0];
  };

  it("marks the Connected Account disconnected when the person removes our app", async () => {
    const auth = await clientWithConnectedPage("acme");
    expect(await statusOf(auth)).toMatchObject({ status: "connected" });

    const res = await deauthorize(
      `signed_request=${signedRequest({
        algorithm: "HMAC-SHA256",
        user_id: FAKE_PLATFORM_USER_ID,
        issued_at: 1_784_000_000,
      })}`,
    );

    expect(res.statusCode).toBe(200);
    expect(await statusOf(auth)).toMatchObject({
      status: "disconnected",
      externalId: null,
    });
  });

  it("drops the credential of an account it disconnects", async () => {
    await clientWithConnectedPage("acme");

    await deauthorize(
      `signed_request=${signedRequest({
        algorithm: "HMAC-SHA256",
        user_id: FAKE_PLATFORM_USER_ID,
      })}`,
    );

    const { rows } = await db.pool.query(
      "SELECT credential FROM connected_accounts WHERE platform = 'facebook'",
    );
    expect(rows[0]).toEqual({ credential: null });
  });

  it("ignores a request that is not signed with our app secret", async () => {
    const auth = await clientWithConnectedPage("acme");

    const res = await deauthorize(
      `signed_request=${signedRequest(
        { algorithm: "HMAC-SHA256", user_id: FAKE_PLATFORM_USER_ID },
        "not-our-app-secret",
      )}`,
    );

    expect(res.statusCode).toBe(400);
    // The forgery changed nothing: an unsigned "disconnect everyone" is the
    // obvious attack on a public endpoint.
    expect(await statusOf(auth)).toMatchObject({ status: "connected" });
  });

  it("ignores a payload tampered with after signing", async () => {
    const auth = await clientWithConnectedPage("acme");
    const [signature] = signedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "someone-else",
    }).split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ algorithm: "HMAC-SHA256", user_id: FAKE_PLATFORM_USER_ID }),
    ).toString("base64url");

    const res = await deauthorize(`signed_request=${signature}.${forgedPayload}`);

    expect(res.statusCode).toBe(400);
    expect(await statusOf(auth)).toMatchObject({ status: "connected" });
  });

  it("rejects a signature algorithm we did not agree to", async () => {
    await clientWithConnectedPage("acme");
    const res = await deauthorize(
      `signed_request=${signedRequest({ algorithm: "none", user_id: FAKE_PLATFORM_USER_ID })}`,
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed signed_request", async () => {
    for (const body of ["signed_request=garbage", "signed_request=", "note=hello"]) {
      expect((await deauthorize(body)).statusCode).toBe(400);
    }
  });

  it("disconnects only the accounts that person authorized", async () => {
    const acme = await clientWithConnectedPage("acme");
    const globex = await clientWithConnectedPage("globex");

    const res = await deauthorize(
      `signed_request=${signedRequest({
        algorithm: "HMAC-SHA256",
        user_id: "a-different-facebook-user",
      })}`,
    );

    // Meta has nothing of ours to disconnect, which is not an error.
    expect(res.statusCode).toBe(200);
    expect(await statusOf(acme)).toMatchObject({ status: "connected" });
    expect(await statusOf(globex)).toMatchObject({ status: "connected" });
  });

  it("is idempotent — Meta may deliver the same callback twice", async () => {
    const auth = await clientWithConnectedPage("acme");
    const body = `signed_request=${signedRequest({
      algorithm: "HMAC-SHA256",
      user_id: FAKE_PLATFORM_USER_ID,
    })}`;

    expect((await deauthorize(body)).statusCode).toBe(200);
    expect((await deauthorize(body)).statusCode).toBe(200);
    expect(await statusOf(auth)).toMatchObject({ status: "disconnected" });
  });
});
