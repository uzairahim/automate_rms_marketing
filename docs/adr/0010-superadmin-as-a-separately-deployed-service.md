# Superadmin as a separately deployed service

## Context

Since Slice 2 the Superadmin API has lived inside `@smma/server` as
`routes/admin.ts`, in the same Fastify process that serves every Client. Access
is gated by two checks: the request must resolve to the `admin.` surface, and it
must carry a shared bearer secret read from the environment.

Neither check is as strong as it looks.

- **The surface check is routing, not a boundary.** `resolveSurface` reads the
  `Host` header, which is supplied by the caller. Anyone who can reach the Client
  API can send `Host: admin.ourapp.com`; the 404 on a Client subdomain protects
  nobody who is willing to change one header. The shared secret is the only real
  gate.
- **The shared secret cannot be operated.** It has no owner, so nothing is
  attributable — "who expired this Client?" has no answer. It cannot be revoked
  for one person, and rotating it is a redeploy.

Meanwhile the process holding those routes is the most exposed one we run: it
terminates OAuth callbacks, accepts media uploads, and receives Meta's webhooks.
A single auth-bypass bug anywhere in it sits in the same address space as
"suspend any Client" and "create a User inside any Client".

The coupling that would make a split expensive turns out not to exist. The
modules the admin surface needs — `tenancy/clients`, `plan`, `branding`,
`subdomain`, `errors`, `auth/passwords` — import nothing but `pg` and
`bcryptjs`. No Publisher, no Redis/BullMQ, no Clock, no media, no cipher.

## Decision

The Superadmin becomes its own deployable:

- `packages/core` — the tenancy and password modules both surfaces share.
- `packages/server` — the Client API and worker. **Loses the admin routes and
  the `superadminToken` dep entirely.**
- `packages/admin` — a standalone Fastify API plus its own SPA, deployable to a
  different host. Its only required configuration is `DATABASE_URL`.

**Each service owns the migrations for the tables only it reads and writes.**
`@smma/server` owns `clients`, `users`, `posts` and the rest; `@smma/admin` owns
`superadmins` and `admin_sessions`. Both lists apply through the existing
name-keyed runner and share one `schema_migrations` table, distinguished by an
`admin_` name prefix. This is safe precisely because a Superadmin belongs to no
Client: its two tables carry no foreign key into the server's schema, so the two
lists have nothing to order against and either service can migrate an empty
database by itself.

The Superadmin also stops being a secret and becomes a person: a `superadmins`
row (email + bcrypt hash) with its own `admin_sessions`, created by a CLI
(`create-superadmin`), never by a deploy-time env var. `users.client_id` and
`sessions.user_id` stay `NOT NULL` — a Superadmin is not a User with a hole in
it, and no tenant-scoped query needs re-auditing for a null tenant.

Both services talk to the **same Postgres**. ADR 0001's single shared database is
unchanged; this splits the process, not the data.

## Why

The boundary becomes physical. Code that can suspend a Client is not merely
guarded in the public process — it is not running there. That is a property a
header check can never provide, and it survives bugs in the code that *is*
exposed.

Giving the Superadmin a real identity is what makes the operator role
administrable at all: per-person revocation, a password that can change without a
redeploy, and a subject to attribute actions to if we ever want an audit trail.

Extracting `packages/core` rather than duplicating the SQL keeps one definition of
what a Client is. Two services encoding the same tables would drift the first time
a column changed, and the drift would surface as a provisioning bug in
production rather than a type error at build time.

Keeping migrations owned by `@smma/server` alone avoids two writers racing to
mutate one schema — the failure mode that makes shared-database architectures
unpleasant.

## Consequences

- **The `admin.` label stops carrying security weight.** It is where the
  operator's SPA is served, nothing more. The admin service should not be exposed
  on the public internet at all if it can be avoided (IP allowlist or private
  network); its safety no longer rests on a header.
- **Server tests lose their provisioning path.** Fourteen suites currently drive
  `/api/admin/*` to set up a Client and User. They call `@smma/core`'s
  `createClient`/`createUser` directly instead. This is the better shape anyway:
  provisioning is *setup* for the publishing and scheduling suites, never the
  behavior under assertion.
- **The admin service needs its own test suite**, with its own Testcontainers
  Postgres. The three seams from Slice 1 do not all apply — it has no Publisher
  and no queue — so it inherits the API-against-real-Postgres seam only.
- **Two deployment units instead of one.** A schema change that both consume must
  ship in an order that keeps the older one working, exactly as with any
  shared-database pair of services.
- The admin API is same-origin with its own SPA, so it uses an httpOnly
  `SameSite=Strict` session cookie and a closed CORS policy — deliberately unlike
  the Client SPA's `localStorage` bearer token and `origin: true`. The credential
  is platform-wide; it should not be readable by script.
