---
name: verify
description: Launch this app and drive it end-to-end to observe a change working — infra, API, worker, SPA, plus how to provision a Client and click the OAuth connect flows against the fake Publisher. Use when verifying a change to the server or web packages.
---

# Verifying this app

The surface is the **SPA at a Client subdomain** (`http://acme.localhost:5173`),
with the Fastify API behind it. Tenancy comes from the **Host header**, so which
host you use is never incidental — it is what selects the Client.

## Launch

```bash
docker compose up -d          # Postgres :55432, Redis :56379 (healthchecks; wait for healthy)
npm run dev:api               # :3001  — migrates on boot
npm run dev:web               # :5173  — Vite, proxies /api to :3001
npm run dev:worker            # only if the change touches a recurring job
```

`npm run dev` runs all four at once via concurrently, but separate processes give
you readable logs per service. Both API and web are `tsx watch` / Vite — they
**hot-reload on save**, which is how you re-script the fake mid-session.

The API prints which transport each platform got at boot. With no credentials set
you will see, and want, this:

```
[publisher] META_APP_ID/META_APP_SECRET are not set — using the fake Publisher for Facebook and Instagram.
[publisher] TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET are not set — using the fake Publisher for TikTok.
```

## Provision a Client to log in as

There is no signup, and **no administrative route exists on this API** — the
Client-facing service cannot create a Client, issue a credential, or change
anyone's access (ADR 0010). `admin.localhost` resolves to no Client, so every
tenant-scoped route 404s there; the handful of un-tenanted ones (`/api/health`,
the OAuth and webhook callbacks) answer on any host, as they always did. Two
ways in, and which one you want depends on what you are verifying:

**The fast path — `npm run seed`.** One command, no second stack, and the way to
get a login when the change under test has nothing to do with provisioning:

```bash
npm run seed        # idempotent; migrates first, so it works on a fresh checkout
```

It prints the login it just planted, and re-running it resets that password — so
it is also the way back in after losing one:

```
Sign in at http://acme.localhost:5173
  email:    admin@test.com
  password: Abcd_1234
```

That Client is `acme`, anchored to `America/New_York`, with all three platforms
enabled and **default branding** — the seeder sets none, so a check that needs
branding needs the panel. `SEED_SUBDOMAIN`, `SEED_TIMEZONE`, `SEED_EMAIL`, and
`SEED_PASSWORD` change what it plants; the Plan is always all three platforms.

`*.localhost` resolves to 127.0.0.1, so no `/etc/hosts` entry is needed.

