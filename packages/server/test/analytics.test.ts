import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  TEST_BASE_DOMAIN,
  TEST_ENCRYPTION_KEY,
  TEST_SUPERADMIN_TOKEN,
} from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher, type PageSpec } from "../src/core/fake-publisher.js";
import { createSecretCipher } from "../src/core/crypto.js";
import { recordDailySnapshots, snapshotDateFor } from "../src/analytics/snapshot-job.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Slice 12 behavioral suite — account-level analytics: the daily snapshot job
 * that records each Connected Account's numbers, and the dashboard that trends
 * them (ADR 0004).
 *
 * The connect flow runs through the real Fastify API (so the job reads a real,
 * sealed credential), but the job itself is driven directly — the BullMQ trigger
 * is Redis's business; "which accounts, dated how, storing what" is ours (PRD
 * Testing Decisions). The platform reads are faked and the Clock is injected, so
 * "a week of trends" is a fact the test just states rather than waits for.
 */

const ADMIN_HOST = `admin.${TEST_BASE_DOMAIN}`;
const host = (subdomain: string) => `${subdomain}.${TEST_BASE_DOMAIN}`;
const PASSWORD = "correct horse battery";
const NOW = new Date("2026-07-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const PAGE_WITH_IG: PageSpec = {
  id: "page-a",
  name: "Acme Storefront",
  instagram: { id: "ig-acme", username: "acme.official" },
};
/** The Page token the connect flow seals for `page-a` (see fake-publisher's fakePage). */
const PAGE_TOKEN = "fake-page-token-page-a";

interface Point {
  date: string;
  followers: number | null;
  reach: number | null;
  engagement: number | null;
  postsPublished: number | null;
}
interface Series {
  platform: string;
  displayName: string | null;
  series: Point[];
}

