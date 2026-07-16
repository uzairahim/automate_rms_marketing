# Platform App Setup — Meta & TikTok

How we register and get approval for the single Meta app and single TikTok app
that every Client connects through. Read this before starting integration work —
approvals are the long pole and must start on day one.

> All Clients connect *through our one app per platform*. Clients never register
> a developer app. We own the app, we own the review process, we store the
> tokens.

> ⚠️ Platform requirements change frequently. Treat this as a starting checklist
> and confirm each item against the live developer docs before submitting.

---

## 1. Meta (Facebook Pages + Instagram)

### App creation
- Create an app at **developers.facebook.com** → type **Business**.
- Add products: **Facebook Login**, **Instagram** (Instagram API with Facebook
  Login / Instagram Graph API), and **Webhooks**.
- Attach the app to a **Meta Business Portfolio** (business.facebook.com).

### Business verification (required for Advanced Access)
- Complete **Business Verification** in the Business Portfolio: legal business
  name, address, and a verification method (business document, phone, domain, or
  email on a matching domain).
- Without verification the app is stuck on **Standard Access** — it only works
  for accounts that hold a role in our app (our own test Pages). We need
  **Advanced Access** to act on Clients' Pages.

### Permissions to request in App Review
| Permission | What it unlocks |
|---|---|
| `pages_show_list` | List the Pages a User manages |
| `pages_read_engagement` | Read Page + post engagement (analytics) |
| `pages_manage_posts` | Publish/schedule posts to a Facebook Page |
| `business_management` | Manage Pages/IG assets owned by a Business |
| `instagram_basic` | Read the linked Instagram Business account |
| `instagram_content_publish` | Publish to Instagram |
| `instagram_manage_insights` | Read Instagram analytics |

### App Review requirements
- App in **Live** mode (not Development).
- Hosted **Privacy Policy URL** and a **Data Deletion** callback (URL or
  instructions).
- App icon, category, and a clear app description.
- A **screencast** for each permission showing a real user connecting a Page/IG
  account and publishing through our UI.
- Expect 1–3 review rounds. **Budget 2–6 weeks.**

### Hard technical constraints (independent of review)
- **Instagram must be a Business or Creator account linked to a Facebook Page.**
  Personal IG profiles cannot be published to via API. This is the mechanism
  behind our "business page, not personal account" rule.
- **Instagram publishing needs a publicly reachable media URL** — we upload the
  image/video to our own storage, hand Meta the URL, then publish. Meta does not
  accept a raw file upload for IG.
- **Instagram rate limit:** ~25 API-published posts per IG account per 24 hours.
- Tokens: short-lived User token → **long-lived (~60-day) token** → per-Page
  access token. We must refresh before expiry via a background job.

---

## 2. TikTok

### App creation
- Register at **developers.tiktok.com**, create an app.
- Add products: **Login Kit** and **Content Posting API**.
- Verify the **redirect domain**.

### Scopes
| Scope | What it unlocks |
|---|---|
| `user.info.basic` | Basic account identity |
| `video.upload` | Upload a video to the user's TikTok **drafts/inbox** |
| `video.publish` | **Direct-post** a public video (audit-gated) |

### Audit requirements
- **Direct posting to a public audience requires passing TikTok's app audit.**
- Until audited, posts are forced to **SELF_ONLY** (private) audience, or land in
  the user's inbox as a draft to finish manually.
- Needs a **Privacy Policy URL**, **Terms of Service URL**, app description, and
  a demo video of the posting flow. **Budget 2–4 weeks.**

### Hard technical constraints
- TikTok is **video-first**; photo posts go through the Content Posting API's
  photo mode and are also gated. We cannot post a plain text/image update the way
  we can to a Facebook Page.
- Creators must accept TikTok's content-posting consent on first connect.

---

## 3. Shared prerequisites (needed before either review)
- A live marketing/landing site on our domain.
- A hosted **Privacy Policy** and **Terms of Service**.
- A **data deletion / account removal** endpoint or documented process.
- A **deauthorization callback** endpoint (Meta requires one — called when a user
  removes our app; we should mark that Connected Account as disconnected).
  **Built** (Slice 6): `POST /api/webhooks/meta/deauthorize`. Register it as the
  Meta app's *Deauthorize Callback URL*. It verifies Meta's `signed_request`
  against `META_APP_SECRET` and refuses anything it cannot verify — so the secret
  must be configured for the endpoint to work at all.
- HTTPS everywhere, with our OAuth **redirect URIs** registered per app.
  Meta does **not** accept wildcard redirect URIs, so a per-Client-subdomain
  callback is impossible. We register exactly one — `<OAUTH_REDIRECT_BASE_URL>` +
  `/oauth/facebook/callback` — and re-tenant the returning User from the
  server-side `oauth_states` row rather than from the host they land on. Add that
  one URL to the app's *Valid OAuth Redirect URIs*.
