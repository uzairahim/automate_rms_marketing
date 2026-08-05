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

There is no signup — the Superadmin provisions everything, on the `admin.` host.
Branding is a **separate PATCH**; passing `appName` to the create call is silently
ignored.

Paste this whole block — it captures the Client id into `$CID` for the calls that
need it:

```bash
ADMIN=(-H "host: admin.localhost" -H "authorization: Bearer dev-superadmin-token-change-me"
       -H "content-type: application/json")

# 1. Client — all three platforms enabled
CID=$(curl -s -X POST http://localhost:3001/api/admin/clients "${ADMIN[@]}" \
  -d '{"subdomain":"acme","timezone":"America/New_York","plan":{"facebook":true,"instagram":true,"tiktok":true}}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

# 2. User
curl -s -X POST "http://localhost:3001/api/admin/clients/$CID/users" "${ADMIN[@]}" \
  -d '{"email":"user@acme.test","password":"correct horse battery"}'

# 3. Branding — separate from step 1, which silently ignores an appName
curl -s -X PATCH "http://localhost:3001/api/admin/clients/$CID/branding" "${ADMIN[@]}" \
  -d '{"appName":"Acme Social","primaryColor":"#0F766E"}'
```

Then log in at `http://acme.localhost:5173` — `*.localhost` resolves to 127.0.0.1
with no `/etc/hosts` entry needed.

## The admin panel (`@smma/admin`)

A **separate deployable** (ADR 0010) with its own API, its own SPA, and its own
migrations — not part of `npm run dev`, and it needs neither Redis nor any of the
platform credentials. Verify a change to it on its own stack:

```bash
docker compose up -d          # Postgres only is enough for this one
npm run create-superadmin     # prompts for the password (twice); email as an optional arg
npm run dev:admin             # admin API :3002, admin SPA :5174 (proxies /api to :3002)
```

Sign in at <http://localhost:5174> with the account the CLI just made. There is
no Host-header tenancy here: the admin service has no Client to resolve, so any
host reaches it.

**Provisioning a Client from the panel** is the other way to do step 1 above, and
the one to use when the change is to the panel itself: **Add a Client**, give it a
subdomain and a timezone, tick its platforms, and you land on that Client's screen.
The Client is immediately reachable at `http://<subdomain>.localhost:5173` if the
Client-facing stack is also up — which is the end-to-end check worth doing, since
the two services only meet in the database.

Its Users, Plan, and Branding are still curl-only (the panel's sections for them
land in later slices), so a Client provisioned in the panel still needs step 2's
call to get a login.

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
