import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accessDenied, authenticateClientRequest } from "../auth/guards.js";
import { planEnables } from "../tenancy/plan.js";
import { PLATFORMS, PublisherError, type Platform } from "../core/publisher.js";
import {
  attachCredentialToState,
  consumeOAuthState,
  findOAuthState,
  startOAuthState,
} from "../connections/oauth-state.js";
import {
  connectAccount,
  disconnectAccount,
  findAccount,
  listAccounts,
  type ConnectedAccount,
} from "../connections/accounts.js";
import { findClientById } from "../tenancy/clients.js";

/**
 * Connecting a Client's social destinations (PRD stories 18–20, 25, 28).
 *
 * The Facebook handshake is deliberately two steps with a choice in the middle:
 * logging in tells us which Pages a person manages, and *they* say which one
 * this Client connects. We never auto-pick, and a person who manages no Page is
 * a dead-end rather than a fallback to their personal profile — the Graph API
 * cannot publish to one at all (ADR 0005).
 *
 * Everything routes through the {@link Publisher} seam (ADR 0002), so tests
 * drive the whole flow against the fake and no real Meta call is ever made.
 */

/** The redirect URI for a platform. One fixed URI per platform — see AppDeps. */
export function redirectUriFor(baseUrl: string, platform: Platform): string {
  return new URL(`/oauth/${platform}/callback`, baseUrl).toString();
}

/**
 * Authenticate a Client request and confirm its Plan enables the platform.
 * Replies and returns null on any failure, so a disabled platform can never be
 * connected — the same gate `/api/platforms/:platform` applies (Slice 3).
 */
async function authorizeForPlatform(
  request: FastifyRequest,
  reply: FastifyReply,
  platform: Platform,
) {
  const ctx = await authenticateClientRequest(request, reply);
  if (!ctx) return null;

  if (!planEnables(ctx.client.plan, platform)) {
    await reply.code(403).send({
      error: "platform_not_enabled",
      message: `This Client's plan does not include ${platform}.`,
    });
    return null;
  }
  return ctx;
}

