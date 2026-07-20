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
  server/   Fastify API + BullMQ worker + DB + core seams (Publisher, Clock)
  web/      React + Vite SPA
docker-compose.yml   Postgres + Redis for local dev
```

The API and worker share one package (`@smma/server`) with two entrypoints
(`src/api.ts`, `src/worker.ts`) so they share domain code and the DB layer.

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
npm test        # server behavioral + unit suite (Vitest)
npm run typecheck
```

The suite is self-contained: it uses **Testcontainers** to spin up ephemeral
Postgres and Redis, so it only needs a running Docker daemon — no manual DB
setup. CI runs `typecheck` + `test` on every push/PR (see
[.github/workflows/ci.yml](.github/workflows/ci.yml)).
