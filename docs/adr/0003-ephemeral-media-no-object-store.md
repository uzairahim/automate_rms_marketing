# Ephemeral media on the app server; no long-term media store

## Context

Instagram (and our TikTok flow) require a publicly reachable media URL to
publish. The obvious design is a durable object store (R2/B2) keeping every
Client's media indefinitely so post history can show it. The priority is minimal
cost.

## Decision

Media lives on the app server only for as long as publishing needs it, served
over HTTPS to give Meta/TikTok the public URL:

- All Targets `Published` → delete the Media immediately.
- Partial failure (some Targets `Failed` after auto-retries) → keep the Media for
  24 hours so the User can manually retry, then purge it. Retrying after purge
  requires re-uploading the Media.

Post history does not read from stored Media. It shows a thumbnail fetched from
the **platform's authenticated API**, keyed on the post/media ID returned at
publish time and using the Connected Account's stored token. (This supersedes an
earlier idea of scraping Open Graph tags, which is unreliable for Instagram
without authentication — we already hold an authenticated token, so we use it.)

## Why

Avoids an object-store dependency and its ongoing cost, and keeps disk usage flat
— matching the minimal-cost goal. The permalink already exists for every
successfully published Target, so its OG image is a free source of the history
thumbnail.

## Consequences

- The Media-delete job must key off *all Targets terminal*, never first success,
  or manual retries would be stranded.
- We permanently store the post/media ID for each published Target. The thumbnail
  URL the API returns is a temporary signed URL — never persist it; re-fetch on
  demand (with a short cache) when rendering history, subject to platform rate
  limits.
- If a thumbnail fetch fails or is rate-limited, history degrades to a
  text/status-only card — acceptable.
- If clients later demand reliable in-app media history, revisit with a real
  object store (the Publisher/upload seam makes this swappable).
