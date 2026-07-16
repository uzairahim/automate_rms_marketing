import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { FakeEmailSender } from "../src/core/fake-email.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";

describe("GET /api/health (API + Postgres seam)", () => {
  let db: TestPostgres;
  let app: FastifyInstance;
  const clock = new TestClock(new Date("2026-07-14T09:00:00.000Z"));

  beforeAll(async () => {
    db = await startTestPostgres();
    app = buildTestApp({
      pool: db.pool,
      clock,
      publisher: new FakePublisher(),
      emailSender: new FakeEmailSender(),
      baseDomain: "localhost",
      superadminToken: "test-superadmin-token",
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  it("reads the health value from Postgres and returns it", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      time: "2026-07-14T09:00:00.000Z",
    });
  });

  it("reflects the current DB state, not a constant", async () => {
    await db.pool.query("UPDATE health_check SET status = 'degraded' WHERE id = 1");
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.json().status).toBe("degraded");
    // restore for isolation from other assertions
    await db.pool.query("UPDATE health_check SET status = 'ok' WHERE id = 1");
  });

  it("uses the injected clock for the timestamp", async () => {
    clock.set(new Date("2026-12-25T00:00:00.000Z"));
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.json().time).toBe("2026-12-25T00:00:00.000Z");
  });
});
