# Integrate platform APIs directly, behind a Publisher interface

## Context

To publish to Facebook, Instagram, and TikTok we can either integrate the raw
platform APIs (owning our own Meta/TikTok apps and their review) or route
through a unified aggregator API (Ayrshare, Postiz, etc.) that has already
passed review. See docs/platform-app-setup.md.

## Decision

We integrate the **raw Meta and TikTok APIs directly**. We own the apps, store
the tokens, and absorb the review process. All publishing goes through a single
internal **Publisher** interface with one implementation per platform, so a
platform's transport can be swapped (e.g. to an aggregator) without touching the
rest of the app.

## Why

The priority is minimal recurring cost and full control of data and margin, not
fastest possible launch. Direct integration has only ~$10/month hosting cost and
no per-profile fees, versus an aggregator's ongoing per-profile/per-post charges
eating into per-Client margin.

The accepted cost is a 2–6 week review delay before we can post to real Client
accounts (Meta) and a 2–4 week audit (TikTok). We mitigate this by starting both
reviews on day one and building against our own test Page / TikTok sandbox in
the meantime.

## Consequences

- The Publisher interface is not optional — it is the escape hatch that keeps the
  aggregator fallback (and per-platform assisted-publishing fallback) cheap to
  adopt if a review stalls.
- We must run background jobs for token refresh and honor per-platform rate
  limits (e.g. Instagram's ~25 posts/24h) ourselves.

## Amendments

- **ADR 0009 refines "one implementation per platform"** to *one implementation
  per upstream API, routed per platform*: Facebook and Instagram are one Meta
  transport, because on Meta's side they are one app, one token, and one
  revocation. The seam and its swappability are unchanged.
