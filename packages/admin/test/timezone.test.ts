import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createUser } from "@smma/core";
import { buildTestAdminApp, loginAs } from "./helpers/app.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { buildTestClientApp, clientHost } from "./helpers/client-app.js";
import { connectPlatforms, schedulePost, type ClientAuth } from "./helpers/scheduled-posts.js";
import { TestClock } from "../src/clock.js";
import { upsertSuperadmin } from "../src/auth/superadmins.js";
// Development-only, as in the Plan suite: the claim that a timezone change does
// not move a Scheduled Post is only provable by letting the Client-facing
// service's tick fire it, and seeing it fire at the same absolute instant.
import { FakePublisher } from "../../server/src/core/fake-publisher.js";
import { publishDuePosts } from "../../server/src/posts/scheduling.js";

/**
 * Correcting a Client's timezone, and the shift preview that has to precede it.
 *
 * The sharp edge this suite exists for: a Scheduled Post is stored as a UTC
 * instant and *displayed* in the Client's timezone, so changing the timezone
 * does not move a single Post — it changes what time each one appears to fire.
 * A Post its author scheduled for 9am simply becomes a 10pm Post. Nothing else
 * on the platform makes work change meaning without changing, which is why the
 * preview lists every affected Post's time on both sides rather than counting
 * them, and why the last test here fires a Post through the real scheduler to
 * show the instant did not budge.
 *
 * The subdomain is the other half of the story and is proved by absence: there
 * is no route that changes one, because renaming it would break every bookmark
 * and link the Client already has.
 */

const EMAIL = "operator@ourapp.test";
const PASSWORD = "correct horse battery";
const USER_PASSWORD = "their own password";
const NOW = new Date("2026-08-04T09:00:00.000Z");
/** 9am in New York, 10pm in Tokyo — the same instant, read two ways. */
const MORNING = new Date("2026-08-04T13:00:00.000Z");
/** Late enough in New York that Tokyo has it on the following day. */
const LATE = new Date("2026-08-05T02:30:00.000Z");

