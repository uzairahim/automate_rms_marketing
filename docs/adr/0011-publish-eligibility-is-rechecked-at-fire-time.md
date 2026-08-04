# Publish eligibility is re-checked at fire time

## Context

A Client's right to publish is not a fact about a request — it is a fact about
the Client *at the moment something publishes*. Those two moments can be days
apart, because a Scheduled Post outlives the request that created it.

Until now the gates lived only at the HTTP boundary:

- `authenticateClientRequest` blocks a suspended or expired Client on every
  Client-facing route.
- `routes/posts.ts` rejects a Target whose platform the Client's Plan does not
  enable.

Neither reaches the worker. `findDuePosts` selected on
`status = 'scheduled' AND scheduled_at <= $1` with no join to `clients`, and
nothing under `posts/` consulted a Plan at all. The consequences were real and
opposite to what the product promises:

- A Client suspended for non-payment kept publishing everything it had already
  scheduled, and kept retrying failed Targets. `CONTEXT.md` claimed access status
  "gates what the Client can do"; for scheduled work it gated nothing.
- A Client downgraded to TikTok-only still published tomorrow's already-scheduled
  Facebook Post.

The shape of the bug matters more than either instance: the scheduler is a
**second entrypoint into the publishing domain**, and every gate written as
route middleware is invisible to it.

## Decision

Publish eligibility is defined once and asked twice. It lives in `@smma/core`'s
`eligibility.ts` (extracted there per ADR 0010) — it is tenancy's rule, not the
publishing domain's.

- **At compose time**, the HTTP routes ask it, so a User is told immediately —
  "this Client's plan does not include facebook" — while they can still act on it.
- **At fire time**, `attemptPublish` asks it again, per Target, immediately
  before handing anything to the Publisher. Every path that can reach a Publisher
  funnels through there — the scheduler's fan-out, the auto-retry tick, and a
  User's manual retry — so one call covers all three. A Target that is no longer
  eligible is marked `Failed` with its own reason, never the grace-window
  message, and is not retried. Other Targets on the same Post are unaffected,
  exactly as with any per-Target failure.

Posts that came due while a Client was ineligible are failed with a reason naming
the real cause, and are not silently published later. The scheduler asks the
access-status half of the rule *before* the grace window, so a suspended Client's
Post is never told it missed a window it never had a chance to meet.

An `access_status = 'active'` prefilter on the due-query was considered as a cost
saving and **rejected**, on the condition every such prefilter has to meet:
removing it must not change behavior. It fails that test. A Post that came due
while its Client was suspended has to be Failed, and a query that never returns
it cannot fail it — the Post would sit `scheduled` until the Client was
reactivated and then fire late, or miss its grace window, which is the outcome
this ADR exists to prevent.

## Why

The doubled call is deliberate, and this ADR exists mostly to say so: a reader who
finds the same rule consulted in `routes/` and again in `posts/` will be tempted
to delete one. Deleting the fire-time call reopens both bugs above. Deleting the
compose-time call would be *safe* but worse — the User would discover an
impossible Post only after it failed, instead of while writing it.

Holding the schedule instead of failing it was rejected. Reactivating a Client
after a three-day suspension would dump a burst of stale Posts onto live accounts
at the wrong hours, which is precisely what the 60-minute grace window (ADR-less,
from the PRD) exists to prevent. Failing with an honest reason keeps the promise
that content never goes out at an embarrassing time.

## Consequences

- **Two callers, one rule.** Any future gate on publishing belongs in the core
  eligibility function, not in route middleware, or the worker will not see it.
- The Target error vocabulary grows a distinct reason per cause — suspended,
  expired, platform no longer in Plan — because "Failed" alone cannot tell a User
  whether to reconnect an account, contact their administrator, or wait.
- The admin panel surfaces the consequence before the operator commits: disabling
  a platform, or suspending a Client, reports how many Scheduled Posts it affects.
  That is a courtesy layer on top of the invariant, never a substitute for it.
- The hardcoded grace-window message is no longer the only way a scheduled Post
  fails without publishing, so the reason becomes a parameter (`markMissed` is
  now `failWithoutPublishing`).
- Both ticks report `blocked` separately — the scheduler's alongside `fired` and
  `missed`, the retry tick's *outside* `attempted` — so an operator reading a log
  can tell "we refused to publish this" apart from "we tried and it did not go".
