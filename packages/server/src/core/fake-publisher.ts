import {
  type Platform,
  type PublishRequest,
  type PublishResult,
  type Publisher,
} from "./publisher.js";

/**
 * The one fake in the behavioral test suite (per the PRD's Testing Decisions).
 *
 * It records every {@link PublishRequest} it receives ("what would be sent") and
 * is scripted per platform to succeed or fail. This makes fan-out, independent
 * per-Target outcomes, retries, and status roll-ups deterministic with zero real
 * API calls. Later slices assert against {@link sent} and script outcomes with
 * {@link scriptSuccess} / {@link scriptFailure}.
 */
export class FakePublisher implements Publisher {
  /** Every request passed to {@link publish}, in call order. */
  readonly sent: PublishRequest[] = [];

  private readonly scripts = new Map<Platform, () => PublishResult>();

  /** Default outcome for platforms that have not been explicitly scripted. */
  private defaultResult: () => PublishResult = () => ({
    ok: true,
    externalId: "fake-external-id",
    permalink: "https://example.test/p/fake-external-id",
  });

  /** Script a platform to succeed, optionally with a specific external id. */
  scriptSuccess(platform: Platform, externalId?: string, permalink?: string): this {
    this.scripts.set(platform, () => ({
      ok: true,
      externalId: externalId ?? `fake-${platform}-id`,
      permalink: permalink ?? `https://example.test/${platform}/${externalId ?? "id"}`,
    }));
    return this;
  }

  /** Script a platform to fail with a given error message. */
  scriptFailure(platform: Platform, error: string): this {
    this.scripts.set(platform, () => ({ ok: false, error }));
    return this;
  }

  /** Requests recorded for a single platform. */
  sentTo(platform: Platform): PublishRequest[] {
    return this.sent.filter((r) => r.platform === platform);
  }

  /** Forget all recorded requests and scripts. */
  reset(): void {
    this.sent.length = 0;
    this.scripts.clear();
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    this.sent.push({ ...request });
    const script = this.scripts.get(request.platform) ?? this.defaultResult;
    return script();
  }
}
