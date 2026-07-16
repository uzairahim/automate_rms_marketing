import type { Clock } from "../core/clock.js";
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
} from "../core/publisher.js";

/**
 * The real Meta transport — one implementation of the {@link Publisher} seam
 * (ADR 0002), speaking the Graph API over `fetch`.
 *
 * Nothing in here is exercised by the behavioral suite, by design: the suite
 * runs against the fake, and this is integration-verified against our own test
 * Page while App Review is pending (ADR 0002, docs/platform-app-setup.md). That
 * is why it is kept as thin as it is — the interesting decisions live behind the
 * seam, in code that tests can reach.
 *
 * Publishing arrives with Slice 8; Slice 6 needs the connection lifecycle.
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
];

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
    this.assertMeta(request.platform);
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
    this.assertMeta(request.platform);

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
      data?: Array<{ id: string; name: string; access_token: string }>;
    }>("me/accounts", { access_token: credential.accessToken, limit: "100" });

    return (body.data ?? []).map((page) => ({
      id: page.id,
      name: page.name,
      credential: {
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
      },
    }));
  }

  async refreshCredential(request: RefreshRequest): Promise<PlatformCredential> {
    this.assertMeta(request.platform);
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
    const page = pages.find((candidate) => candidate.id === externalId);
    // The person still has a valid login but no longer manages the Page (it was
    // handed over, or our access to it was removed). That is a genuine
    // "reconnect" — the caller marks it token_expired.
    if (!page) {
      throw new PublisherError(
        request.platform,
        "This Facebook account no longer manages the connected Page.",
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
   * Instagram publishes through the Graph API too and will share this transport
   * (Slice 7), but it does not share the *connect* flow — its accounts are
   * discovered from an already-chosen Page. Guarding here keeps that from being
   * discovered as a silent wrong answer later.
   */
  private assertMeta(platform: Platform): void {
    if (platform !== "facebook") {
      throw new PublisherError(
        platform,
        `The Meta transport's connect flow covers Facebook only; got ${platform}.`,
      );
    }
  }
}
