# Encrypt platform tokens at rest; hash passwords

## Context

We store OAuth access/refresh tokens for every Client's Facebook Page, Instagram,
and TikTok account. Those tokens grant full publishing control over the Clients'
social presence — they are the crown-jewel data. We also hold the single Meta and
TikTok app secrets, and User login passwords. Security is an explicit top
priority.

## Decision

- **Platform tokens and app secrets** are encrypted at rest with authenticated
  application-level encryption (e.g. AES-256-GCM). The encryption key lives
  **outside the database** — in an environment variable / secrets manager on the
  server — never in the repo or the same DB.
- **User passwords** are hashed with argon2 (or bcrypt), never reversibly
  encrypted.
- App secrets and the encryption key are provided via environment / secrets
  manager, never committed.
- TLS everywhere in transit.

## Why

A database dump alone must be useless. Plaintext tokens in a leaked DB would
compromise every Client's social accounts simultaneously. Keeping the key out of
the DB means an attacker needs both the dump and the server's key.

## Consequences

- Tokens cannot be queried/filtered by value (never needed).
- **If the encryption key is lost, every Client must reconnect all their social
  accounts** — key custody and backup is an operational responsibility.
- Rotating the key requires re-encrypting stored tokens.
