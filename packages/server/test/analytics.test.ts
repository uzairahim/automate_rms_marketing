import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  TEST_BASE_DOMAIN,
  TEST_ENCRYPTION_KEY,
} from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher, type PageSpec } from "../src/core/fake-publisher.js";
import { createSecretCipher } from "../src/core/crypto.js";
import { recordDailySnapshots, snapshotDateFor } from "../src/analytics/snapshot-job.js";
import { retryDueTargets } from "../src/posts/retry.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { provisionAndLogin } from "./helpers/provision.js";

/**
 * Slice 12 behavioral suite — the dashboard and what feeds it (ADR 0004).
 *
 * Two halves, matching the two halves of the screen: the daily snapshot job that
 * records what the *platforms* say about each Connected Account, and the
 * publishing activity read straight out of what *we* did — one delivery per
 * Target that settled. Both are cut to the same window by the same range.
 *
 * The connect and publish flows run through the real Fastify API (so the job
 * reads a real, sealed credential and a real Target actually settles), but the
 * recurring jobs are driven directly — the BullMQ trigger is Redis's business;
 * "which accounts, dated how, storing what" is ours (PRD Testing Decisions). The
 * platform reads are faked and the Clock is injected, so "a week of trends" is a
 * fact the test just states rather than waits for.
 */

const host = (subdomain: string) => `${subdomain}.${TEST_BASE_DOMAIN}`;
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
interface Activity {
  daily: Array<{ date: string; published: number; failed: number }>;
  byPlatform: Array<{ platform: string; published: number; failed: number }>;
  posts: Record<string, number>;
  upcoming: { scheduled: number; drafts: number; nextScheduledAt: string | null };
}
interface Dashboard {
  range: { days: number; from: string; to: string };
  accounts: Series[];
  posts: Activity;
}

