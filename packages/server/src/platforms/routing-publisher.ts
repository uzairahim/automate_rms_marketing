import {
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
} from "../core/publisher.js";

/**
 * One {@link Publisher} over several per-platform transports (ADR 0002's "one
 * implementation per platform", now that Slice 7 has made that literal).
 *
 * Every caller still holds a single Publisher and names the platform in the
 * request, exactly as before — this is what keeps "which transport" from becoming
 * a question domain code has to answer, and what lets a whole platform be swapped
 * for an aggregator or the ADR 0008 path in one line of {@link resolvePublisher}.
 *
 * The two Meta platforms deliberately share one transport instance: on Meta's
 * side a Facebook Page and its Instagram Business account are one app, one token,
 * and one revocation (ADR 0005).
 */
export class RoutingPublisher implements Publisher {
  constructor(private readonly transports: Record<Platform, Publisher>) {}

  publish(request: PublishRequest): Promise<PublishResult> {
    return this.for(request.platform).publish(request);
  }

  authorizeUrl(request: AuthorizeRequest): string {
    return this.for(request.platform).authorizeUrl(request);
  }

  exchangeCode(request: ExchangeRequest): Promise<PlatformCredential> {
    return this.for(request.platform).exchangeCode(request);
  }

  refreshCredential(request: RefreshRequest): Promise<PlatformCredential> {
    return this.for(request.platform).refreshCredential(request);
  }

  // The three platform-specific lookups name their platform in the method rather
  // than in a request, so they route by that name. There is nothing to decide.
  listFacebookPages(credential: PlatformCredential): Promise<FacebookPage[]> {
    return this.for("facebook").listFacebookPages(credential);
  }

  listInstagramAccounts(
    credential: PlatformCredential,
    pageId: string,
  ): Promise<InstagramAccount[]> {
    return this.for("instagram").listInstagramAccounts(credential, pageId);
  }

  fetchTikTokAccount(credential: PlatformCredential): Promise<TikTokAccount> {
    return this.for("tiktok").fetchTikTokAccount(credential);
  }

  fetchThumbnail(request: PostReadRequest): Promise<string | null> {
    return this.for(request.platform).fetchThumbnail(request);
  }

  fetchPostMetrics(request: PostReadRequest): Promise<PostMetrics> {
    return this.for(request.platform).fetchPostMetrics(request);
  }

  fetchAccountMetrics(request: AccountMetricsRequest): Promise<AccountMetrics> {
    return this.for(request.platform).fetchAccountMetrics(request);
  }

  private for(platform: Platform): Publisher {
    return this.transports[platform];
  }
}