export async function registerConnectionRoutes(app: FastifyInstance): Promise<void> {
  // What is ready to post to (PRD story 25). One entry per platform the Plan
  // enables — a platform with no account yet reports `disconnected` rather than
  // going missing, because "not connected" is a state the User needs to see and
  // act on, not an absence.
  app.get("/api/connections", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;

    const accounts = await listAccounts(app.deps.pool, ctx.client.id);
    const byPlatform = new Map(accounts.map((account) => [account.platform, account]));

    // Plan toggles decide what a User is *offered* (PRD story 27), but a live
    // connection is shown regardless: if the Superadmin disables a platform the
    // Client had already connected, that account still holds a token, and hiding
    // it would leave the User unable to see or unlink it.
    const platforms = PLATFORMS.filter(
      (platform) =>
        planEnables(ctx.client.plan, platform) || isLive(byPlatform.get(platform)),
    );
    const connections = platforms.map(
      (platform) => byPlatform.get(platform) ?? notConnected(platform),
    );
    return reply.code(200).send({ connections: connections.map(connectionView) });
  });

  // Unlink the Facebook Page (PRD story 28). Deliberately *not* Plan-gated: this
  // is the one action that only ever removes access, so refusing it for a
  // disabled platform would strand a Client with a connection it cannot undo.
  app.delete("/api/connections/facebook", async (request, reply) => {
    const ctx = await authenticateClientRequest(request, reply);
    if (!ctx) return reply;

    const { pool, clock } = app.deps;
    await disconnectAccount(pool, clock, { clientId: ctx.client.id, platform: "facebook" });

    const account = await findAccount(pool, ctx.client.id, "facebook");
    return reply
      .code(200)
      .send({ connection: connectionView(account ?? notConnected("facebook")) });
  });

  // Begin Facebook login. The state is minted server-side and bound to this
  // Client and User, so the callback that comes back through the shared redirect
  // URI can be re-tenanted without trusting anything the browser says.
  app.post("/api/connections/facebook/start", async (request, reply) => {
    const ctx = await authorizeForPlatform(request, reply, "facebook");
    if (!ctx) return reply;

    const { pool, clock, publisher, oauthRedirectBaseUrl } = app.deps;
    const state = await startOAuthState(pool, clock, {
      clientId: ctx.client.id,
      userId: ctx.user.id,
      platform: "facebook",
    });

    const authorizeUrl = publisher.authorizeUrl({
      platform: "facebook",
      state,
      redirectUri: redirectUriFor(oauthRedirectBaseUrl, "facebook"),
    });

    return reply.code(200).send({ authorizeUrl, state });
  });

  // Return from Facebook login. Authenticated by the state, not by a session:
  // the User arrives here from Facebook, through a redirect URI shared by every
  // Client, so the state row is what says who they are.
  app.post<{ Body: { state?: string; code?: string } }>(
    "/api/connections/facebook/callback",
    async (request, reply) => {
      const { state, code } = request.body ?? {};
      if (typeof state !== "string" || typeof code !== "string") {
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "state and code are required." });
      }

      const { pool, clock, publisher, tokenCipher, oauthRedirectBaseUrl } = app.deps;
      const handshake = await findOAuthState(pool, clock, tokenCipher, {
        state,
        platform: "facebook",
      });
      if (!handshake) {
        return reply.code(400).send({
          error: "invalid_state",
          message: "This connection attempt has expired. Please start again.",
        });
      }

      let credential;
      let pages;
      try {
        credential = await publisher.exchangeCode({
          platform: "facebook",
          code,
          redirectUri: redirectUriFor(oauthRedirectBaseUrl, "facebook"),
        });
        pages = await publisher.listFacebookPages(credential);
      } catch (err) {
        if (err instanceof PublisherError) {
          return reply.code(502).send({ error: "facebook_error", message: err.message });
        }
        throw err;
      }

      // ADR 0005: no Page, no connection. The Graph API cannot publish to a
      // personal profile at all, so this is a genuine dead-end — the only way
      // forward is for the User to go create a Business Page.
      if (pages.length === 0) {
        return reply.code(409).send({
          error: "no_facebook_pages",
          message:
            "This Facebook account doesn't manage any Business Page. Create a Facebook " +
            "Business Page, then connect again — posting to a personal profile isn't possible.",
        });
      }

      // Park the user token until a Page is chosen, and offer the choice. Even a
      // single Page is offered rather than taken: which Page a Client publishes
      // as is the User's call to make, never ours.
      await attachCredentialToState(pool, tokenCipher, { state, credential });
      return reply
        .code(200)
        .send({ pages: pages.map((page) => ({ id: page.id, name: page.name })) });
    },
  );

  // The User's explicit choice of Page — the step the callback deliberately
  // stops short of. Like the callback, it is authenticated by the state.
  app.post<{ Body: { state?: string; pageId?: string } }>(
    "/api/connections/facebook/select",
    async (request, reply) => {
      const { state, pageId } = request.body ?? {};
      if (typeof state !== "string" || typeof pageId !== "string") {
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "state and pageId are required." });
      }

      const { pool, clock, publisher, tokenCipher } = app.deps;
      const handshake = await findOAuthState(pool, clock, tokenCipher, {
        state,
        platform: "facebook",
      });
      // No parked credential means Facebook login hasn't returned yet — there is
      // nothing to choose between, so this is the same "start again" as a state
      // that never existed.
      if (!handshake?.credential) {
        return reply.code(400).send({
          error: "invalid_state",
          message: "This connection attempt has expired. Please start again.",
        });
      }

      // The Plan and access status are re-checked against the Client the state
      // names, not the request's host: a Client suspended or de-toggled during
      // the handshake must not be able to finish it.
      const client = await findClientById(pool, handshake.clientId);
      if (!client) {
        return reply.code(404).send({ error: "unknown_client" });
      }
      const denied = accessDenied(client.plan.accessStatus);
      if (denied) return reply.code(403).send(denied);
      if (!planEnables(client.plan, "facebook")) {
        return reply.code(403).send({
          error: "platform_not_enabled",
          message: "This Client's plan does not include facebook.",
        });
      }

      // Re-ask the platform what this credential manages rather than trusting
      // the list we showed a moment ago. It is what makes the choice genuinely
      // enforced by the API surface (ADR 0005) and not merely rendered from it —
      // and it is where the Page token we publish with comes from.
      let pages;
      try {
        pages = await publisher.listFacebookPages(handshake.credential);
      } catch (err) {
        if (err instanceof PublisherError) {
          return reply.code(502).send({ error: "facebook_error", message: err.message });
        }
        throw err;
      }

      const page = pages.find((candidate) => candidate.id === pageId);
      if (!page) {
        return reply.code(404).send({
          error: "page_not_found",
          message: "That Page isn't one this Facebook account manages.",
        });
      }

      const connection = await connectAccount(pool, clock, tokenCipher, {
        clientId: handshake.clientId,
        platform: "facebook",
        externalId: page.id,
        displayName: page.name,
        // The Page token, not the user token: publishing acts as the Page.
        credential: page.credential,
      });
      await consumeOAuthState(pool, state);

      return reply.code(200).send({ connection: connectionView(connection) });
    },
  );
}

/** Whether an account still holds a link (and therefore a token) we must show. */
function isLive(account: ConnectedAccount | undefined): boolean {
  return account !== undefined && account.status !== "disconnected";
}

/**
 * The reported state of a platform a Client has no account row for. Identical to
 * one it disconnected — from the User's side "never linked" and "unlinked" are
 * the same situation, and the same button fixes both.
 */
function notConnected(platform: Platform): ConnectedAccount {
  return {
    platform,
    status: "disconnected",
    externalId: null,
    displayName: null,
    connectedAt: null,
    tokenExpiresAt: null,
  };
}

/** The Connected Account fields the SPA renders. Never a credential. */
function connectionView(account: ConnectedAccount) {
  return {
    platform: account.platform,
    status: account.status,
    externalId: account.externalId,
    displayName: account.displayName,
    connectedAt: account.connectedAt,
  };
}
