# Multi-tenant cloud deployment, not per-client local installs

## Context

The brief originally called for installing a separate copy of the app on each
Client's own computer to keep hosting cost near zero, plus a global database for
a Superadmin to suspend access on non-payment.

## Decision

We run a single multi-tenant cloud deployment. Each Client is isolated by a
Client ID and reached at its own subdomain (`client.ourapp.com`). The Superadmin
suspends access via a flag on the Client record.

## Why

Scheduled posting, OAuth callbacks, token refresh, and platform webhooks all
require an always-on server with a public HTTPS URL. A machine that is asleep or
offline cannot fire an 8pm scheduled post or receive a Meta redirect. A local
desktop install cannot guarantee any of this, so a central always-on server is
required regardless — which is already ~90% of the multi-tenant design.

The cost saving of local installs (~$10/month of VPS hosting) is outweighed by
lost scheduling reliability plus the cost of manually updating and supporting N
separate machines. One small VPS serves the whole local-market client base for
roughly $8–15/month total.
