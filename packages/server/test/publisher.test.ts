import { describe, it, expect } from "vitest";
import { FakePublisher } from "../src/core/fake-publisher.js";
import { publishRequest } from "./helpers/publish.js";

describe("FakePublisher", () => {
  it("records what would be sent per platform", async () => {
    const publisher = new FakePublisher();
    await publisher.publish(publishRequest("facebook", { text: "hello" }));
    await publisher.publish(
      publishRequest("tiktok", { text: "vid", mediaUrl: "https://x/v.mp4", mediaType: "video" }),
    );

    expect(publisher.sent).toHaveLength(2);
    expect(publisher.sentTo("facebook")).toEqual([publishRequest("facebook", { text: "hello" })]);
    expect(publisher.sentTo("tiktok")[0]?.mediaUrl).toBe("https://x/v.mp4");
  });

  it("succeeds by default with a durable external id", async () => {
    const publisher = new FakePublisher();
    const result = await publisher.publish(publishRequest("instagram", { text: "hi" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.externalId).toBeTruthy();
  });

  it("can be scripted to fail a specific platform", async () => {
    const publisher = new FakePublisher();
    publisher.scriptFailure("tiktok", "TikTok requires a video");

    const ok = await publisher.publish(publishRequest("facebook", { text: "a" }));
    const bad = await publisher.publish(publishRequest("tiktok", { text: "b" }));

    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("TikTok requires a video");
  });

  it("can be scripted to succeed with a chosen external id", async () => {
    const publisher = new FakePublisher();
    publisher.scriptSuccess("facebook", "fb_123", "https://fb.test/p/123");
    const result = await publisher.publish(publishRequest("facebook", { text: "a" }));
    expect(result).toMatchObject({ ok: true, externalId: "fb_123", permalink: "https://fb.test/p/123" });
  });

  it("does not leak external mutation into recorded requests", async () => {
    const publisher = new FakePublisher();
    const req = publishRequest("facebook", { text: "original" });
    await publisher.publish(req);
    req.text = "mutated";
    expect(publisher.sent[0]?.text).toBe("original");
  });
});
