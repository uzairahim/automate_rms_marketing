import { PLATFORMS, type Platform } from "@smma/core";

/**
 * Publisher interface (ADR 0002) — the single seam between our domain logic and
 * the platform APIs (Facebook, Instagram, TikTok).
 *
 * All publishing goes through this abstraction with one implementation per
 * platform transport, so a platform can be swapped (to an aggregator, or the
 * BYO-token path of ADR 0008) without touching domain code. In tests the real
 * transports are replaced by {@link FakePublisher}, which records what *would*
 * be sent and can be scripted to succeed or fail per platform — no real
 * Meta/TikTok calls ever occur in the behavioral suite.
 *
 * The seam covers a Connected Account's whole lifecycle, not just publishing:
 * authorizing (OAuth), discovering what the credential may publish to
 * (`pages_show_list`), refreshing before expiry, and finally publishing. They
 * are one interface because they are one relationship with one platform API —
 * and because the fallbacks ADR 0002 exists for (an aggregator, or ADR 0008's
 * BYO token) replace all of them together or none of them.
 */

/**
 * Which platforms exist is a fact about a Client's Plan before it is a fact
 * about publishing, so the list lives in `@smma/core` and is re-exported here
 * — one definition, reachable from whichever side of the domain a caller is on.
 */
export { PLATFORMS, type Platform };

/**
 * The platforms that are one Meta login: a Facebook Page, and the Instagram
 * Business account linked to it. They share a transport, a token, and a
 * revocation — a person who removes our app from their Facebook settings has
 * taken both away, whatever the two rows in our database say.
 */
export const META_PLATFORMS: readonly Platform[] = ["facebook", "instagram"];

/** What we ask a platform transport to publish for a single Target. */
export interface PublishRequest {
  platform: Platform;
  /** The Post's text/caption. */
  text: string;
  /** Public HTTPS URL of the attached Media, if any. */
  mediaUrl?: string;
  /**
   * Whether `mediaUrl` is an image or a video. Present whenever `mediaUrl` is.
   *
   * Carried rather than inferred because it cannot be inferred: a Media URL is
   * `{base}/api/media/{uuid}` with no extension, and the platforms need to be
   * told which they are getting — Facebook posts to a different edge for each,
   * and Instagram takes `image_url` or `video_url` on the container.
   */
  mediaType?: "image" | "video";
  /**
   * The Connected Account's credential — what authorizes this post. The same
   * shape a {@link PostReadRequest} carries, and for the same reason: a transport
   * has no database and no way to reach a token itself (ADR 0006 keeps
   * `openAccountCredential` the sole read path).
   */
  credential: PlatformCredential;
  /**
   * The destination's own id on the platform: the Facebook Page id, the
   * Instagram Business account id, or the TikTok `open_id`. Publishing is always
   * an act *of* a destination, so this is what the request is addressed to.
   */
  externalId: string;
}

/**
 * Why a platform refused, once we can tell the two apart.
 *
 * `auth` means the credential itself is dead — an expired/revoked token, or a
 * hand-pasted one that can no longer publish (ADR 0008). It will not fix itself
 * on a retry, so it is terminal: the Connected Account moves to `token_expired`
 * and the User must reconnect. `transient` is everything else — a throttle, a
 * brief outage — which a later attempt may well succeed at, so the ordinary
 * retry/skip behavior applies. Defaults to `transient` everywhere: only a caller
 * that can actually recognize a dead token upgrades a refusal to `auth`.
 */
export type PublisherFailureReason = "auth" | "transient";

/** The outcome of a single publish attempt for one Target. */
export type PublishResult =
  | {
      ok: true;
      /** The platform's durable post/media ID, persisted per Target on success. */
      externalId: string;
      /** Link to the live post on the platform, if the transport returns one. */
      permalink?: string;
    }
  | {
      ok: false;
      /** Human-readable reason, surfaced on the Target for a manual retry. */
      error: string;
      /**
       * Why it failed. `auth` (a dead token) is terminal — the publish path
       * skips the auto-retries and flips the Connected Account to
       * `token_expired`; absent or `transient` keeps the normal 2x retry.
       */
      reason?: PublisherFailureReason;
    };

/**
 * A platform credential in its usable, decrypted form. Always encrypted at rest
 * (ADR 0006) — this shape only ever exists in memory.
 *
 * ADR 0008: the slot accepts either an OAuth-obtained token or a manually-pasted
 * long-lived Page token, and both are consumed identically from here. A
 * manually-pasted token cannot auto-refresh, which is what `refreshable` records.
 */
export interface PlatformCredential {
  accessToken: string;
  /** When the token stops working, if the platform tells us. */
  expiresAt?: Date;
  /**
   * Whether {@link Publisher.refreshCredential} can extend this token. False for
   * a hand-pasted token (ADR 0008), which must be regenerated by a human.
   */
  refreshable: boolean;
  /**
   * The platform's id for the *authorizing person* (e.g. the Meta user id).
   * Not the Page id — this is what a deauthorization callback names.
   */
  platformUserId?: string;
  /**
   * The token this one was derived from, where the platform works that way.
   *
   * Meta is the reason this exists: we publish with a *Page* token, but Meta
   * will only ever extend the *user* token it was derived from — so refreshing
   * means re-extending the parent and re-deriving the Page token from it. Kept
   * on the credential because it is sealed and stored with it (ADR 0006), and is
   * useless to anything but a refresh.
   */
  parentToken?: string;
}

