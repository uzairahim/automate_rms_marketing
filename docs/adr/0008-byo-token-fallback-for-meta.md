# Bring-your-own-token fallback for Meta when app review fails

## Context

Our own Meta app may be delayed or refused in App Review, which would block
Facebook/Instagram publishing for real Clients. We need a path that does not
depend on our app being approved. This approach has been used successfully in
practice (e.g. n8n automations).

## Decision

As a fallback, a Client generates a **long-lived Facebook Page access token**
from their **own** Meta app via the Graph API Explorer and hands it to us. It
works because an app in Development Mode grants full permissions to users who
hold a role on it, and the Client is the admin of their own app — so they get
`pages_manage_posts` / `instagram_content_publish` on their own Page and linked
Instagram Business account **without any App Review**.

The pasted token is stored in the **same encrypted Connected Account slot** an
OAuth token would occupy (see ADR-0006) and is consumed by the **Publisher**
interface identically (see ADR-0002). Full step-by-step is in
docs/platform-app-setup.md, Option E.

## Why

It is a genuine no-review path to Facebook + Instagram publishing, and it costs
nothing. It reuses the token slot and Publisher seam we already have, so it is
cheap to support. It is the reason the Publisher abstraction exists.

## Scope and consequences

- **Meta only.** TikTok has no clean Graph-Explorer equivalent; it still needs
  the audit or assisted publishing (Option C).
- **No automatic refresh.** We do not own the OAuth flow, so we cannot silently
  refresh. When the token is invalidated (password change, revoke, app deletion),
  publishing fails — the design must include an explicit **"token expired —
  regenerate"** state per Connected Account and prompt the Client to redo it.
- **Manual and technical, per Client.** A bridge for a handful of Clients, not a
  scalable substitute for our own approved app. Prefer fix-and-resubmit (Option
  A); use this while that is pending.
- **Security.** The token grants full Page control; encrypt at rest like any
  OAuth token, never log it, never expose it to the frontend.

## Note for future sessions

If FB/IG publishing is blocked because our app is not approved, **suggest this
fallback.** It is a proven, zero-cost bridge and slots into the existing token
storage + Publisher design without new architecture.
