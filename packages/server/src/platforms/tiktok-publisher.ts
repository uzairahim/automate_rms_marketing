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
 * The real TikTok transport — the second implementation of the {@link Publisher}
 * seam (ADR 0002), and the one that makes the seam worth having: TikTok shares
 * nothing with Meta. Its own OAuth, its own token endpoint, its own refresh
 * model.
 *
 * The shape of a TikTok connection is simpler than Facebook's in the one way that
 * matters: its OAuth authorizes exactly one account, so there is no
 * `pages_show_list` step, nothing for the User to choose, and no dead-end to
 * guide out of. Connecting is: come back with a code, trade it, ask who it is.
 *
 * Like the Meta transport, nothing here is exercised by the behavioral suite —
 * that runs against the fake. This is integration-verified against the TikTok
 * sandbox while the app audit is pending (docs/platform-app-setup.md §2).
 *
 * Publishing arrives with Slice 8; Slice 7 needs the connection lifecycle.
 */

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";
const VIDEO_QUERY_URL = "https://open.tiktokapis.com/v2/video/query/";

/**
 * What we ask a creator for at login (docs/platform-app-setup.md §2).
 *
 * `video.publish` is the audit-gated one — direct posting to a public audience.
 * It is requested from the start rather than added later because TikTok audits a
 * scope set, and because a creator who has consented once should not be sent
 * back through consent the day our audit clears.
 */
const TIKTOK_SCOPES = ["user.info.basic", "video.upload", "video.publish"];

/** TikTok's OAuth token response. */
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  open_id?: string;
  error?: string;
  error_description?: string;
}

/** TikTok's `user/info` response — an envelope with its own error slot. */
interface UserInfoResponse {
  data?: { user?: { open_id?: string; display_name?: string } };
  error?: { code?: string; message?: string };
}

/** One video row from `video/query` — the fields a thumbnail and metrics read from. */
interface TikTokVideo {
  cover_image_url?: string;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  view_count?: number;
}

export class TikTokPublisher implements Publisher {
  constructor(
    private readonly clientKey: string,
    private readonly clientSecret: string,
    /** The one source of "now" (see core/clock.ts) — token expiry is computed from it. */
    private readonly clock: Clock,
  ) {}

