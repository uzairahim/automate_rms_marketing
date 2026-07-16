import {
  PublisherError,
  type AuthorizeRequest,
  type ExchangeRequest,
  type FacebookPage,
  type Platform,
  type PlatformCredential,
  type PublishRequest,
  type PublishResult,
  type Publisher,
  type RefreshRequest,
} from "./publisher.js";

/**
 * The one fake in the behavioral test suite (per the PRD's Testing Decisions).
 *
 * It records every {@link PublishRequest} it receives ("what would be sent") and
 * is scripted per platform to succeed or fail. This makes fan-out, independent
 * per-Target outcomes, retries, and status roll-ups deterministic with zero real
 * API calls. Later slices assert against {@link sent} and script outcomes with
 * {@link scriptSuccess} / {@link scriptFailure}.
 *
 * It fakes the connection lifecycle the same way (Slice 6): {@link scriptPages}
 * decides what `pages_show_list` returns — which is how a test puts a User in
 * the zero-Page dead-end or the must-choose-between-many case (ADR 0005) — and
 * {@link scriptRefreshFailure} drives the token-refresh job's failure path.
 */
export class FakePublisher implements Publisher {
  /** Every request passed to {@link publish}, in call order. */
  readonly sent: PublishRequest[] = [];

  /** Every credential passed to {@link refreshCredential}, in call order. */
  readonly refreshed: PlatformCredential[] = [];

  /** Every full {@link RefreshRequest}, for asserting on what the job asked for. */
  readonly refreshRequests: RefreshRequest[] = [];

  private readonly scripts = new Map<Platform, () => PublishResult>();

  /** What `pages_show_list` returns. Default: a single Page. */
  private pages: FacebookPage[] = [fakePage("page-1", "Test Page")];

  private exchangeError: string | null = null;
  private refreshError: string | null = null;
  private pagesError: string | null = null;
  /** Refresh errors scripted against a specific token, for per-account outcomes. */
  private readonly refreshErrorsByToken = new Map<string, string>();
  private refreshedExpiry: Date | undefined;

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

  /**
   * Script what `pages_show_list` returns. Pass no pages for the zero-Page
   * dead-end, or several to force an explicit choice (ADR 0005).
   */
  scriptPages(...pages: Array<FacebookPage | { id: string; name: string }>): this {
    this.pages = pages.map((page) =>
      "credential" in page ? page : fakePage(page.id, page.name),
    );
    return this;
  }

  /** Script the OAuth code exchange to be rejected by the platform. */
  scriptExchangeFailure(error: string): this {
    this.exchangeError = error;
    return this;
  }

  /** Script `pages_show_list` to be rejected by the platform. */
  scriptPagesFailure(error: string): this {
    this.pagesError = error;
    return this;
  }

  /** Script the token refresh to be refused — the job's `token_expired` path. */
  scriptRefreshFailure(error: string): this {
    this.refreshError = error;
    return this;
  }

  /**
   * Script the refresh to be refused for one specific token. Lets a test give
   * two accounts different outcomes in a single run of the refresh job.
   */
  scriptRefreshFailureFor(accessToken: string, error: string): this {
    this.refreshErrorsByToken.set(accessToken, error);
    return this;
  }

  /** Script the expiry the platform reports on a successfully refreshed token. */
  scriptRefreshedExpiry(expiresAt: Date): this {
    this.refreshedExpiry = expiresAt;
    return this;
  }

  /** Forget all recorded requests and scripts. */
  reset(): void {
    this.sent.length = 0;
    this.refreshed.length = 0;
    this.refreshRequests.length = 0;
    this.scripts.clear();
    this.pages = [fakePage("page-1", "Test Page")];
    this.exchangeError = null;
    this.refreshError = null;
    this.pagesError = null;
    this.refreshErrorsByToken.clear();
    this.refreshedExpiry = undefined;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    this.sent.push({ ...request });
    const script = this.scripts.get(request.platform) ?? this.defaultResult;
    return script();
  }

  authorizeUrl(request: AuthorizeRequest): string {
    const params = new URLSearchParams({
      state: request.state,
      redirect_uri: request.redirectUri,
    });
    return `https://example.test/${request.platform}/oauth?${params.toString()}`;
  }

  async exchangeCode(request: ExchangeRequest): Promise<PlatformCredential> {
    if (this.exchangeError) {
      throw new PublisherError(request.platform, this.exchangeError);
    }
    return {
      accessToken: `fake-user-token-for-${request.code}`,
      refreshable: true,
      platformUserId: FAKE_PLATFORM_USER_ID,
    };
  }

  async listFacebookPages(): Promise<FacebookPage[]> {
    if (this.pagesError) {
      throw new PublisherError("facebook", this.pagesError);
    }
    return this.pages.map((page) => ({ ...page }));
  }

  async refreshCredential(request: RefreshRequest): Promise<PlatformCredential> {
    const { credential } = request;
    this.refreshed.push({ ...credential });
    this.refreshRequests.push({ ...request });
    const error = this.refreshErrorsByToken.get(credential.accessToken) ?? this.refreshError;
    if (error) {
      throw new PublisherError(request.platform, error);
    }
    return {
      ...credential,
      accessToken: `${credential.accessToken}-refreshed`,
      expiresAt: this.refreshedExpiry ?? credential.expiresAt,
    };
  }
}

/** The Meta user id the fake's credentials belong to — what a deauth names. */
export const FAKE_PLATFORM_USER_ID = "fake-meta-user";

function fakePage(id: string, name: string): FacebookPage {
  return {
    id,
    name,
    credential: {
      accessToken: `fake-page-token-${id}`,
      refreshable: true,
      platformUserId: FAKE_PLATFORM_USER_ID,
      // Mirrors the real transport: a Page token is derived from a user token,
      // and only that parent can be extended later.
      parentToken: "fake-user-token",
    },
  };
}
