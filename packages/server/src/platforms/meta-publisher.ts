import type { Clock } from "../core/clock.js";
import {
  PublisherError,
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
 * Publishing arrives with Slice 8; Slices 6–7 need the connection lifecycle.
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

/** Meta's error envelope. */
interface GraphError {
  error?: { message?: string; type?: string; code?: number };
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

  async publish(request: PublishRequest): Promise<PublishResult> {
    // Publishing lands in Slice 8. Failing loudly beats a silent no-op that
    // would look like a Post that published and vanished.
    throw new PublisherError(
      request.platform,
      "Publishing via the Meta transport is not implemented yet.",
    );
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

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new PublisherError("facebook", `Could not reach Facebook: ${String(err)}`);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PublisherError("facebook", `Unexpected response from Facebook: ${text}`);
    }

    if (!response.ok) {
      const message = (body as GraphError)?.error?.message ?? text;
      throw new PublisherError("facebook", message);
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