describe("Account-level analytics dashboard + daily snapshot job", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(NOW);
  const publisher = new FakePublisher();
  const cipher = createSecretCipher(TEST_ENCRYPTION_KEY);

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
      "TRUNCATE clients, users, sessions, connected_accounts, oauth_states, metric_snapshots RESTART IDENTITY CASCADE",
    );
    publisher.reset();
    clock.set(NOW);
  });

  async function client(
    subdomain = "acme",
    timezone = "America/New_York",
  ): Promise<{ clientId: string; auth: Record<string, string> }> {
    const clientRes = await app.inject({
      method: "POST",
      url: "/api/admin/clients",
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: {
        subdomain,
        timezone,
        plan: { facebook: true, instagram: true, tiktok: true },
      },
    });
    expect(clientRes.statusCode).toBe(201);
    const clientId = clientRes.json().id as string;

    const email = `u@${subdomain}.test`;
    const userRes = await app.inject({
      method: "POST",
      url: `/api/admin/clients/${clientId}/users`,
      headers: { host: ADMIN_HOST, ...adminAuth },
      payload: { email, password: PASSWORD },
    });
    expect(userRes.statusCode).toBe(201);

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: host(subdomain) },
      payload: { email, password: PASSWORD },
    });
    expect(loginRes.statusCode).toBe(200);

    return {
      clientId,
      auth: { host: host(subdomain), authorization: `Bearer ${loginRes.json().token as string}` },
    };
  }

  async function connectPlatforms(
    auth: Record<string, string>,
    platforms: Array<"facebook" | "instagram" | "tiktok">,
  ): Promise<void> {
    if (platforms.includes("facebook") || platforms.includes("instagram")) {
      publisher.scriptPages(PAGE_WITH_IG);
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
      await app.inject({
        method: "POST",
        url: "/api/connections/facebook/select",
        payload: { state, pageId: PAGE_WITH_IG.id },
      });
    }
    if (platforms.includes("instagram")) {
      await app.inject({
        method: "POST",
        url: "/api/connections/instagram/connect",
        headers: auth,
      });
    }
    if (platforms.includes("tiktok")) {
      const start = await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/start",
        headers: auth,
      });
      await app.inject({
        method: "POST",
        url: "/api/connections/tiktok/callback",
        payload: { state: start.json().state as string, code: "auth-code" },
      });
    }
    // The connect flow leaves scripted pages behind; clear them so a later
    // scriptAccountMetrics call is the only thing driving the job.
    publisher.scriptPages(PAGE_WITH_IG);
  }

  const runJob = () => recordDailySnapshots(db.pool, clock, cipher, publisher);

  const getAnalytics = (auth: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/analytics", headers: auth });

  const seriesFor = (body: { accounts: Series[] }, platform: string): Series | undefined =>
    body.accounts.find((a) => a.platform === platform);

  it("records a connected account's account-level numbers and the dashboard reads them", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook"]);
    publisher.scriptAccountMetrics("facebook", {
      followers: 1200,
      reach: 8000,
      engagement: 340,
      postsPublished: 57,
    });

    const outcome = await runJob();
    expect(outcome).toEqual({ recorded: 1, skipped: 0, expired: 0 });

    const res = await getAnalytics(auth);
    expect(res.statusCode).toBe(200);
    const fb = seriesFor(res.json(), "facebook");
    expect(fb?.displayName).toBe("Acme Storefront");
    expect(fb?.series).toEqual([
      { date: "2026-07-20", followers: 1200, reach: 8000, engagement: 340, postsPublished: 57 },
    ]);

    // The read was authenticated by the account's own credential and keyed by its
    // destination id — proving the job read the right account.
    expect(publisher.accountMetricReads).toHaveLength(1);
    expect(publisher.accountMetricReads[0]).toMatchObject({
      platform: "facebook",
      externalId: "page-a",
    });
    expect(publisher.accountMetricReads[0]?.credential.accessToken).toBe(PAGE_TOKEN);
  });

  it("shows a trend over time — one point per day the job runs, in date order", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook"]);

    publisher.scriptAccountMetrics("facebook", { followers: 100 });
    await runJob();

    clock.advance(DAY_MS);
    publisher.scriptAccountMetrics("facebook", { followers: 130 });
    await runJob();

    clock.advance(DAY_MS);
    publisher.scriptAccountMetrics("facebook", { followers: 175 });
    await runJob();

    const fb = seriesFor(getBody(await getAnalytics(auth)), "facebook");
    expect(fb?.series.map((p) => [p.date, p.followers])).toEqual([
      ["2026-07-20", 100],
      ["2026-07-21", 130],
      ["2026-07-22", 175],
    ]);
  });

  it("re-running the job on the same day updates that day's row, never duplicating it", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook"]);

    publisher.scriptAccountMetrics("facebook", { followers: 100 });
    await runJob();
    // Same day, corrected numbers (e.g. the platform revised them).
    publisher.scriptAccountMetrics("facebook", { followers: 118 });
    await runJob();

    const fb = seriesFor(getBody(await getAnalytics(auth)), "facebook");
    expect(fb?.series).toHaveLength(1);
    expect(fb?.series[0]).toMatchObject({ date: "2026-07-20", followers: 118 });
  });

  it("charts every connected platform the same way — identical shape across Facebook, Instagram, TikTok", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook", "instagram", "tiktok"]);
    publisher.scriptAccountMetrics("facebook", {
      followers: 1000,
      reach: 5000,
      engagement: 200,
      postsPublished: 40,
    });
    publisher.scriptAccountMetrics("instagram", {
      followers: 3000,
      reach: 9000,
      engagement: 800,
      postsPublished: 120,
    });
    // TikTok's basic API exposes no reach — the field is simply absent (stored null).
    publisher.scriptAccountMetrics("tiktok", {
      followers: 500,
      engagement: 60,
      postsPublished: 25,
    });

    await runJob();

    const body = getBody(await getAnalytics(auth));
    expect(body.accounts.map((a) => a.platform)).toEqual(["facebook", "instagram", "tiktok"]);
    // Every platform's point carries the same four keys — the dashboard charts
    // one shape, not three. TikTok's missing reach is null, not absent.
    for (const account of body.accounts) {
      expect(account.series).toHaveLength(1);
      expect(Object.keys(account.series[0]!).sort()).toEqual([
        "date",
        "engagement",
        "followers",
        "postsPublished",
        "reach",
      ]);
    }
    expect(seriesFor(body, "tiktok")?.series[0]?.reach).toBeNull();
    expect(seriesFor(body, "instagram")?.series[0]?.followers).toBe(3000);
  });

  it("reflects only the Client's connected platforms", async () => {
    const { auth } = await client();
    // Plan enables all three, but only Facebook is actually connected.
    await connectPlatforms(auth, ["facebook"]);
    await runJob();

    const body = getBody(await getAnalytics(auth));
    expect(body.accounts.map((a) => a.platform)).toEqual(["facebook"]);
  });

  it("never shows one Client another Client's analytics", async () => {
    const acme = await client("acme");
    const globex = await client("globex");
    await connectPlatforms(acme.auth, ["facebook"]);
    publisher.scriptAccountMetrics("facebook", { followers: 999 });
    await runJob();

    const body = getBody(await getAnalytics(globex.auth));
    expect(body.accounts).toEqual([]);
  });

  it("handles a freshly-connected account gracefully — it appears with an empty series until the first snapshot", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook"]);

    // Connected, but the daily job has not run yet: the platform is present so the
    // dashboard can render it, with nothing to chart.
    const before = getBody(await getAnalytics(auth));
    expect(seriesFor(before, "facebook")).toMatchObject({ series: [] });

    await runJob();
    const after = getBody(await getAnalytics(auth));
    expect(seriesFor(after, "facebook")?.series).toHaveLength(1);
  });

  it("does not backfill history from before an account was connected", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook"]);

    // A day of Facebook-only history.
    publisher.scriptAccountMetrics("facebook", { followers: 100 });
    await runJob();

    // Instagram is connected the next day and snapshotted from then on.
    clock.advance(DAY_MS);
    await connectPlatforms(auth, ["instagram"]);
    publisher.scriptAccountMetrics("instagram", { followers: 700 });
    await runJob();

    const body = getBody(await getAnalytics(auth));
    // Instagram's trend starts on day 2 — no invented day-1 point.
    expect(seriesFor(body, "instagram")?.series.map((p) => p.date)).toEqual(["2026-07-21"]);
    expect(seriesFor(body, "facebook")?.series.map((p) => p.date)).toEqual([
      "2026-07-20",
      "2026-07-21",
    ]);
  });

  it("skips an account whose platform refuses the read, without dropping the rest", async () => {
    const { auth } = await client();
    await connectPlatforms(auth, ["facebook", "tiktok"]);
    publisher.scriptAccountMetrics("facebook", { followers: 100 });
    publisher.scriptAccountMetricsFailure("tiktok", "TikTok analytics are throttled.");

    const outcome = await runJob();
    expect(outcome).toEqual({ recorded: 1, skipped: 1, expired: 0 });

    const body = getBody(await getAnalytics(auth));
    // Facebook recorded; TikTok present (still connected) but with no point today.
    expect(seriesFor(body, "facebook")?.series).toHaveLength(1);
    expect(seriesFor(body, "tiktok")?.series).toEqual([]);
  });

  it("anchors each snapshot's date to the Client's timezone, not the server's", async () => {
    // 02:00 UTC on the 20th is still 22:00 on the 19th in New York.
    clock.set(new Date("2026-07-20T02:00:00.000Z"));
    const { auth } = await client("acme", "America/New_York");
    await connectPlatforms(auth, ["facebook"]);
    publisher.scriptAccountMetrics("facebook", { followers: 100 });

    await runJob();

    const fb = seriesFor(getBody(await getAnalytics(auth)), "facebook");
    expect(fb?.series[0]?.date).toBe("2026-07-19");
  });

  it("requires an authenticated session", async () => {
    await client();
    const res = await app.inject({
      method: "GET",
      url: "/api/analytics",
      headers: { host: host("acme") },
    });
    expect(res.statusCode).toBe(401);
  });

  it("computes the snapshot date in the given timezone", () => {
    const instant = new Date("2026-07-20T02:00:00.000Z");
    expect(snapshotDateFor(instant, "America/New_York")).toBe("2026-07-19");
    expect(snapshotDateFor(instant, "UTC")).toBe("2026-07-20");
    expect(snapshotDateFor(instant, "Asia/Tokyo")).toBe("2026-07-20");
  });
});

function getBody(res: { json(): unknown }): { accounts: Series[] } {
  return res.json() as { accounts: Series[] };
}
