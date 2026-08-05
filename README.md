# Social Media Marketing Automation

White-label, multi-tenant SaaS: compose a Post once and publish it to Facebook,
Instagram, and TikTok — immediately or scheduled — with account-level analytics.
See [CONTEXT.md](CONTEXT.md) for the domain language and [PRD #1](../../issues/1)
for the product spec. Architecture decisions live in [docs/adr/](docs/adr/).

## Status

**Slice 1 — foundation walking skeleton.** The full stack (Fastify API,
Postgres, BullMQ worker on Redis, React/Vite SPA) boots together with one
end-to-end path (a health value read from Postgres, rendered in the SPA) and the
project's three **test seams** are established as reusable harness:

1. Drive the **Fastify HTTP API** as a real client against a **test Postgres**.
2. A **fake `Publisher`** (ADR 0002) records what would be sent per platform and
   is scripted to succeed/fail — no real Meta/TikTok calls in tests.
3. An **injected `Clock`** makes time-dependent logic testable without waiting.

## Layout

```
packages/
  core/     What a Client is: provisioning, Plan, Branding, passwords, eligibility
  server/   Fastify API + BullMQ worker + DB + core seams (Publisher, Clock)
  web/      React + Vite SPA — the Client-facing app
  admin/    The Superadmin service: its own Fastify API + its own React/Vite SPA
docker-compose.yml   Postgres + Redis for local dev
```

The API and worker share one package (`@smma/server`) with two entrypoints
(`src/api.ts`, `src/worker.ts`) so they share domain code and the DB layer.

`@smma/admin` is a **separate deployable** (ADR 0010), so the code that can
suspend every Client is not running in the internet-facing process that
terminates OAuth callbacks and receives Meta's webhooks. It talks to the same
Postgres, applies its own migrations (named `admin_*`, sharing the one
`schema_migrations` table), and requires nothing but `DATABASE_URL` — no Redis,
and deliberately not the token-encryption key.

`@smma/server` has **no administrative routes at all**, and there is no shared
operator secret anywhere in the platform. Nothing reachable on a Client's
subdomain can provision a Client, issue a credential, or change anyone's access
— not because a guard refuses it, but because that code is a different process.
The `admin.` label stays reserved so no Client can claim it, and serves nothing.

`@smma/core` holds the tenancy and credential modules that more than one
deployable needs (ADR 0010) — it depends on nothing but `pg` and `bcryptjs`.
It compiles to `dist/`, so every root script that runs the server (`build`,
`typecheck`, `dev`, `migrate`, `seed`) builds it first, and `npm run dev` also
watches it. `npm test` is the exception: Vitest is aliased to core's sources, so
a test run can never pass against a stale compile.

## Prerequisites

- Node 22+ and npm
- Docker (for local Postgres/Redis, and for the test suite via Testcontainers)

## Run it locally

```bash
npm install
cp .env.example .env        # defaults match docker-compose ports
npm run dev                 # boots Postgres + Redis + API + worker + web
```

`npm run dev` runs everything concurrently:

- Postgres (`localhost:55432`) and Redis (`localhost:56379`) via Docker Compose
- API on `localhost:3001` (migrations run automatically on boot)
- Worker consuming the `health` queue
- SPA on `localhost:5173` (proxies `/api` to the API)

Open <http://localhost:5173> — the SPA renders the Client's branding, a login
screen, and (once signed in) the Client's Connected Accounts. `GET /api/health`
and `POST /api/health/enqueue` still prove the API → Postgres and queue
round-trips.

Run migrations standalone with `npm run migrate`.

### The admin panel

The Superadmin panel runs under its own command, because it is its own
deployable — `npm run dev` is unchanged and does not start it:

```bash
npm run create-superadmin      # prompts for a password; also the way back in
npm run dev:admin              # admin API on :3002, admin SPA on :5174
```

Open <http://localhost:5174> and sign in with the account the CLI just made.

`create-superadmin` never takes the password as an argument, so it does not land
in your shell history. Re-running it for an email that already exists **resets
that password** and ends that operator's live sessions, which is how a locked-out
operator gets back in — there is no email reset flow and no bootstrap
environment variable.

The operator's session is an httpOnly, `Secure`, `SameSite=Strict` cookie, not a
token the SPA holds: it can suspend every Client on the platform, so a single
injection flaw in the panel must not be able to read it. That also means the
panel must be served **same-origin with its own API** (the Vite dev server
proxies `/api` to `:3002`). If your browser refuses the cookie over plain HTTP,
set `ADMIN_INSECURE_COOKIE=true` — local development only.

The development seeder is unaffected: `npm run seed` still produces a working
Client and login without the panel.

### Connecting accounts without a Meta or TikTok app

With `META_APP_ID`/`META_APP_SECRET` unset, the app wires the **fake
`Publisher`** instead of the real Graph API transport, so the whole connect flow
is clickable end-to-end locally without reaching Facebook (the same shape as the
console email sender). `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET` do the same for
TikTok. The choice is **per platform**, because approval is: Meta and TikTok are
two reviews on two timelines, so a deployment with real Facebook/Instagram and a
faked TikTok is a supported state, not a broken one. Set the credentials to build
against a real test Page / the TikTok sandbox while review is pending — see
[docs/platform-app-setup.md](docs/platform-app-setup.md).

Facebook and Instagram share one Meta app, one login, and one transport, because
on Meta's side they are one thing: an Instagram Business account is a property of
a Page and publishes with that Page's token (ADR 0005). So Instagram has no
"connect with Instagram" button that leaves the app — you connect the Page, then
connect the account it links to.

`TOKEN_ENCRYPTION_KEY` is **required** (ADR 0006): platform tokens are encrypted
at rest with a key that lives outside the database. `.env.example` ships a
dev-only key — generate a real one for anything else, and note that **losing the
key forces every Client to reconnect every social account**.

## Test

```bash
npm test        # both services' behavioral + unit suites (Vitest)
npm run typecheck
```

The suite is self-contained: it uses **Testcontainers** to spin up ephemeral
Postgres and Redis, so it only needs a running Docker daemon — no manual DB
setup. CI runs `typecheck` + `test` on every push/PR (see
[.github/workflows/ci.yml](.github/workflows/ci.yml)).
