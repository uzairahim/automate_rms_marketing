import type { Clock } from "../core/clock.js";
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
  type PublisherFailureReason,
  type PublishRequest,
  type PublishResult,
  type Publisher,
  type RefreshRequest,
  type TikTokAccount,
} from "../core/publisher.js";

/**
 * The real Meta transport — one implementation of the {@link Publisher} seam
 * (ADR 0002), speaking the Graph API over `fetch`.
 *
 * It answers for *both* Facebook and Instagram, because on Meta's side they are
 * one thing: an IG Business account is a property of a Page, publishes with that
 * Page's token, and has no login of its own (ADR 0005). Splitting them into two
 * transports would mean two objects sharing one app, one token, and one
 * revocation.
 *
 * Nothing in here is exercised by the behavioral suite, by design: the suite
 * runs against the fake, and this is integration-verified against our own test
 * Page while App Review is pending (ADR 0002, docs/platform-app-setup.md). That
 * is why it is kept as thin as it is — the interesting decisions live behind the
 * seam, in code that tests can reach.
 *
 * Publishing here needs `MEDIA_BASE_URL` to be an origin Meta itself can reach:
 * every media path hands Meta a *URL to fetch*, never bytes, and Instagram has
 * no upload endpoint at all. A localhost value silently produces a Page post
 * with no image and an Instagram container that never leaves ERROR.
 */

const GRAPH_VERSION = "v21.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;
const OAUTH_DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

/**
 * What we ask a person for at login.
 *
 * `pages_show_list` is the one that matters for ADR 0005 — it is what lets us
 * ask which Pages they manage, and therefore what makes business-page
 * enforcement possible at all. The publishing scopes are requested here (rather
 * than at first publish) because Meta reviews a scope set, and sending a person
 * through consent twice is worse than asking once.
 */
const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "business_management",
  // Instagram is authorized here too, at the Facebook login (Slice 7): it has no
  // consent screen of its own, so these are the only chance to ask.
  "instagram_basic",
  "instagram_content_publish",
];

/**
 * The `fields` expression that turns `me/accounts` into everything a connection
 * needs: the Page, the token we publish with, and the IG Business account linked
 * to it. Asking for `instagram_business_account` here rather than in a second
 * call per Page is what keeps refresh to two round-trips regardless of how many
 * Pages a person manages.
 */
const PAGE_FIELDS = "id,name,access_token,instagram_business_account{id,username}";

/**
 * How long to wait on an Instagram media container before giving up.
 *
 * An image container is ready on the first check; a video has to be transcoded
 * by Meta first, and publishing before it reports `FINISHED` is refused. Bounded
 * at roughly two minutes because this runs inside a publish attempt — a
 * container still processing after that is better reported as "retry shortly"
 * than held open, and the Target's own retry will pick it up.
 */
const IG_CONTAINER_POLL_INTERVAL_MS = 3_000;
const IG_CONTAINER_MAX_POLLS = 40;

/** Wait, for the Instagram container poll. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Meta's error envelope. */
interface GraphError {
  error?: { message?: string; type?: string; code?: number };
}

/**
 * Classify a Graph API error as a dead credential (`auth`) or a transient
 * refusal — the distinction the daily snapshot and publish paths act on (ADR
 * 0008, PRD #1).
 *
 * Keyed strictly on **code 190**, Meta's canonical invalid/expired-token error
 * (its token-death subcodes — 458/460/463/467/492 — all ride under 190). We
 * deliberately do *not* key on `type: "OAuthException"`: Meta stamps that same
 * type on rate-limit errors (codes 4, 17, 32, 613), and treating a throttle as
 * `auth` would flip a perfectly live account to `token_expired` and refuse its
 * posts — the precise false positive this classification exists to avoid.
 * Anything that is not unmistakably a dead token is transient, so the worst case
 * is a retry, never a wrongful reconnect prompt.
 */
export function graphFailureReason(error: GraphError["error"]): PublisherFailureReason {
  return error?.code === 190 ? "auth" : "transient";
}