describe("Account-level analytics dashboard + daily snapshot job", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(NOW);
  const publisher = new FakePublisher();
  const cipher = createSecretCipher(TEST_ENCRYPTION_KEY);

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
      "TRUNCATE clients, users, sessions, connected_accounts, oauth_states, metric_snapshots, posts, targets " +
        "RESTART IDENTITY CASCADE",
    );
    publisher.reset();
    clock.set(NOW);
  });

  /** Provision an all-platforms Client + User, and log that User in. */
  async function client(
    subdomain = "acme",
    timezone = "America/New_York",
  ): Promise<{ clientId: string; auth: Record<string, string> }> {
    return provisionAndLogin(app, db.pool, {
      subdomain,
      timezone,
      plan: { facebook: true, instagram: true, tiktok: true },
    });
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

  const getAnalytics = (auth: Record<string, string>, days?: number) =>
    app.inject({
      method: "GET",
      url: days === undefined ? "/api/analytics" : `/api/analytics?days=${days}`,
      headers: auth,
    });

  /**
   * Compose and immediately publish a Post to `platforms`, returning its id.
   * A video is attached whenever a platform demands media, so the same helper
   * covers a text-only Facebook post and a TikTok fan-out.
   */
  async function publish(
    auth: Record<string, string>,
    platforms: Array<"facebook" | "instagram" | "tiktok">,
  ): Promise<string> {
    const needsMedia = platforms.some((platform) => platform !== "facebook");
    let mediaId: string | undefined;
    if (needsMedia) {
      const upload = await app.inject({
        method: "POST",
        url: "/api/media",
        headers: { ...auth, "content-type": "video/mp4" },
        payload: Buffer.from("fake-bytes"),
      });
      expect(upload.statusCode).toBe(201);
      mediaId = upload.json().id as string;
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/posts",
      headers: auth,
      payload: {
        text: "hello",
        platforms,
        ...(mediaId ? { media: { mediaId } } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().post.id as string;
  }

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

  /* ----------------------------------------------------------------- Range */

  describe("the window every number is cut to", () => {
    it("defaults to the last 30 days, ending today in the Client's timezone", async () => {
      const { auth } = await client();
      const body = getBody(await getAnalytics(auth));
      expect(body.range).toEqual({ days: 30, from: "2026-06-21", to: "2026-07-20" });
    });

    it("honours the days a request asks for, and clamps nonsense back to something sane", async () => {
      const { auth } = await client();
      expect(getBody(await getAnalytics(auth, 7)).range).toEqual({
        days: 7,
        from: "2026-07-14",
        to: "2026-07-20",
      });
      // Beyond the ceiling, and below the floor — neither is worth a 400 over.
      expect(getBody(await getAnalytics(auth, 5000)).range.days).toBe(365);
      expect(getBody(await getAnalytics(auth, 0)).range.days).toBe(30);
    });

    it("cuts the account trend to the window without dropping the account", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);

      publisher.scriptAccountMetrics("facebook", { followers: 100 });
      await runJob();
      clock.advance(10 * DAY_MS);
      publisher.scriptAccountMetrics("facebook", { followers: 400 });
      await runJob();

      // A 7-day window ending on the 30th excludes the point on the 20th.
      const narrow = getBody(await getAnalytics(auth, 7));
      expect(seriesFor(narrow, "facebook")?.series.map((p) => p.date)).toEqual(["2026-07-30"]);

      const wide = getBody(await getAnalytics(auth, 30));
      expect(seriesFor(wide, "facebook")?.series.map((p) => p.date)).toEqual([
        "2026-07-20",
        "2026-07-30",
      ]);

      // An account whose every snapshot falls outside the window is still listed,
      // with an empty series — the dashboard renders it rather than losing it.
      clock.advance(2 * DAY_MS);
      const beyond = getBody(await getAnalytics(auth, 1));
      expect(beyond.range).toEqual({ days: 1, from: "2026-08-01", to: "2026-08-01" });
      expect(seriesFor(beyond, "facebook")).toMatchObject({ series: [] });
    });
  });

  /* ------------------------------------------------------------- Publishing */

  describe("what the Client published", () => {
    it("counts a delivery per Target, on the day it landed, in the Client's timezone", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook", "tiktok"]);
      await publish(auth, ["facebook", "tiktok"]);

      const { posts } = getBody(await getAnalytics(auth, 7));
      const today = posts.daily.find((point) => point.date === "2026-07-20");
      // One Post, two platforms, two deliveries — the grain is the Target.
      expect(today).toEqual({ date: "2026-07-20", published: 2, failed: 0 });
      expect(posts.byPlatform).toEqual([
        { platform: "facebook", published: 1, failed: 0 },
        { platform: "tiktok", published: 1, failed: 0 },
      ]);
    });

    it("gives every day in the window a point, so a quiet day is a zero and not a gap", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);
      await publish(auth, ["facebook"]);

      const { posts, range } = getBody(await getAnalytics(auth, 7));
      expect(posts.daily).toHaveLength(7);
      expect(posts.daily[0]!.date).toBe(range.from);
      expect(posts.daily[6]!.date).toBe(range.to);
      expect(posts.daily.slice(0, 6).every((point) => point.published === 0)).toBe(true);
      expect(posts.daily[6]).toEqual({ date: "2026-07-20", published: 1, failed: 0 });
    });

    it("counts a failed Target as a failure, and keeps its sibling's success", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook", "tiktok"]);
      publisher.scriptFailure("tiktok", "TikTok rejected the video.");
      await publish(auth, ["facebook", "tiktok"]);

      // A first failure is not yet a failure: the Target is pending its two
      // automatic retries, so the dashboard counts Facebook's delivery and waits.
      const midFlight = getBody(await getAnalytics(auth, 7)).posts;
      expect(midFlight.byPlatform).toEqual([{ platform: "facebook", published: 1, failed: 0 }]);

      // Once the automatic chain gives up, TikTok is terminally failed.
      const { mediaDir, tokenCipher } = app.deps;
      clock.advance(60_000);
      await retryDueTargets(db.pool, clock, publisher, tokenCipher, mediaDir);
      clock.advance(60_000);
      await retryDueTargets(db.pool, clock, publisher, tokenCipher, mediaDir);

      const { posts } = getBody(await getAnalytics(auth, 7));
      expect(posts.byPlatform).toEqual([
        { platform: "facebook", published: 1, failed: 0 },
        { platform: "tiktok", published: 0, failed: 1 },
      ]);
      // The Post itself is partially published — a success is never rolled back
      // because a sibling failed.
      expect(posts.posts.partially_published).toBe(1);
      expect(posts.posts.published).toBe(0);
    });

    it("reports what is still waiting, regardless of the window", async () => {
      const { auth } = await client();
      await connectPlatforms(auth, ["facebook"]);

      await app.inject({
        method: "POST",
        url: "/api/posts",
        headers: auth,
        payload: { text: "later", platforms: ["facebook"], scheduledAt: "2026-09-01T10:00:00.000Z" },
      });
      await app.inject({
        method: "POST",
        url: "/api/posts",
        headers: auth,
        payload: { text: "someday", platforms: [], draft: true },
      });

      // A 7-day window cannot contain a Post scheduled six weeks out, and the
      // dashboard still has to say it is coming.
      const { posts } = getBody(await getAnalytics(auth, 7));
      expect(posts.upcoming).toEqual({
        scheduled: 1,
        drafts: 1,
        nextScheduledAt: "2026-09-01T10:00:00.000Z",
      });
    });

    it("never shows one Client another Client's publishing", async () => {
      const acme = await client("acme");
      const globex = await client("globex");
      await connectPlatforms(acme.auth, ["facebook"]);
      await publish(acme.auth, ["facebook"]);

      const { posts } = getBody(await getAnalytics(globex.auth, 7));
      expect(posts.byPlatform).toEqual([]);
      expect(posts.daily.every((point) => point.published === 0)).toBe(true);
      expect(posts.upcoming.scheduled).toBe(0);
    });
  });
});

function getBody(res: { json(): unknown }): Dashboard {
  return res.json() as Dashboard;
}
