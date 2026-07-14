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

Open <http://localhost:5173> — it renders the API health status read from
Postgres. `POST /api/health/enqueue` enqueues a job the worker records in
`job_runs`, proving the queue round-trip.

Run migrations standalone with `npm run migrate`.

## Test

```bash
npm test        # server behavioral + unit suite (Vitest)
npm run typecheck
```

The suite is self-contained: it uses **Testcontainers** to spin up ephemeral
Postgres and Redis, so it only needs a running Docker daemon — no manual DB
setup. CI runs `typecheck` + `test` on every push/PR (see
[.github/workflows/ci.yml](.github/workflows/ci.yml)).