describe("A Client's timezone in the admin panel", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  let clientApp: FastifyInstance;
  let cookies: InjectOptions["cookies"];
  const clock = new TestClock(NOW);
  const publisher = new FakePublisher();

  beforeAll(async () => {
    db = await startTestPostgres({ clientSchema: true });
    app = buildTestAdminApp({ pool: db.pool, clock });
    clientApp = buildTestClientApp({ pool: db.pool, clock, publisher });
    await Promise.all([app.ready(), clientApp.ready()]);
  });

  afterAll(async () => {
    await Promise.all([app.close(), clientApp.close()]);
    await db.stop();
  });

  beforeEach(async () => {
    clock.set(NOW);
    publisher.reset();
    await db.pool.query("TRUNCATE superadmins, admin_sessions RESTART IDENTITY CASCADE");
    await db.pool.query(
      "TRUNCATE clients, users, sessions, connected_accounts, oauth_states, posts, media RESTART IDENTITY CASCADE",
    );
    await upsertSuperadmin(db.pool, { email: EMAIL, password: PASSWORD });
    ({ cookies } = await loginAs(app, { email: EMAIL, password: PASSWORD }));
  });

  /* ------------------------------------------------------------ the panel */

  const setTimezone = (clientId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/timezone`,
      payload: body,
      cookies,
    });

  const previewShift = (clientId: string, timezone: string) =>
    app.inject({
      method: "GET",
      url: `/api/clients/${clientId}/timezone-shift?timezone=${encodeURIComponent(timezone)}`,
      cookies,
    });

  const getClient = (clientId: string) =>
    app.inject({ method: "GET", url: `/api/clients/${clientId}`, cookies });

  /** Provision a Client through the panel, anchored to New York. */
  async function client(subdomain = "acme"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      payload: {
        subdomain,
        timezone: "America/New_York",
        plan: { facebook: true, instagram: true, tiktok: true },
      },
      cookies,
    });
    if (res.statusCode !== 201) throw new Error(`Provisioning failed: ${res.body}`);
    return res.json().client.id as string;
  }

  /* ---------------------------------------------------- the Client's side */

  /** This Client's User. Emails are unique platform-wide, so each Client gets its own. */
  const userEmail = (subdomain: string) => `user@${subdomain}.test`;

  const clientLogin = (subdomain: string) =>
    clientApp.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: clientHost(subdomain) },
      payload: { email: userEmail(subdomain), password: USER_PASSWORD },
    });

  /** Add a User to a Client and log them in on their own subdomain. */
  async function userOf(clientId: string, subdomain: string): Promise<ClientAuth> {
    await createUser(db.pool, {
      clientId,
      email: userEmail(subdomain),
      password: USER_PASSWORD,
    });
    const res = await clientLogin(subdomain);
    if (res.statusCode !== 200) throw new Error(`Login failed: ${res.body}`);
    return {
      host: clientHost(subdomain),
      authorization: `Bearer ${res.json().token as string}`,
    };
  }

  /** The timezone the Client's own SPA is handed when a User signs in. */
  async function timezoneOnClientSurface(subdomain: string): Promise<string> {
    return (await clientLogin(subdomain)).json().client.timezone as string;
  }

  const tick = () =>
    publishDuePosts(db.pool, clock, publisher, clientApp.deps.tokenCipher, clientApp.deps.mediaDir);

  /** A Client with a live User and Facebook connected — ready to schedule. */
  async function readyToSchedule(subdomain = "acme") {
    const clientId = await client(subdomain);
    const auth = await userOf(clientId, subdomain);
    await connectPlatforms(clientApp, publisher, auth, ["facebook"]);
    return { clientId, auth };
  }

  /* ------------------------------------------------------ Changing it */

  describe("Changing the timezone", () => {
    it("corrects a timezone chosen wrongly at provisioning, all the way to the Client's own surface", async () => {
      const clientId = await client();
      await userOf(clientId, "acme");

      const res = await setTimezone(clientId, { timezone: "Asia/Tokyo" });

      expect(res.statusCode).toBe(200);
      expect(res.json().client).toMatchObject({ subdomain: "acme", timezone: "Asia/Tokyo" });
      expect((await getClient(clientId)).json().client.timezone).toBe("Asia/Tokyo");
      // The Client's own SPA anchors its composing and its analytics to this.
      expect(await timezoneOnClientSurface("acme")).toBe("Asia/Tokyo");
    });

    it("refuses a timezone that is not a real one, leaving the Client anchored where it was", async () => {
      const clientId = await client();

      const res = await setTimezone(clientId, { timezone: "America/Nowhere" });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_timezone");
      expect((await getClient(clientId)).json().client.timezone).toBe("America/New_York");
    });

    it("refuses a body with no timezone in it at all", async () => {
      const clientId = await client();

      const res = await setTimezone(clientId, {});

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_body");
    });

    it("answers 404 for a Client that does not exist", async () => {
      const res = await setTimezone("00000000-0000-0000-0000-000000000000", {
        timezone: "Asia/Tokyo",
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("client_not_found");
    });

    /**
     * The subdomain is the Client's URL — it lives in bookmarks and in its
     * Users' habits, and renaming it silently breaks every existing link. A
     * wrong one is fixed by provisioning again, so no route accepts a new one
     * and the one route that edits a Client at all ignores it.
     */
    it("cannot be used to rename the subdomain", async () => {
      const clientId = await client();

      const smuggled = await setTimezone(clientId, {
        timezone: "Asia/Tokyo",
        subdomain: "globex",
      });
      expect(smuggled.statusCode).toBe(200);
      expect(smuggled.json().client.subdomain).toBe("acme");

      // And there is no route of its own for it.
      const direct = await app.inject({
        method: "PATCH",
        url: `/api/clients/${clientId}`,
        payload: { subdomain: "globex" },
        cookies,
      });
      expect(direct.statusCode).toBe(404);

      expect((await getClient(clientId)).json().client.subdomain).toBe("acme");
    });
  });

  /* ------------------------------------------------------- The shift preview */

  describe("The shift preview", () => {
    it("states each Scheduled Post's displayed time before and after, rather than counting them", async () => {
      const { clientId, auth } = await readyToSchedule();
      const morning = await schedulePost(clientApp, auth, {
        platforms: ["facebook"],
        scheduledAt: MORNING,
      });
      const late = await schedulePost(clientApp, auth, {
        platforms: ["facebook"],
        scheduledAt: LATE,
      });

      const res = await previewShift(clientId, "Asia/Tokyo");

      expect(res.statusCode).toBe(200);
      expect(res.json().shift).toEqual({
        from: "America/New_York",
        to: "Asia/Tokyo",
        posts: [
          {
            id: morning,
            scheduledAt: MORNING.toISOString(),
            before: "Aug 4, 2026, 9:00 AM",
            after: "Aug 4, 2026, 10:00 PM",
          },
          {
            id: late,
            scheduledAt: LATE.toISOString(),
            before: "Aug 4, 2026, 10:30 PM",
            // The same instant, on the next day — a shift a count could never
            // have shown the operator.
            after: "Aug 5, 2026, 11:30 AM",
          },
        ],
      });
    });

    it("covers only this Client's Posts, and only the ones still scheduled", async () => {
      const { clientId, auth } = await readyToSchedule();
      const theirs = await readyToSchedule("globex");
      await schedulePost(clientApp, theirs.auth, {
        platforms: ["facebook"],
        scheduledAt: MORNING,
      });

      // A Draft has no time to shift.
      await clientApp.inject({
        method: "POST",
        url: "/api/posts",
        headers: auth,
        payload: { text: "later", platforms: ["facebook"], draft: true },
      });
      // And one that has already fired is beyond the reach of anything now.
      publisher.scriptSuccess("facebook", "fb-1");
      await schedulePost(clientApp, auth, {
        platforms: ["facebook"],
        scheduledAt: new Date(NOW.getTime() + 30 * 60 * 1000),
      });
      clock.advance(30 * 60 * 1000);
      expect(await tick()).toMatchObject({ fired: 1 });

      const mine = await schedulePost(clientApp, auth, {
        platforms: ["facebook"],
        scheduledAt: LATE,
      });

      const res = await previewShift(clientId, "Asia/Tokyo");

      expect(res.json().shift.posts.map((post: { id: string }) => post.id)).toEqual([mine]);
    });

    it("says nothing shifts when the Client has nothing scheduled", async () => {
      const clientId = await client();

      const res = await previewShift(clientId, "Asia/Tokyo");

      expect(res.json().shift).toEqual({
        from: "America/New_York",
        to: "Asia/Tokyo",
        posts: [],
      });
    });

    it("refuses to preview a timezone that is not a real one", async () => {
      const clientId = await client();

      const res = await previewShift(clientId, "America/Nowhere");

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_timezone");
    });

    it("refuses to preview without being told which timezone", async () => {
      const clientId = await client();

      const res = await app.inject({
        method: "GET",
        url: `/api/clients/${clientId}/timezone-shift`,
        cookies,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_body");
    });

    /**
     * The API half of "cancelling leaves the timezone unchanged": the preview is
     * a read, so cancelling is simply never sending the patch, and there is no
     * half-committed state for it to leave behind.
     *
     * The panel's Cancel button itself is not covered here — this repo has no
     * DOM-rendering seam, and PRD #15 was explicit that this work adds no new
     * *kinds* of seam, so that half is the manual step in the `verify` skill.
     */
    it("changes nothing however many times it is asked", async () => {
      const { clientId, auth } = await readyToSchedule();
      await schedulePost(clientApp, auth, { platforms: ["facebook"], scheduledAt: MORNING });

      const first = await previewShift(clientId, "Asia/Tokyo");
      const second = await previewShift(clientId, "Asia/Tokyo");

      expect(second.json()).toEqual(first.json());
      expect((await getClient(clientId)).json().client.timezone).toBe("America/New_York");
      expect(await timezoneOnClientSurface("acme")).toBe("America/New_York");
    });

    it("answers 404 for a Client that does not exist", async () => {
      const res = await previewShift("00000000-0000-0000-0000-000000000000", "Asia/Tokyo");

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("client_not_found");
    });
  });

  /* ------------------------------------------- What a change does not do */

  it("does not move a Scheduled Post: it fires at the same instant, wearing a different time", async () => {
    const { clientId, auth } = await readyToSchedule();
    const postId = await schedulePost(clientApp, auth, {
      platforms: ["facebook"],
      scheduledAt: MORNING,
    });
    publisher.scriptSuccess("facebook", "fb-1");

    const before = await previewShift(clientId, "Asia/Tokyo");
    await setTimezone(clientId, { timezone: "Asia/Tokyo" });

    // The stored instant is what the scheduler works from, and it did not move.
    const { rows } = await db.pool.query<{ scheduled_at: Date }>(
      "SELECT scheduled_at FROM posts WHERE id = $1",
      [postId],
    );
    expect(rows[0]!.scheduled_at.toISOString()).toBe(MORNING.toISOString());

    // A minute before the original instant nothing is due — the change did not
    // pull the Post forward.
    clock.set(new Date(MORNING.getTime() - 60_000));
    expect(await tick()).toMatchObject({ due: 0, fired: 0 });
    expect(publisher.sent).toHaveLength(0);

    // And at the instant itself it fires, exactly as it would have.
    clock.set(MORNING);
    expect(await tick()).toMatchObject({ due: 1, fired: 1 });
    expect(publisher.sentTo("facebook")).toHaveLength(1);

    // What changed is only what the time reads as — which is what the operator
    // was shown before they confirmed.
    expect(before.json().shift.posts[0]).toMatchObject({
      before: "Aug 4, 2026, 9:00 AM",
      after: "Aug 4, 2026, 10:00 PM",
    });
  });

  /* --------------------------------------------------------- The front door */

  it("rejects both of these routes for a request with no session", async () => {
    const clientId = await client();

    const unauthenticated = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/clients/${clientId}/timezone`,
        payload: { timezone: "Asia/Tokyo" },
      }),
      app.inject({
        method: "GET",
        url: `/api/clients/${clientId}/timezone-shift?timezone=Asia/Tokyo`,
      }),
    ]);

    for (const res of unauthenticated) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }

    expect((await getClient(clientId)).json().client.timezone).toBe("America/New_York");
  });
});
