import { describe, it, expect } from "vitest";
import { SystemClock, TestClock } from "../src/core/clock.js";

describe("TestClock", () => {
  it("stays fixed until moved", () => {
    const clock = new TestClock(new Date("2026-07-14T12:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-07-14T12:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-07-14T12:00:00.000Z");
  });

  it("advances by milliseconds", () => {
    const clock = new TestClock(new Date("2026-07-14T12:00:00.000Z"));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe("2026-07-14T12:01:00.000Z");
  });

  it("jumps to an absolute instant", () => {
    const clock = new TestClock();
    clock.set(new Date("2030-01-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("returns copies so callers cannot mutate internal time", () => {
    const clock = new TestClock(new Date("2026-07-14T12:00:00.000Z"));
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-07-14T12:00:00.000Z");
  });
});

describe("SystemClock", () => {
  it("returns real time near the actual now", () => {
    const before = Date.now();
    const value = new SystemClock().now().getTime();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});