export class MetaPublisher implements Publisher {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    /** The one source of "now" (see core/clock.ts) — token expiry is computed from it. */
    private readonly clock: Clock,
  ) {}

  authorizeUrl(request: AuthorizeRequest): string {
    this.assertFacebookLogin(request.platform);
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: request.redirectUri,
      state: request.state,
      response_type: "code",
      scope: FACEBOOK_SCOPES.join(","),
    });
    return `${OAUTH_DIALOG_URL}?${params.toString()}`;
  }

  async exchangeCode(request: ExchangeRequest): Promise<PlatformCredential> {
    this.assertFacebookLogin(request.platform);

    // A short-lived user token first...
    const short = await this.graph<{ access_token: string }>("oauth/access_token", {
      client_id: this.appId,
      client_secret: this.appSecret,
      redirect_uri: request.redirectUri,
      code: request.code,
    });

    // ...immediately traded for a long-lived one. Page tokens derived from a
    // long-lived user token are themselves long-lived, which is what makes a
    // connection survive without the User re-authorizing every couple of hours.
    return this.exchangeForLongLived(short.access_token);
  }

  async listFacebookPages(credential: PlatformCredential): Promise<FacebookPage[]> {
    // ADR 0005: this call *is* the business-page enforcement. It returns Pages
    // and only Pages — a personal profile cannot appear here, and an account
    // that manages none returns an empty list, which is a real dead-end.
    const body = await this.graph<{
      data?: Array<{
        id: string;
        name: string;
        access_token: string;
        instagram_business_account?: { id: string; username: string };
      }>;
    }>("me/accounts", {
      access_token: credential.accessToken,
      fields: PAGE_FIELDS,
      limit: "100",
    });

    return (body.data ?? []).map((page) => {
      const pageCredential: PlatformCredential = {
        // The Page token, not the user token: publishing acts as the Page.
        accessToken: page.access_token,
        // A Page token derived from a long-lived user token does not carry its
        // own expiry — it lives as long as the user token behind it, which is
        // what `expiresAt` on the credential we exchanged already records.
        expiresAt: credential.expiresAt,
        refreshable: true,
        platformUserId: credential.platformUserId,
        // Keep the user token: it is the only thing Meta will extend, and the
        // only way to re-derive this Page token later. See `refreshCredential`.
        parentToken: credential.accessToken,
      };
      return {
        id: page.id,
        name: page.name,
        credential: pageCredential,
        instagram: instagramFrom(page.instagram_business_account, pageCredential),
      };
    });
  }

  async listInstagramAccounts(
    credential: PlatformCredential,
    pageId: string,
  ): Promise<InstagramAccount[]> {
    // Asked of the *Page*, using the Page's own token — which is all we still
    // hold once a Page is connected, and all a hand-pasted token (ADR 0008)
    // could ever be. `instagram_business_account` is absent for a Page with no
    // linked Business/Creator account, and there is no field that would name a
    // personal one: ADR 0005's enforcement is this shape, not a check of ours.
    const page = await this.graph<{
      instagram_business_account?: { id: string; username: string };
    }>(pageId, {
      access_token: credential.accessToken,
      fields: "instagram_business_account{id,username}",
    });

    const account = instagramFrom(page.instagram_business_account, credential);
    return account ? [account] : [];
  }

  async fetchTikTokAccount(): Promise<TikTokAccount> {
    // TikTok is a different company's API entirely — see TikTokPublisher. The
    // router never sends one here; guarding says so out loud if it ever did.
    throw new PublisherError("tiktok", "The Meta transport does not speak to TikTok.");
  }

  async refreshCredential(request: RefreshRequest): Promise<PlatformCredential> {
    this.assertMetaPlatform(request.platform);
    const { credential, externalId } = request;

    // A Page token cannot be extended on its own: `fb_exchange_token` is a
    // *user*-token grant, and handing it a Page token does not return a
    // refreshed Page token. The only correct move is to re-extend the user token
    // the Page token came from, then re-derive the Page token from it.
    if (!credential.parentToken) {
      throw new PublisherError(
        request.platform,
        "This token was not obtained through Facebook login, so it cannot be refreshed automatically.",
      );
    }

    const user = await this.exchangeForLongLived(credential.parentToken);
    const pages = await this.listFacebookPages(user);

    // Instagram publishes with a Page token but is *identified* by its own id, so
    // the refreshed token is found by asking which Page still links to it. That
    // it can come up empty is the point: an IG account unlinked from the Page, or
    // a Page handed to someone else, are both genuine "reconnect" — and this is
    // the only place we'd find out.
    const page =
      request.platform === "instagram"
        ? pages.find((candidate) => candidate.instagram?.id === externalId)
        : pages.find((candidate) => candidate.id === externalId);

    // The person still has a valid login but no longer manages the destination
    // (it was handed over, or our access to it was removed). The caller marks it
    // token_expired.
    if (!page) {
      throw new PublisherError(
        request.platform,
        request.platform === "instagram"
          ? "No Facebook Page this account manages links to the connected Instagram account."
          : "This Facebook account no longer manages the connected Page.",
      );
    }
    return page.credential;
  }

  /**
   * Publish one Target to a Facebook Page or an Instagram Business account.
   *
   * Returns a {@link PublishResult} rather than throwing, because a platform
   * refusal is an *outcome* here, not an exception: the retry state machine
   * reads `ok: false` and decides whether to try again, and `reason: "auth"` is
   * what flips the Connected Account to `token_expired`. A throw would escape
   * the fan-out and 500 the whole compose, taking the other platforms' perfectly
   * good results with it.
   */
  async publish(request: PublishRequest): Promise<PublishResult> {
    this.assertMetaPlatform(request.platform);
    try {
      return request.platform === "instagram"
        ? await this.publishToInstagram(request)
        : await this.publishToFacebook(request);
    } catch (err) {
      if (err instanceof PublisherError) {
        return { ok: false, error: err.message, reason: err.reason };
      }
      throw err;
    }
  }

  /**
   * A Facebook Page post. Three different edges, because Meta models them as
   * three different things — a link-less status, a photo, and a video are not
   * one endpoint with a flag.
   *
   * What we keep as the Target's `externalId` is the *post* id wherever Meta
   * offers one (`/photos` returns both), since that is the node the history
   * thumbnail and per-post metrics later read from.
   */
  private async publishToFacebook(request: PublishRequest): Promise<PublishResult> {
    const { text, mediaUrl, mediaType, credential, externalId: pageId } = request;
    const accessToken = credential.accessToken;

    let created: { id: string; post_id?: string };
    if (!mediaUrl) {
      created = await this.graphPost("facebook", `${pageId}/feed`, {
        access_token: accessToken,
        message: text,
      });
    } else if (mediaType === "video") {
      // `file_url` makes Meta fetch the video from us, which is why MEDIA_BASE_URL
      // has to be publicly reachable — there is no raw upload on this path.
      created = await this.graphPost("facebook", `${pageId}/videos`, {
        access_token: accessToken,
        file_url: mediaUrl,
        description: text,
      });
    } else {
      created = await this.graphPost("facebook", `${pageId}/photos`, {
        access_token: accessToken,
        url: mediaUrl,
        caption: text,
        published: "true",
      });
    }

    const postId = created.post_id ?? created.id;
    return {
      ok: true,
      externalId: postId,
      permalink: `https://www.facebook.com/${postId}`,
    };
  }

  /**
   * An Instagram post, which is always two calls and often a wait in between:
   * create a media *container*, then publish it. Meta has no single-shot
   * endpoint, and for video the container is not publishable until Meta has
   * finished transcoding — publishing early is refused.
   *
   * Instagram cannot post text alone (our compose gate already enforces this),
   * and takes only a public URL — never an upload.
   */
  private async publishToInstagram(request: PublishRequest): Promise<PublishResult> {
    const { text, mediaUrl, mediaType, credential, externalId: igUserId } = request;
    const accessToken = credential.accessToken;

    if (!mediaUrl) {
      // Defensive: compose refuses this long before here. Reported as a refusal
      // rather than thrown so it reads as this Target's outcome.
      return { ok: false, error: "Instagram requires an image or video." };
    }

    const container = await this.graphPost("instagram", `${igUserId}/media`, {
      access_token: accessToken,
      caption: text,
      // A feed video is published as a Reel — Meta retired the plain VIDEO
      // container type for this edge.
      ...(mediaType === "video"
        ? { media_type: "REELS", video_url: mediaUrl }
        : { image_url: mediaUrl }),
    });

    await this.awaitContainerReady(container.id, accessToken);

    const published = await this.graphPost("instagram", `${igUserId}/media_publish`, {
      access_token: accessToken,
      creation_id: container.id,
    });

    return {
      ok: true,
      externalId: published.id,
      // Asked for rather than constructed: an IG media's canonical URL uses a
      // shortcode we are not given, so there is nothing to build one from.
      permalink: await this.instagramPermalink(published.id, accessToken),
    };
  }

  /**
   * Wait for an Instagram media container to finish processing.
   *
   * An image container is `FINISHED` on the first check; a video may take tens of
   * seconds. Polled rather than awaited on a webhook because Meta offers no
   * callback for this, and bounded so a container stuck `IN_PROGRESS` fails the
   * Target instead of holding a request open indefinitely.
   */
  private async awaitContainerReady(containerId: string, accessToken: string): Promise<void> {
    for (let attempt = 0; attempt < IG_CONTAINER_MAX_POLLS; attempt += 1) {
      const container = await this.graph<{ status_code?: string; status?: string }>(containerId, {
        access_token: accessToken,
        fields: "status_code,status",
      });

      if (container.status_code === "FINISHED") return;
      if (container.status_code === "ERROR" || container.status_code === "EXPIRED") {
        throw new PublisherError(
          "instagram",
          // `status` carries Meta's own explanation of what it disliked about
          // the media — far more useful than "ERROR".
          container.status ?? "Instagram could not process this media.",
        );
      }
      await delay(IG_CONTAINER_POLL_INTERVAL_MS);
    }

    throw new PublisherError(
      "instagram",
      "Instagram is still processing this media. It was not published — retry in a few minutes.",
    );
  }

  /** An IG media's canonical permalink, or undefined if Meta will not give one. */
  private async instagramPermalink(mediaId: string, accessToken: string): Promise<string | undefined> {
    try {
      const media = await this.graph<{ permalink?: string }>(mediaId, {
        access_token: accessToken,
        fields: "permalink",
      });
      return media.permalink;
    } catch {
      // The post is already live; a missing link must not turn that into a
      // failure the retry machinery would try to publish a second time.
      return undefined;
    }
  }

  async fetchThumbnail(request: PostReadRequest): Promise<string | null> {
    this.assertMetaPlatform(request.platform);
    try {
      if (request.platform === "instagram") {
        // An IG media exposes a `thumbnail_url` for video and `media_url` for a
        // still image — whichever is present is the thumbnail.
        const media = await this.graph<{ thumbnail_url?: string; media_url?: string }>(
          request.externalId,
          { access_token: request.credential.accessToken, fields: "thumbnail_url,media_url" },
        );
        return media.thumbnail_url ?? media.media_url ?? null;
      }
      const post = await this.graph<{ full_picture?: string }>(request.externalId, {
        access_token: request.credential.accessToken,
        fields: "full_picture",
      });
      return post.full_picture ?? null;
    } catch {
      // A thumbnail is best-effort (ADR 0003): a deleted media or a throttled
      // read must leave the history list rendering text/status, not fail it.
      return null;
    }
  }

  async fetchPostMetrics(request: PostReadRequest): Promise<PostMetrics> {
    this.assertMetaPlatform(request.platform);
    if (request.platform === "instagram") {
      const media = await this.graph<{ like_count?: number; comments_count?: number }>(
        request.externalId,
        { access_token: request.credential.accessToken, fields: "like_count,comments_count" },
      );
      return { likes: media.like_count, comments: media.comments_count };
    }
    // A Facebook Page post: the engagement counts hang off summary edges, and
    // `shares.count` is its own field. Absent counts stay absent (never a fake 0).
    const post = await this.graph<{
      likes?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
    }>(request.externalId, {
      access_token: request.credential.accessToken,
      fields: "likes.summary(true),comments.summary(true),shares",
    });
    return {
      likes: post.likes?.summary?.total_count,
      comments: post.comments?.summary?.total_count,
      shares: post.shares?.count,
    };
  }

  async fetchAccountMetrics(request: AccountMetricsRequest): Promise<AccountMetrics> {
    this.assertMetaPlatform(request.platform);
    const { credential, externalId } = request;

    if (request.platform === "instagram") {
      // The IG Business account node carries its own follower and media counts;
      // reach is a day-level Insight. Engagement has no single account-level day
      // metric worth faking, so it is left absent (ADR 0004: absent, never zero).
      const account = await this.graph<{ followers_count?: number; media_count?: number }>(
        externalId,
        { access_token: credential.accessToken, fields: "followers_count,media_count" },
      );
      return {
        followers: account.followers_count,
        postsPublished: account.media_count,
        reach: await this.dailyInsight(externalId, credential.accessToken, "reach"),
      };
    }

    // A Facebook Page: follower/fan counts and the total published-post count hang
    // off the node; reach and engagement are Page Insights day metrics.
    const page = await this.graph<{
      followers_count?: number;
      fan_count?: number;
      published_posts?: { summary?: { total_count?: number } };
    }>(externalId, {
      access_token: credential.accessToken,
      fields: "followers_count,fan_count,published_posts.summary(true)",
    });
    return {
      followers: page.followers_count ?? page.fan_count,
      postsPublished: page.published_posts?.summary?.total_count,
      reach: await this.dailyInsight(externalId, credential.accessToken, "page_impressions"),
      engagement: await this.dailyInsight(
        externalId,
        credential.accessToken,
        "page_post_engagements",
      ),
    };
  }

  /**
   * The latest value of one day-level Insights metric for a Page or IG account.
   * Insights answer `{ data: [{ values: [{ value }] }] }`; the last value is the
   * most recent day. Absent (rather than zero) when the platform returns none.
   */
  private async dailyInsight(
    nodeId: string,
    accessToken: string,
    metric: string,
  ): Promise<number | undefined> {
    const body = await this.graph<{ data?: Array<{ values?: Array<{ value?: number }> }> }>(
      `${nodeId}/insights`,
      { access_token: accessToken, metric, period: "day" },
    );
    const values = body.data?.[0]?.values;
    return values?.[values.length - 1]?.value;
  }

  /** Trade any user token for a long-lived one, and learn who it belongs to. */
  private async exchangeForLongLived(accessToken: string): Promise<PlatformCredential> {
    const body = await this.graph<{ access_token: string; expires_in?: number }>(
      "oauth/access_token",
      {
        grant_type: "fb_exchange_token",
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: accessToken,
      },
    );

    const me = await this.graph<{ id: string }>("me", {
      access_token: body.access_token,
      fields: "id",
    });

    return {
      accessToken: body.access_token,
      // Meta reports the lifetime in seconds; absent means "no stated expiry",
      // which the refresh job reads as "nothing to do". Measured from the
      // injected Clock, so it is the same "now" the refresh job's due-query uses.
      expiresAt: body.expires_in
        ? new Date(this.clock.now().getTime() + body.expires_in * 1000)
        : undefined,
      refreshable: true,
      // The Meta user id — what a deauthorization callback will name.
      platformUserId: me.id,
    };
  }

  /**
   * One GET against the Graph API. Every Meta refusal becomes a
   * {@link PublisherError} carrying Meta's own message, so a User is told what
   * Facebook actually said rather than "something went wrong".
   */
  private async graph<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${GRAPH_URL}/${path}?${new URLSearchParams(params).toString()}`;
    return this.request<T>("facebook", url, {});
  }

  /**
   * One POST against the Graph API — every write this transport makes, which is
   * to say every publish.
   *
   * Parameters go in the request body, form-encoded, rather than on the query
   * string: a caption is arbitrary user text of arbitrary length, and a URL is
   * the wrong place for it. Attributed to the calling platform so an Instagram
   * refusal is reported as Instagram's, even though both platforms speak to the
   * same host through the same app.
   */
  private async graphPost(
    platform: Platform,
    path: string,
    params: Record<string, string>,
  ): Promise<{ id: string; post_id?: string }> {
    return this.request<{ id: string; post_id?: string }>(platform, `${GRAPH_URL}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  /**
   * The one place a Graph call is made and a Meta refusal is turned into a
   * {@link PublisherError} carrying Meta's own message — so a User is told what
   * Facebook actually said rather than "something went wrong".
   */
  private async request<T>(platform: Platform, url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new PublisherError(platform, `Could not reach Facebook: ${String(err)}`);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PublisherError(platform, `Unexpected response from Facebook: ${text}`);
    }

    if (!response.ok) {
      const graphError = (body as GraphError)?.error;
      const message = graphError?.message ?? text;
      // A dead token becomes an `auth` refusal so a background read — the daily
      // snapshot — moves the account to `token_expired` rather than retrying a
      // credential that will never recover (ADR 0008, PRD #1). See
      // {@link graphFailureReason} for why this is code 190 only, not every
      // OAuthException.
      throw new PublisherError(platform, message, graphFailureReason(graphError));
    }
    return body as T;
  }

  /**
   * Instagram shares this transport but not the *login*: there is no Instagram
   * consent screen and no Instagram authorization code. An IG account is reached
   * from an already-connected Page (`listInstagramAccounts`), so asking this
   * transport for an Instagram OAuth URL is a caller bug, not a platform refusal.
   */
  private assertFacebookLogin(platform: Platform): void {
    if (platform !== "facebook") {
      throw new PublisherError(
        platform,
        `Only Facebook has a Meta login; ${platform} is connected without one.`,
      );
    }
  }

  /** The platforms this transport speaks for at all. */
  private assertMetaPlatform(platform: Platform): void {
    if (platform !== "facebook" && platform !== "instagram") {
      throw new PublisherError(
        platform,
        `The Meta transport covers Facebook and Instagram; got ${platform}.`,
      );
    }
  }
}

/**
 * Project a Page's `instagram_business_account` into an {@link InstagramAccount},
 * or undefined when the Page links to none. The Page's credential comes along
 * because it is what publishes to the account — Instagram has no token of its own.
 */
function instagramFrom(
  account: { id: string; username: string } | undefined,
  pageCredential: PlatformCredential,
): InstagramAccount | undefined {
  return account && { id: account.id, username: account.username, credential: pageCredential };
}