  authorizeUrl(request: AuthorizeRequest): string {
    this.assertTikTok(request.platform);
    const params = new URLSearchParams({
      client_key: this.clientKey,
      redirect_uri: request.redirectUri,
      state: request.state,
      response_type: "code",
      scope: TIKTOK_SCOPES.join(","),
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(request: ExchangeRequest): Promise<PlatformCredential> {
    this.assertTikTok(request.platform);
    return this.token({
      client_key: this.clientKey,
      client_secret: this.clientSecret,
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
    });
  }

  async fetchTikTokAccount(credential: PlatformCredential): Promise<TikTokAccount> {
    const url = `${USER_INFO_URL}?${new URLSearchParams({
      fields: "open_id,display_name",
    }).toString()}`;

    const body = await this.call<UserInfoResponse>(url, {
      headers: { authorization: `Bearer ${credential.accessToken}` },
    });

    const user = body.data?.user;
    if (!user?.open_id) {
      throw new PublisherError(
        "tiktok",
        tikTokErrorMessage(body, "TikTok did not say which account this login is for."),
      );
    }
    return {
      id: user.open_id,
      // A creator can leave their display name empty; the handle-less fallback is
      // still better than a blank row the User cannot identify.
      displayName: user.display_name || "TikTok account",
    };
  }

  async refreshCredential(request: RefreshRequest): Promise<PlatformCredential> {
    this.assertTikTok(request.platform);

    // Unlike Meta — where refreshing means re-extending a *user* token and
    // re-deriving from it — TikTok issues a purpose-built refresh token, which is
    // what `parentToken` holds for this platform. Without one there is nothing to
    // present, and the account has to be reconnected by hand.
    const refreshToken = request.credential.parentToken;
    if (!refreshToken) {
      throw new PublisherError(
        "tiktok",
        "This TikTok token has no refresh token, so it cannot be renewed automatically.",
      );
    }

    return this.token({
      client_key: this.clientKey,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  async listFacebookPages(): Promise<FacebookPage[]> {
    throw new PublisherError("facebook", "The TikTok transport does not speak to Facebook.");
  }

  async listInstagramAccounts(): Promise<InstagramAccount[]> {
    throw new PublisherError("instagram", "The TikTok transport does not speak to Instagram.");
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    // Publishing lands in Slice 8. Failing loudly beats a silent no-op that would
    // look like a Post that published and vanished.
    throw new PublisherError(
      request.platform,
      "Publishing via the TikTok transport is not implemented yet.",
    );
  }

  async fetchThumbnail(request: PostReadRequest): Promise<string | null> {
    this.assertTikTok(request.platform);
    try {
      const video = await this.queryVideo(request, "id,cover_image_url");
      return video?.cover_image_url ?? null;
    } catch {
      // Best-effort, like Meta's: a removed video or a throttled read leaves the
      // history entry rendering text/status rather than failing the whole list.
      return null;
    }
  }

  async fetchPostMetrics(request: PostReadRequest): Promise<PostMetrics> {
    this.assertTikTok(request.platform);
    const video = await this.queryVideo(
      request,
      "id,like_count,comment_count,share_count,view_count",
    );
    return {
      likes: video?.like_count,
      comments: video?.comment_count,
      shares: video?.share_count,
      views: video?.view_count,
    };
  }

  /**
   * One `video/query` for a single video id — the endpoint behind both a
   * thumbnail (cover image) and per-post metrics. The requested `fields` decide
   * which of the two the caller gets back.
   */
  private async queryVideo(
    request: PostReadRequest,
    fields: string,
  ): Promise<TikTokVideo | undefined> {
    const url = `${VIDEO_QUERY_URL}?${new URLSearchParams({ fields }).toString()}`;
    const body = await this.call<{ data?: { videos?: TikTokVideo[] } }>(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.credential.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ filters: { video_ids: [request.externalId] } }),
    });
    return body.data?.videos?.[0];
  }

  /**
   * One call against TikTok's token endpoint, for both grants it supports. Both
   * return the same envelope, so both produce a credential the same way.
   */
  private async token(params: Record<string, string>): Promise<PlatformCredential> {
    const body = await this.call<TokenResponse>(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });

    // TikTok answers 200 with an `error` field rather than a status code, so a
    // successful HTTP response is not a successful exchange.
    if (body.error || !body.access_token) {
      throw new PublisherError(
        "tiktok",
        tikTokErrorMessage(body, "TikTok refused the token request."),
      );
    }

    return {
      accessToken: body.access_token,
      // Measured from the injected Clock, so it is the same "now" the refresh
      // job's due-query uses.
      expiresAt: body.expires_in
        ? new Date(this.clock.now().getTime() + body.expires_in * 1000)
        : undefined,
      refreshable: Boolean(body.refresh_token),
      // TikTok's durable per-app id for the creator.
      platformUserId: body.open_id,
      // The refresh token — TikTok's answer to Meta's parent user token, and the
      // only thing that will renew this credential. Sealed and stored with it
      // (ADR 0006), useless to anything but a refresh.
      parentToken: body.refresh_token,
    };
  }

  /**
   * One HTTP call to TikTok. Every refusal becomes a {@link PublisherError}
   * carrying TikTok's own message, so a User is told what TikTok actually said
   * rather than "something went wrong".
   */
  private async call<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new PublisherError("tiktok", `Could not reach TikTok: ${String(err)}`);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PublisherError("tiktok", `Unexpected response from TikTok: ${text}`);
    }

    if (!response.ok) {
      throw new PublisherError("tiktok", tikTokErrorMessage(body, text));
    }
    return body as T;
  }

  private assertTikTok(platform: Platform): void {
    if (platform !== "tiktok") {
      throw new PublisherError(
        platform,
        `The TikTok transport covers TikTok only; got ${platform}.`,
      );
    }
  }
}

/**
 * TikTok's own words for what went wrong, whichever of its two error shapes this
 * endpoint happens to use: the OAuth endpoints answer with a flat
 * `error`/`error_description`, the API endpoints with a nested `error.message`.
 * Falls back to `fallback` when it says nothing usable.
 */
function tikTokErrorMessage(body: unknown, fallback: string): string {
  const { error, error_description: description } = (body ?? {}) as {
    error?: unknown;
    error_description?: unknown;
  };
  if (typeof description === "string" && description) return description;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const { message } = error as { message?: unknown };
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}