/** Where to send a User to authorize us against a platform. */
export interface AuthorizeRequest {
  platform: Platform;
  /** Opaque anti-forgery value round-tripped through the platform. */
  state: string;
  /** The callback URL the platform returns the User to. */
  redirectUri: string;
}

/** An OAuth callback's authorization code, to be traded for a credential. */
export interface ExchangeRequest {
  platform: Platform;
  code: string;
  redirectUri: string;
}

/** A credential to extend, and the destination it publishes to. */
export interface RefreshRequest {
  platform: Platform;
  credential: PlatformCredential;
  /**
   * The Connected Account's destination id (the Page id). Needed because a
   * transport may not be able to extend the credential in place: Meta re-derives
   * the Page token from the refreshed user token, and must be told which Page.
   */
  externalId: string;
}

/**
 * A Facebook Page the authorizing person manages, as returned by
 * `pages_show_list`. Per ADR 0005 this list *is* the enforcement: it contains
 * only Pages, never personal profiles, so an empty list is a genuine dead-end
 * rather than something to work around.
 */
export interface FacebookPage {
  /** The Page id. Publishing always targets this, never a personal profile id. */
  id: string;
  name: string;
  /** The Page access token — what we actually publish with, not the user token. */
  credential: PlatformCredential;
  /**
   * The Instagram Business/Creator account linked to this Page, if it has one.
   *
   * Carried here because refreshing an Instagram credential is the only way to
   * find out which Page a given IG account still hangs off: the refresh re-derives
   * Page tokens from the user token and has to match one back to the stored IG id.
   * The *connect* path does not use this — it asks the Page directly (see
   * {@link Publisher.listInstagramAccounts}), because by then the user token is
   * long gone.
   */
  instagram?: InstagramAccount;
}

/**
 * An Instagram account we can publish to — necessarily a Business/Creator account
 * linked to a Facebook Page (ADR 0005).
 *
 * A personal Instagram account can never appear as one of these, because the only
 * API that names them (`instagram_business_account` on a Page) does not return
 * one. That is the enforcement: not a check we perform, but a shape the platform
 * refuses to give us.
 */
export interface InstagramAccount {
  /** The IG Business account id — what Content Publishing targets. */
  id: string;
  /** The @handle, for the User to recognize what is linked. */
  username: string;
  /**
   * What publishes to it: the *Page's* token. Instagram has no token of its own —
   * publishing to an IG Business account is an act of the Page it is linked to.
   */
  credential: PlatformCredential;
}

/**
 * A read of one already-published Target: its platform, the account credential
 * that authorizes the read, and the platform's durable post/media id we stored
 * at publish time. The same shape drives both a history thumbnail and a Post's
 * live per-post metrics — both are authenticated reads of one published post.
 *
 * The credential is the *Connected Account's* (the Page/TikTok token), not the
 * post's — a post has no token. `externalId` is the Target's `external_id`.
 */
export interface PostReadRequest {
  platform: Platform;
  credential: PlatformCredential;
  /** The platform's post/media id, stored per Target on a successful publish. */
  externalId: string;
}

/**
 * A published post's live engagement numbers (CONTEXT.md `Metric Snapshot`
 * contrasts these per-post metrics, which are *never stored*, with the daily
 * account-level snapshots that are). Every field is optional because platforms
 * differ in what they expose — Facebook has no "views", a TikTok video has no
 * "shares" surfaced the same way — and a field we cannot read is simply absent
 * rather than a fabricated zero.
 */
export interface PostMetrics {
  likes?: number;
  comments?: number;
  shares?: number;
  views?: number;
}

/**
 * A read of one Connected Account's current account-level numbers, for the daily
 * metric snapshot (ADR 0004). Unlike a {@link PostReadRequest}, this is keyed by
 * the *account's* own destination id — the Page id, or TikTok `open_id` — because
 * these are properties of the account, not of any one post.
 *
 * The credential is the Connected Account's, exactly as stored (the same one a
 * publish or a per-post read uses).
 */
export interface AccountMetricsRequest {
  platform: Platform;
  credential: PlatformCredential;
  /** The Connected Account's destination id (the Page id / TikTok `open_id`). */
  externalId: string;
}

/**
 * A Connected Account's current account-level numbers (ADR 0004): the small,
 * uniform set the dashboard trends over time — followers, reach/impressions,
 * total engagement, and posts published. Every field is optional because the
 * platforms disagree on what they expose (TikTok's basic API surfaces almost no
 * reach; a field we cannot read is simply absent, never a fabricated zero), yet
 * the *shape* is identical across Facebook, Instagram, and TikTok so the
 * dashboard charts one thing, not three.
 *
 * Distinct from {@link PostMetrics}, which is a single post's live engagement and
 * is never stored — these four are snapshotted daily (CONTEXT.md `Metric
 * Snapshot`).
 */
