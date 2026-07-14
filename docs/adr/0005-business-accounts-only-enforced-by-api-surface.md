# Business/Creator accounts only, enforced by the API surface

## Context

The product publishes to Facebook and Instagram on behalf of Clients. There was
an expectation that personal accounts might be usable. They are not: Meta's
Graph API can only publish to a **Facebook Page**, and Instagram's Content
Publishing API only works with a **Business/Creator account linked to a Page**.
Personal FB profiles and personal IG accounts are simply not reachable by any
publishing endpoint.

## Decision

Only Pages and Business/Creator IG accounts can become Connected Accounts, and
this is enforced by *what the API returns*, not by asking the User:

1. User logs in with Facebook (a personal login — this is normal and unavoidable).
2. We call `pages_show_list`. Zero Pages → dead-end with "you need a Facebook
   Business Page" guidance. No Page, no connection.
3. If multiple Pages, the User explicitly picks which Page this Client connects.
4. Instagram: we only offer the IG accounts the Graph API returns for the chosen
   Page (guaranteed Business/Creator). None → guidance to convert to a Business
   account and link it to the Page.

We do **not** build an assisted/manual publishing path for personal accounts.

## Why

The entire product is *automated* cross-posting. A manual-reminder path for
personal accounts contradicts that promise and is a separate feature to build
and support. Requiring business accounts is not a strictness choice — it is the
only mode in which FB/IG programmatic publishing exists.

## Consequences

- A Client with only personal accounts cannot be onboarded until they convert to
  a Business Page / Business IG. Onboarding docs must state this up front.
- Publishing always targets Page IDs / Business IG IDs; personal profile IDs
  never enter the system. Do not add "personal account support" later expecting
  auto-publish — no such API exists.