- Facebook login requests these scopes (Slice 6): `pages_show_list`,
  `pages_manage_posts`, `pages_read_engagement`, `business_management`.
  `pages_show_list` is the one ADR 0005 depends on — it is what lets us ask which
  Pages a person manages instead of taking their word for it.
- Media storage with public URLs (for IG, and as the upload source generally).

---

## 4. If Meta or TikTok does NOT approve us

Approval can be delayed or refused. Options, roughly best to worst:

### A. Fix and resubmit (default)
Most rejections are fixable — a missing privacy-policy clause, an unclear
screencast, an unverified business. Read the reviewer notes, correct, resubmit.
This resolves the majority of cases.

### B. Use a unified social-posting API provider (de-risk / fallback)
Providers such as **Ayrshare, Phyllo, Late, Blotato**, or self-hostable
**Postiz / Mixpost** have *already passed* Meta and TikTok review and expose one
API for all platforms. We integrate against them instead of the raw platform
APIs.
- **Pro:** bypasses our own multi-week review entirely; one integration for all
  three platforms; they absorb API changes.
- **Con:** recurring per-profile/per-post cost, a third-party dependency in our
  critical path, and less control. Weigh their cost against our own review
  effort.

### C. Degrade to "assisted publishing" (no direct-post approval)
- **TikTok without audit:** use `video.upload` to push the video into the
  creator's TikTok inbox as a draft; the User opens TikTok and taps publish. We
  still handle composition, scheduling reminders, and analytics.
- **Instagram without `instagram_content_publish`:** schedule + send the User a
  push/notification at post time with the caption and media ready to paste
  (the model Later/Planoly use for personal accounts). Not true automation, but
  functional.
- **Facebook:** a Page whose owner holds a role in our app can be posted to even
  in Development Mode — usable for a tiny pilot, not for scaling.

### D. Per-platform partial launch
If only one platform approves first, launch that platform for Clients whose Plan
needs it and keep the others in assisted mode until their approval lands. The
per-platform Plan toggle already supports this.

### E. Manual "bring your own token" (Meta only) — proven fallback

If our own app is not approved, a Client can generate a **long-lived Page access
token** themselves and hand it to us. This works because an app in Development
Mode grants *full* permissions to users who hold a role on it — and the Client is
the admin of their *own* app, so they get `pages_manage_posts` /
`instagram_content_publish` on their own Page/IG **without any App Review**. This
approach has been used successfully (e.g. in n8n automations).

> **Scope:** Meta only (Facebook Page + linked Instagram Business account). TikTok
> has no clean equivalent — it still needs the audit (Option C).

**Steps the Client performs (once, guided by us):**

1. Go to **developers.facebook.com**, logged in with the personal account that
   manages the Facebook Page.
2. **Create an app** → type **Business** (or reuse one). The Client stays the app
   **admin**, so Development Mode is enough — no review needed for their own
   assets.
3. Add products: **Facebook Login**, and **Instagram Graph API** if Instagram is
   needed.
4. Open **Tools → Graph API Explorer** and select that app.
5. Click **Generate Access Token** and grant:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   `business_management` — plus, for Instagram: `instagram_basic`,
   `instagram_content_publish`, `instagram_manage_insights`.
6. Call `GET /me/accounts` in the Explorer → find the Page, copy its
   **Page access token** and **Page ID**.
7. **Make it long-lived:** open **Tools → Access Token Debugger**, paste the
   token, click **Extend Access Token**. A Page token derived from a long-lived
   User token is effectively non-expiring (until password change / revoke).
8. For Instagram: call `GET /{page-id}?fields=instagram_business_account` to get
   the **IG Business account ID**.
9. Send us: the **long-lived Page access token**, the **Page ID**, and (if IG)
   the **IG Business account ID**.

**On our side:**

- A connect screen (or the Superadmin) pastes the token + IDs into the Client's
  Connected Account — the **same encrypted storage slot** an OAuth token would
  use ([ADR 0006](adr/0006-encrypt-tokens-at-rest-hash-passwords.md)). The
  **Publisher** interface consumes it identically to an OAuth token.

**Caveats — bake these into the design:**

- **No automatic refresh.** We don't own the OAuth flow, so we cannot silently
  refresh. When the token is invalidated (Client changes password, revokes
  access, or deletes the app), publishing fails. Show an explicit
  **"token expired — please regenerate"** state per Connected Account and notify
  the Client to redo the steps.
- **Manual and technical, per Client.** Fine as a fallback for a handful of
  Clients; it does not scale like our own approved app. Treat it as a bridge
  until Option A (fix-and-resubmit) lands.
- **Security.** The token grants full control of the Client's Page; it must be
  encrypted at rest exactly like an OAuth token, never logged, never exposed to
  the frontend.
