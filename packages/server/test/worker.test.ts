import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { buildTestApp } from "./helpers/app.js";
import { TestClock } from "../src/core/clock.js";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { FakeEmailSender } from "../src/core/fake-email.js";
import { startHealthWorker } from "../src/worker/health-worker.js";
import {
  HEALTH_QUEUE_NAME,
  type HealthJobData,
} from "../src/queue/health-queue.js";
import { startTestPostgres, type TestPostgres } from "./helpers/postgres.js";
import { startTestRedis, type TestRedis } from "./helpers/redis.js";

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("Health job round-trip (BullMQ worker end-to-end)", () => {
  let db: TestPostgres;
  let redis: TestRedis;
  let queue: Queue<HealthJobData>;
  let worker: ReturnType<typeof startHealthWorker>;
  let app: FastifyInstance;

  beforeAll(async () => {
    [db, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
    queue = new Queue<HealthJobData>(HEALTH_QUEUE_NAME, { connection: redis.connection });
    worker = startHealthWorker(db.pool, redis.connection);
    await worker.waitUntilReady();
    app = buildTestApp({
      pool: db.pool,
      clock: new TestClock(),
      publisher: new FakePublisher(),
      emailSender: new FakeEmailSender(),
      baseDomain: "localhost",
      superadminToken: "test-superadmin-token",
      healthQueue: queue,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await worker.close();
    await queue.close();
    await db.stop();
    await redis.stop();
  });

  it("processes a job enqueued directly and records it in job_runs", async () => {
    await queue.add("health", { note: "direct-enqueue" });
    const row = await waitFor(async () => {
      const res = await db.pool.query(
        "SELECT payload FROM job_runs WHERE payload->>'note' = 'direct-enqueue'",
      );
      return res.rows[0];
    });
    expect(row.payload).toEqual({ note: "direct-enqueue" });
  });

  it("processes a job enqueued via the API endpoint end-to-end", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/health/enqueue",
      payload: { note: "via-api" },
    });
    expect(response.statusCode).toBe(202);

    const row = await waitFor(async () => {
      const res = await db.pool.query(
        "SELECT job_name, payload FROM job_runs WHERE payload->>'note' = 'via-api'",
      );
      return res.rows[0];
    });
    expect(row.job_name).toBe("health");
    expect(row.payload).toEqual({ note: "via-api" });
  });
});
