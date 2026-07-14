# Daily metric snapshots for account-level analytics

## Context

The dashboard shows account-level analytics (follower growth, reach this month),
which requires trends over time. Platform APIs are inconsistent about history:
Facebook Page Insights gives real time-series, Instagram only ~30 days of
follower history, and TikTok's basic API returns mostly current values with no
series. Relying on native history alone yields a dashboard that looks rich for
Facebook and broken for TikTok.

Separately, per-post metrics are shown only on a Post's detail page and are
fetched live (one post at a time), so they need no storage.

## Decision

A daily background job snapshots a small set of account-level metrics per
Connected Account into a metrics table: followers, reach/impressions, total
engagement, and posts published. The dashboard renders trends from our own
stored snapshots. Audience demographics are deferred to v2.

## Why

It is the only way to get uniform, cross-platform trend lines and an instant
dashboard. Unlike Media, the data is tiny — a few numeric rows per account per
day — so the storage cost is negligible and does not conflict with the
minimal-cost goal. (This is the one place storing pays off; Media, which is
large, stays ephemeral per ADR-0003.)

## Consequences

- Trends only exist from the day snapshotting starts for an account; there is no
  backfill of history that predates the connection.
- Per-post analytics remain live-fetched and are intentionally not snapshotted.
