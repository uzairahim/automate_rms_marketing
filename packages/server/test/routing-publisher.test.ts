import { describe, it, expect } from "vitest";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { RoutingPublisher } from "../src/platforms/routing-publisher.js";
import type { Platform, Publisher } from "../src/core/publisher.js";
import { publishRequest } from "./helpers/publish.js";

/**
 * The Publisher that stands in front of the per-platform transports (ADR 0002).
 *
 * Worth testing on its own, thin as it is, because it is the thing that decides
 * *which platform's API a request reaches* — and a routing mistake does not fail,
 * it succeeds against the wrong platform. The API suite can't see this: it injects
 * one fake for everything, which is exactly the case where misrouting is invisible.
 */

/** A transport that answers only for the platforms it was given. */
function transports(): { fake: Record<Platform, FakePublisher>; router: Publisher } {
  const fake: Record<Platform, FakePublisher> = {
    facebook: new FakePublisher(),
    instagram: new FakePublisher(),
    tiktok: new FakePublisher(),
  };
  return { fake, router: new RoutingPublisher(fake) };
}

describe("RoutingPublisher", () => {
  it("sends each platform's publish to that platform's transport", async () => {
    const { fake, router } = transports();

    await router.publish(publishRequest("tiktok", { text: "vid" }));

    expect(fake.tiktok.sent).toHaveLength(1);
    expect(fake.facebook.sent).toHaveLength(0);
    expect(fake.instagram.sent).toHaveLength(0);
  });

  it("sends each platform's refresh to that platform's transport", async () => {
    const { fake, router } = transports();

    await router.refreshCredential({
      platform: "instagram",
      credential: { accessToken: "t", refreshable: true },
      externalId: "ig-1",
    });

    expect(fake.instagram.refreshRequests).toHaveLength(1);
    expect(fake.tiktok.refreshRequests).toHaveLength(0);
  });

  it("asks the platform named in the method, for the lookups that name one", async () => {
    const { fake, router } = transports();
    // Each transport is scripted differently, so the answer says who was asked.
    fake.facebook.scriptPages({ id: "from-facebook-transport", name: "FB" });
    fake.instagram.scriptPages({ id: "from-instagram-transport", name: "IG" });

    const pages = await router.listFacebookPages({ accessToken: "t", refreshable: true });

    expect(pages.map((page) => page.id)).toEqual(["from-facebook-transport"]);
  });

  it("routes Instagram's lookup to the Instagram transport", async () => {
    const { fake, router } = transports();
    fake.instagram.scriptPages({
      id: "page-1",
      name: "Page",
      instagram: { id: "ig-1", username: "acme" },
    });
    // The Facebook transport knows of no such Page, so a misroute returns nothing.
    fake.facebook.scriptPages();

    const accounts = await router.listInstagramAccounts(
      { accessToken: "t", refreshable: true },
      "page-1",
    );

    expect(accounts.map((account) => account.id)).toEqual(["ig-1"]);
  });

  it("routes TikTok's lookup to the TikTok transport", async () => {
    const { fake, router } = transports();
    fake.tiktok.scriptTikTokAccount({ id: "tt-1", displayName: "Acme" });

    const account = await router.fetchTikTokAccount({ accessToken: "t", refreshable: true });

    expect(account).toEqual({ id: "tt-1", displayName: "Acme" });
  });

  it("lets one transport answer for several platforms, as Meta's does", async () => {
    // The real wiring: Facebook and Instagram are one app, one token, one
    // transport (ADR 0005). Both must reach it.
    const meta = new FakePublisher();
    const tiktok = new FakePublisher();
    const router = new RoutingPublisher({ facebook: meta, instagram: meta, tiktok });

    await router.publish(publishRequest("facebook", { text: "a" }));
    await router.publish(publishRequest("instagram", { text: "b" }));

    expect(meta.sent.map((request) => request.platform)).toEqual(["facebook", "instagram"]);
    expect(tiktok.sent).toHaveLength(0);
  });
});
