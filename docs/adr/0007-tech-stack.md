# Tech stack: Fastify + Postgres + BullMQ, React/Vite SPA

## Context

The system is a multi-tenant, subdomain-routed white-label app with a background
worker running three recurring jobs (minute scheduler, token refresh, daily
metric snapshot), a relational data model, and outbound/inbound calls to
Meta/TikTok. The priority is minimal cost on a small VPS.

## Decision

- **Backend:** Node + TypeScript with **Fastify** (an HTTP API, not a
  full-stack/SSR framework).
- **Database:** **Postgres**.
- **Queue / background jobs:** **Redis + BullMQ** for the scheduler, token
  refresh, and metric-snapshot jobs.
- **Frontend:** **React + Vite SPA** for both the Client app and the `admin.`
  panel — static build served by nginx/CDN, talking to the Fastify API.
- **Public/legal pages** (marketing, Privacy Policy, Terms — required for Meta
  and TikTok app review): a small, separate static site, kept out of the app.

## Why

- We deliberately split the backend into a standalone Fastify API. Next.js's main
  advantages (SSR, its own API routes, full-stack-in-one) would duplicate that
  API and mean running two Node servers. The app lives behind a login, so SSR/SEO
  buys nothing for it.
- A React/Vite SPA compiles to static files — cheapest to host and the cleanest
  separation from the API. Subdomain white-label theming works by reading the
  subdomain and fetching the Client's branding from the API at load.
- BullMQ on Redis is the standard Node way to run the three recurring jobs the
  design already requires.

## Consequences

- Redis is an extra moving part (vs. a stack with a built-in queue), accepted as
  the cost of staying in Node/TS.
- Public/legal pages live in a separate deploy; don't pull SSR into the app just
  to serve them.
