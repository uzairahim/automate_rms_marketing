import {
  PublisherError,
  type AccountMetrics,
  type AccountMetricsRequest,
  type AuthorizeRequest,
  type ExchangeRequest,
  type FacebookPage,
  type InstagramAccount,
  type Platform,
  type PlatformCredential,
  type PostMetrics,
  type PostReadRequest,
  type PublishRequest,
  type PublishResult,
  type Publisher,
  type RefreshRequest,
  type TikTokAccount,
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
 *
 * Instagram is scripted through {@link scriptPages} too (Slice 7), by giving a
 * Page an `instagram` account: a test never states an IG account independently of
 * a Page, because the platform will not let one exist that way (ADR 0005). A Page
 * scripted without one *is* the convert-to-Business dead-end.
 */
export class FakePublisher implements Publisher {
  /** Every request passed to {@link publish}, in call order. */
  readonly sent: PublishRequest[] = [];

  /** Every credential passed to {@link refreshCredential}, in call order. */
  readonly refreshed: PlatformCredential[] = [];

  /** Every full {@link RefreshRequest}, for asserting on what the job asked for. */
  readonly refreshRequests: RefreshRequest[] = [];

  /** Every {@link fetchThumbnail} request, in call order (proves a live re-fetch). */
  readonly thumbnailReads: PostReadRequest[] = [];

  /** Every {@link fetchPostMetrics} request, in call order. */
  readonly metricReads: PostReadRequest[] = [];

  /** Every {@link fetchAccountMetrics} request, in call order (the snapshot job's reads). */
  readonly accountMetricReads: AccountMetricsRequest[] = [];

  private readonly scripts = new Map<Platform, () => PublishResult>();

  /** Per-platform thumbnail outcome: a URL, `null` (none), or a thrown error. */
  private readonly thumbnailScripts = new Map<Platform, () => string | null>();

  /** Per-platform metrics outcome: numbers, or a thrown error. */
  private readonly metricsScripts = new Map<Platform, () => PostMetrics>();

  /** Per-platform account-metrics outcome: numbers, or a thrown error. */
  private readonly accountMetricsScripts = new Map<Platform, () => AccountMetrics>();

  /** What `pages_show_list` returns. Default: a single Page. */
  private pages: FacebookPage[] = [fakePage(DEFAULT_PAGE)];

  /** Who a TikTok credential turns out to belong to. Default: one test account. */
  private tikTokAccount: TikTokAccount = {
    id: "tiktok-open-id",
    displayName: "Test TikTok",
  };

  private exchangeError: string | null = null;
  private refreshError: string | null = null;
  private pagesError: string | null = null;
  private instagramError: string | null = null;
  private tikTokAccountError: string | null = null;
  /** Refresh errors scripted against a specific token, for per-account outcomes. */
  private readonly refreshErrorsByToken = new Map<string, string>();
  private refreshedExpiry: Date | undefined;

  /** Default outcome for platforms that have not been explicitly scripted. */
  private defaultResult: () => PublishResult = () => ({
    ok: true,
    externalId: "fake-external-id",
    permalink: "https://example.test/p/fake-external-id",
  });

  /**
   * Default thumbnail for a published post nobody scripted: a per-post signed URL
   * derived from the stored id, so two different posts get two different URLs (a
   * test can tell them apart) and the value is plainly ephemeral, not persisted.
   */
  private defaultThumbnail: (request: PostReadRequest) => string | null = (request) =>
    `https://cdn.example.test/thumb/${request.platform}/${request.externalId}.jpg`;

  /** Default metrics for a published post nobody scripted. */
  private defaultMetrics: () => PostMetrics = () => ({
    likes: 10,
    comments: 2,
    shares: 1,
    views: 100,
  });

  /** Default account-level numbers for an account nobody scripted. */
  private defaultAccountMetrics: () => AccountMetrics = () => ({
    followers: 100,
    reach: 500,
    engagement: 30,
    postsPublished: 5,
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

  /** Script a platform to fail with a given error message (a transient refusal). */
  scriptFailure(platform: Platform, error: string): this {
    this.scripts.set(platform, () => ({ ok: false, error }));
    return this;
  }

  /**
   * Script a platform's publish to fail because the token is dead (ADR 0008) —
   * the terminal, `reason: "auth"` refusal the publish path must not retry and
   * that flips the Connected Account to `token_expired`.
   */
  scriptAuthFailure(platform: Platform, error: string): this {
    this.scripts.set(platform, () => ({ ok: false, error, reason: "auth" }));
    return this;
  }

  /** Requests recorded for a single platform. */
  sentTo(platform: Platform): PublishRequest[] {
    return this.sent.filter((r) => r.platform === platform);
  }

  /** Script the thumbnail a platform returns for a published post — a URL, or `null` for none. */
  scriptThumbnail(platform: Platform, url: string | null): this {
    this.thumbnailScripts.set(platform, () => url);
    return this;
  }

  /** Script the platform to refuse a thumbnail read (rate limit, deleted media). */
  scriptThumbnailFailure(platform: Platform, error: string): this {
    this.thumbnailScripts.set(platform, () => {
      throw new PublisherError(platform, error);
    });
    return this;
  }

  /** Script the per-post metrics a platform returns for a published post. */
  scriptMetrics(platform: Platform, metrics: PostMetrics): this {
    this.metricsScripts.set(platform, () => metrics);
    return this;
  }

  /** Script the platform to refuse a metrics read. */
  scriptMetricsFailure(platform: Platform, error: string): this {
    this.metricsScripts.set(platform, () => {
      throw new PublisherError(platform, error);
    });
    return this;
  }

  /** Script the account-level numbers a platform returns for the snapshot job. */
  scriptAccountMetrics(platform: Platform, metrics: AccountMetrics): this {
    this.accountMetricsScripts.set(platform, () => metrics);
    return this;
  }

  /** Script the platform to refuse an account-metrics read (throttled, down) — a transient refusal. */
  scriptAccountMetricsFailure(platform: Platform, error: string): this {
    this.accountMetricsScripts.set(platform, () => {
      throw new PublisherError(platform, error);
    });
    return this;
  }

  /**
   * Script an account-metrics read to fail because the token is dead (`reason:
   * "auth"`) — how the daily snapshot job discovers a hand-pasted token that can
   * no longer read, and surfaces the `token_expired` reconnect state (ADR 0008).
   */
  scriptAccountMetricsAuthFailure(platform: Platform, error: string): this {
    this.accountMetricsScripts.set(platform, () => {
      throw new PublisherError(platform, error, "auth");
    });
    return this;
  }

  /**
   * Script what `pages_show_list` returns. Pass no pages for the zero-Page
   * dead-end, or several to force an explicit choice (ADR 0005).
   *
   * A Page's `instagram` is the IG Business account linked to it — omit it and
   * that Page is the "no eligible Instagram account" dead-end.
   */
  scriptPages(...pages: Array<FacebookPage | PageSpec>): this {
    this.pages = pages.map((page) => ("credential" in page ? page : fakePage(page)));
    return this;
  }

  /** Script who a TikTok credential turns out to belong to. */
  scriptTikTokAccount(account: TikTokAccount): this {
    this.tikTokAccount = account;
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

  /** Script the Page's Instagram lookup to be rejected by the platform. */
  scriptInstagramFailure(error: string): this {
    this.instagramError = error;
    return this;
  }

  /** Script TikTok to refuse to say who a freshly-exchanged credential is. */
  scriptTikTokAccountFailure(error: string): this {
    this.tikTokAccountError = error;
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
    this.thumbnailReads.length = 0;
    this.metricReads.length = 0;
    this.accountMetricReads.length = 0;
    this.scripts.clear();
    this.thumbnailScripts.clear();
    this.metricsScripts.clear();
    this.accountMetricsScripts.clear();
    this.pages = [fakePage(DEFAULT_PAGE)];
    this.tikTokAccount = { id: "tiktok-open-id", displayName: "Test TikTok" };
    this.exchangeError = null;
    this.refreshError = null;
    this.pagesError = null;
    this.instagramError = null;
    this.tikTokAccountError = null;
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

  async listInstagramAccounts(
    _credential: PlatformCredential,
    pageId: string,
  ): Promise<InstagramAccount[]> {
    if (this.instagramError) {
      throw new PublisherError("instagram", this.instagramError);
    }
    // Mirrors the real transport: an IG account is only ever reachable *through*
    // a Page, so a Page nobody scripted has nothing to offer.
    const page = this.pages.find((candidate) => candidate.id === pageId);
    return page?.instagram ? [{ ...page.instagram }] : [];
  }

  async fetchTikTokAccount(): Promise<TikTokAccount> {
    if (this.tikTokAccountError) {
      throw new PublisherError("tiktok", this.tikTokAccountError);
    }
    return { ...this.tikTokAccount };
  }

  async fetchThumbnail(request: PostReadRequest): Promise<string | null> {
    this.thumbnailReads.push({ ...request });
    const script = this.thumbnailScripts.get(request.platform);
    return script ? script() : this.defaultThumbnail(request);
  }

  async fetchPostMetrics(request: PostReadRequest): Promise<PostMetrics> {
    this.metricReads.push({ ...request });
    const script = this.metricsScripts.get(request.platform) ?? this.defaultMetrics;
    return script();
  }

  async fetchAccountMetrics(request: AccountMetricsRequest): Promise<AccountMetrics> {
    this.accountMetricReads.push({ ...request });
    const script = this.accountMetricsScripts.get(request.platform) ?? this.defaultAccountMetrics;
    return script();
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

/** How a test states a Page, without spelling out tokens it does not care about. */
export interface PageSpec {
  id: string;
  name: string;
  /** The IG Business account linked to this Page. Omit for a Page with none. */
  instagram?: { id: string; username: string };
}

/**
 * The Page a fake with no script offers.
 *
 * It carries a linked Instagram account so that a local checkout with no Meta app
 * can click the *whole* connect flow through to a connected IG account — the
 * fake's reason for existing (see README). A test that wants the
 * no-eligible-account dead-end scripts a Page without one, which is clearer read
 * back than a default that quietly withholds it.
 */
const DEFAULT_PAGE: PageSpec = {
  id: "page-1",
  name: "Test Page",
  instagram: { id: "ig-1", username: "test.business" },
};

function fakePage(spec: PageSpec): FacebookPage {
  // Mirrors the real transport: a Page token is derived from a user token, and
  // only that parent can be extended later.
  const credential: PlatformCredential = {
    accessToken: `fake-page-token-${spec.id}`,
    refreshable: true,
    platformUserId: FAKE_PLATFORM_USER_ID,
    parentToken: "fake-user-token",
  };
  return {
    id: spec.id,
    name: spec.name,
    credential,
    // The IG account publishes with the Page's own token — it has none of its
    // own, exactly as on the real Graph API.
    instagram: spec.instagram && { ...spec.instagram, credential },
  };
}
