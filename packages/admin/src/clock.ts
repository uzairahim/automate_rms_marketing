/**
 * Clock abstraction — the admin service's single injected source of "now".
 *
 * Session expiry reads time through this rather than calling `new Date()`, so a
 * test can prove a session dies without waiting eight hours for it.
 *
 * It is deliberately the admin service's own rather than something imported: the
 * Clock is a *seam*, and `@smma/core` is what the two deployables share about
 * the domain, not about how each of them is wired (ADR 0010). The two copies
 * cannot drift into disagreement, because neither reads the other's state.
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

/** Deterministic clock for tests. Time only moves when the test moves it. */
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