**The real path — the admin panel.** Provision through the operator's own
service, which is what actually happens in production and the only way to reach
branding, a Plan change, or a timezone change at all. It is a second stack under
its own command; see the next section, then come back through
[Provisioning a Client from the panel](#the-admin-panel-smmaadmin).

Use the panel whenever the change touches provisioning, Plans, access status,
branding, or timezones. Use the seeder for everything else.

## The admin panel (`@smma/admin`)

A **separate deployable** (ADR 0010) with its own API, its own SPA, and its own
migrations. It is **not part of `npm run dev`** — it boots under its own command,
as a step of its own, and it needs neither Redis nor any of the platform
credentials:

```bash
docker compose up -d          # Postgres only is enough for this one
npm run create-superadmin     # prompts for the password (twice); email as an optional arg
npm run dev:admin             # admin API :3002, admin SPA :5174 (proxies /api to :3002)
```

Sign in at <http://localhost:5174> with the account the CLI just made. There is
no Host-header tenancy here: the admin service has no Client to resolve, so any
host reaches it.

**Provisioning a Client from the panel** is the real path the seeder shortcuts,
and the one to use when the change is to the panel itself: **Add a Client**, give
it a subdomain and a timezone, tick its platforms, and you land on that Client's
screen. The Client is immediately reachable at `http://<subdomain>.localhost:5173`
if the Client-facing stack is also up — run both side by side, because that is
the end-to-end check worth doing: the two services meet only in the database.

**Giving it a login** is the Users section on that same screen: type an email,
press **Create User**, and the password is generated and shown once. Copy it
there and then — dismissing the panel is the
only chance you get, and nothing can show it again. **Reset password** on a row
issues a fresh one the same way, and ends that User's live sessions, so a browser
already signed in at `http://<subdomain>.localhost:5173` drops to the sign-in form
on its next request. Signing into the Client SPA with a password the panel just
generated is the end-to-end check worth doing here.

**Changing its Plan** is the Plan section above Users. Ticking a platform on
applies immediately; ticking one off, or suspending, first states how many
Scheduled Posts it breaks and can be cancelled — cancelling is the case worth
clicking, since backing out must leave the Client exactly as it was. Give the
Client a Scheduled Post first (compose one in its SPA a few minutes out) or every
preview reads zero and proves nothing.

**That suspension actually suspends** is the end-to-end check this section exists
for, and it needs both stacks plus the worker:

1. Schedule a Post in the Client SPA, a couple of minutes out.
2. **Suspend** the Client in the panel, confirming past the preview.
3. The browser already signed in at `http://acme.localhost:5173` drops out on its
   next request, and signing in again says the access is suspended rather than
   that the password is wrong.
4. Let the scheduled time pass with `npm run dev:worker` running. The Post ends
   **Failed**, its Targets naming suspension — and the API log shows the tick
   counted it `blocked`, never `fired`. Nothing was sent to a Publisher at all.
5. **Restore to active** and schedule another. It fires normally, and nothing was
   deleted in between.

An **expired** Client behaves identically at every one of those steps; that they
are indistinguishable is the point, not an oversight.

**Its Branding** is the section below Users, and it is the only way to set
branding at all — the seeder leaves a Client on the neutral default. Set a
name and a color, press **Save Branding**, then reload
`http://<subdomain>.localhost:5173` **signed out** — the sign-in screen itself
carries them, which is the property worth seeing rather than the header after
login. **Use the default** on any row puts that field back with no session
involved on the Client side at all; the login screen then names nobody but the
Client.

**Its timezone** is the last section, beside the subdomain shown read-only. Give
the Client a Scheduled Post or two first (compose them in its SPA), then change
the zone: the confirmation lists each Post's time as it reads now and as it will
read, and **Cancel** must leave both the field and the Client exactly as they
were. Confirm one and open the Post in the Client SPA — its time reads
differently while the Post has not moved. Letting it fire with
`npm run dev:worker` running is the check that proves the second half: it goes
out at the same moment it always would have.

- The session is an httpOnly cookie, so `document.cookie` in the console is
  **expected to be empty** — that is the property, not a bug.
- If sign-in appears to succeed but the shell never loads, the browser is
  dropping the `Secure` cookie over plain HTTP. Set `ADMIN_INSECURE_COOKIE=true`
  and restart the admin API.
- Re-running `create-superadmin` for an existing email resets that password and
  ends that operator's live sessions — the lockout-recovery path, and the way to
  get back in after forgetting what you typed.
- Hitting it with curl needs a cookie jar, since there is no bearer token:
  ```bash
  curl -s -c /tmp/admin.jar -X POST http://localhost:3002/api/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"you@example.com","password":"..."}'
  curl -s -b /tmp/admin.jar http://localhost:3002/api/me
  ```

## Driving the OAuth connect flows against the fake

The fake Publisher's `authorizeUrl` points at `https://example.test/...`, so
clicking **Connect** for Facebook or TikTok leaves the app and the browser lands
on a Chrome error page. That is expected — it is the platform's consent screen
standing in. To come back the way a real User would, read the state the server
minted and navigate to the callback yourself:

```bash
docker exec socialmediamarketingautomation-postgres-1 \
  psql -U smma -d smma -t -A -c \
  "SELECT state, platform FROM oauth_states ORDER BY created_at DESC LIMIT 1;"
```

```
http://acme.localhost:5173/oauth/facebook/callback?state=<state>&code=fake-code
http://acme.localhost:5173/oauth/tiktok/callback?state=<state>&code=fake-code
```

Facebook then shows the Page choice; TikTok connects outright. **Instagram has no
callback** — it connects in place from the already-connected Page, so it is a
single click on the Connections screen (ADR 0005).

## Reshaping what the fake offers

`packages/server/src/core/fake-publisher.ts` — `DEFAULT_PAGE` is what an unscripted
fake returns, and editing it is how you reach a different branch locally (the API
hot-reloads on save). It ships with a linked Instagram account so the happy path
is clickable; drop the `instagram` field to see the convert-to-Business dead-end.

## Checking what actually landed

```bash
docker exec socialmediamarketingautomation-postgres-1 psql -U smma -d smma -c \
  "SELECT platform, status, external_id, display_name, credential IS NULL AS dropped
   FROM connected_accounts ORDER BY platform;"
```

`credential` must always read as `v1:<iv>:<ciphertext>` — never a legible token
(ADR 0006). After a completed handshake `oauth_states` must be empty: states are
single-use.

## Gotchas

- **`changeOrigin` in `packages/web/vite.config.ts` must stay `false`.** The API
  derives the tenant from Host; rewriting it to `localhost:3001` makes every
  request a 404 `unknown_client` and the SPA renders the neutral default with no
  obvious cause.
- Hitting the API directly with curl needs `-H "host: acme.localhost:5173"`.
  Without it you get `unknown_client`, not an auth error.
- The Meta deauthorization callback refuses everything when `META_APP_SECRET` is
  unset — it verifies a signature, and an empty secret is one anyone could sign
  with. It is not driveable locally; the behavioral suite covers it.
