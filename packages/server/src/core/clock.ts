/**
 * Clock abstraction — the single injected source of "now" for the whole system.
 *
 * Every piece of time-dependent logic (the scheduler's due-query, the 60-minute
 * grace window, media-purge windows, token-expiry checks) reads time through a
 * Clock rather than calling `new Date()` directly. In production the wiring uses
 * {@link SystemClock}; tests swap in {@link TestClock} to control time without
 * real waiting. This is one of the three test seams established in Slice 1.
 */
export interface Clock {
  now(): Date;
}

/** Real wall-clock time. Used everywhere outside tests. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Deterministic clock for tests. Time only moves when the test moves it, so
 * grace-window / due / expiry logic can be exercised instantly.
 */
export class TestClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Jump to an absolute instant. */
  set(instant: Date): void {
    this.current = new Date(instant.getTime());
  }

  /** Move forward by a number of milliseconds. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
