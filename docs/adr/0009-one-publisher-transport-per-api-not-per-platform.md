# One Publisher transport per API, not per platform

## Context

ADR 0002 established the `Publisher` seam and said it has "one implementation per
platform". Slice 6 had only Facebook, so the two readings — one per *platform* and
one per *API* — were the same thing and the distinction never came up.

Slice 7 added Instagram and TikTok, and they pull in opposite directions:

- **Instagram is not a separate API.** An IG Business/Creator account is a
  property of a Facebook Page: it is discovered through the Page, publishes with
  the Page's token, is authorized by the same Facebook login under the same Meta
  app, and dies with the same revocation (ADR 0005). A separate Instagram
  transport would be a second object wrapping the same app, the same token, and
  the same Graph host — two things that must agree about everything, with no
  seam between them worth having.
- **TikTok is a genuinely separate API**, sharing nothing with Meta: its own
  OAuth, its own token endpoint, its own refresh model.

Meanwhile ADR 0002's fallbacks are *also* not per-platform in practice. Meta App
Review and the TikTok audit are two reviews on two timelines, so "we are live on
Meta but not TikTok" is a state we will actually be in.

## Decision

A transport implements the `Publisher` seam **per upstream API**, not per
platform:

- `MetaPublisher` answers for both `facebook` and `instagram`.
- `TikTokPublisher` answers for `tiktok`.

A `RoutingPublisher` composes them into the single `Publisher` every caller
already holds, dispatching on the platform named in each request. Callers are
unchanged: they hold one `Publisher` and name a platform, exactly as before.

`resolvePublisher` picks the transport **per platform**, so the real/fake choice
is made independently for Meta and TikTok.

## Why

The seam exists to make a platform's transport swappable without touching domain
code (ADR 0002), and that property is preserved exactly — `RoutingPublisher`'s map
is now the single place a platform is swapped for an aggregator or the ADR 0008
path. What changes is only the granularity of the *implementations* behind it.

Splitting Meta in two would not buy independence, because the two halves have
none to give: they cannot be swapped, reviewed, or revoked separately. Grouping
TikTok with Meta would be worse. So the honest unit is the API.

Choosing the transport per platform follows from the same fact about reviews: an
all-or-nothing switch would mean a cleared Meta review sitting unused until
TikTok's cleared too.

## Consequences

- **This supersedes ADR 0002's "one implementation per platform"** — read it as
  "one implementation per upstream API, routed per platform". Everything else in
  ADR 0002 stands.
- The platform → transport map in `resolvePublisher` is the one place that knows
  what is behind the seam. A fallback (aggregator, ADR 0008) is adopted by
  changing an entry there.
- A transport is asked only for the platforms it was mapped to, and says so
  loudly otherwise (`MetaPublisher.fetchTikTokAccount` throws rather than
  returning something plausible) — a misroute must fail, not succeed against the
  wrong platform.
- A deployment can be real on one platform and faked on the other. That is a
  supported state, not a broken one, and the API logs which transport each
  platform got at boot.