export interface AccountMetrics {
  /** Total followers/fans of the account right now. */
  followers?: number;
  /** Reach or impressions over the platform's reporting window. */
  reach?: number;
  /** Total engagement (reactions, comments, shares, …) the platform reports. */
  engagement?: number;
  /** How many posts the account has published, as the platform counts them. */
  postsPublished?: number;
}

/**
 * The TikTok account a credential authorizes. Always exactly one: TikTok's OAuth
 * authorizes a single account, so unlike Facebook there is nothing to choose
 * between and no dead-end to guide out of.
 */
export interface TikTokAccount {
  /** TikTok's `open_id` — durable for our app, and what we publish to. */
  id: string;
  /** The account's display name, for the User to recognize what is linked. */
  displayName: string;
}

/**
 * A platform's refusal, as opposed to a bug in our code. Routes map this to a
 * 502 rather than a 500: the request was fine, the platform said no.
 */
export class PublisherError extends Error {
  constructor(
    readonly platform: Platform,
    message: string,
    /**
     * Whether the platform refused because the credential is dead (`auth`) or for
     * a transient reason (`transient`, the default). A background job that reads
     * through a token — the daily snapshot, the token refresh — uses this to tell
     * "reconnect this account now" from "try again tomorrow" (see
     * {@link PublisherFailureReason}).
     */
    readonly reason: PublisherFailureReason = "transient",
  ) {
    super(message);
    this.name = "PublisherError";
  }
}

export interface Publisher {
  publish(request: PublishRequest): Promise<PublishResult>;

  /** The URL to send the User to, to begin authorizing (OAuth start). */
  authorizeUrl(request: AuthorizeRequest): string;

  /**
   * Trade an OAuth callback code for a credential.
   *
   * @throws {PublisherError} if the platform rejects the code.
   */
  exchangeCode(request: ExchangeRequest): Promise<PlatformCredential>;

  /**
   * The Facebook Pages this credential manages (`pages_show_list`, ADR 0005).
   * An empty array means the person manages no Page — a dead-end, not an error.
   *
   * @throws {PublisherError} if the platform rejects the credential.
   */
  listFacebookPages(credential: PlatformCredential): Promise<FacebookPage[]>;

  /**
   * The Instagram Business/Creator accounts linked to a Page (ADR 0005). At most
   * one — a Page links to a single IG account — but an array, because zero is the
   * case that matters: it means the Page has no eligible account, and the User
   * needs guidance to convert theirs, not an error.
   *
   * Takes the *Page's* credential rather than the authorizing person's, because
   * that is what we still hold once a Page is connected: the user token is
   * dropped when the handshake ends. It is also the only thing a hand-pasted Page
   * token (ADR 0008) could ever supply.
   *
   * @throws {PublisherError} if the platform rejects the credential.
   */
  listInstagramAccounts(
    credential: PlatformCredential,
    pageId: string,
  ): Promise<InstagramAccount[]>;

  /**
   * Who a freshly-exchanged TikTok credential belongs to. TikTok's OAuth
   * authorizes exactly one account, so this identifies rather than offers.
   *
   * @throws {PublisherError} if the platform rejects the credential.
   */
  fetchTikTokAccount(credential: PlatformCredential): Promise<TikTokAccount>;

  /**
   * Extend a credential nearing expiry, for the token-refresh job.
   *
   * @throws {PublisherError} if the platform will not extend it — the caller
   * marks the Connected Account `token_expired` so the User can reconnect.
   */
  refreshCredential(request: RefreshRequest): Promise<PlatformCredential>;

  /**
   * The current thumbnail for a published post, fetched from the platform's
   * authenticated API using the stored post/media id (ADR 0003). The URL is a
   * temporary signed one the caller must treat as ephemeral — re-fetched on
   * demand, never persisted.
   *
   * Returns `null` rather than throwing when the platform has no thumbnail to
   * give *right now* — the media was deleted on the platform, the read was
   * rate-limited, or the account was since disconnected — because a missing
   * thumbnail is an ordinary state a history list must still render around
   * (text/status), not an error worth failing the whole page over.
   */
  fetchThumbnail(request: PostReadRequest): Promise<string | null>;

  /**
   * A published post's live per-post metrics (likes/comments/shares/views),
   * fetched fresh from the platform each time and never stored (CONTEXT.md
   * `Metric Snapshot`). Shown on a Post's detail page.
   *
   * @throws {PublisherError} if the platform refuses the read — the caller shows
   * that platform's metrics as unavailable without blanking the others.
   */
  fetchPostMetrics(request: PostReadRequest): Promise<PostMetrics>;

  /**
   * A Connected Account's current account-level numbers, for the daily snapshot
   * job (ADR 0004). Read once per account per day and stored, unlike the
   * live-only per-post reads above.
   *
   * @throws {PublisherError} if the platform refuses the read — the snapshot job
   * skips that one account and carries on, so one platform's outage never stops
   * another Client's numbers from being recorded.
   */
  fetchAccountMetrics(request: AccountMetricsRequest): Promise<AccountMetrics>;
}
