# Social Media Marketing Automation

A white-label SaaS that lets a business compose a single post and publish it to
Facebook, Instagram, and TikTok at once — immediately or scheduled — and see
analytics for what it published. The platform operator provisions accounts;
there is no public signup.

## Language

**Client**:
A business that uses the app under its own white-label branding, reached at its
own subdomain. The unit of tenant isolation, billing, and access control. Has a
single timezone that all of its scheduling and analytics are anchored to, and
connects at most one account per platform (one Facebook Page, one Instagram, one
TikTok).
_Avoid_: Tenant, Organization, Account, Company

**Superadmin**:
The platform operator (us). A single global role that provisions Clients and
their Users, and can suspend a Client's access (e.g. on non-payment or plan
expiry). Operates from its own `admin.` subdomain — a surface separate from every
Client subdomain but backed by the same shared database.
_Avoid_: Owner, Root, Admin

**User**:
A person who logs into a Client to compose, schedule, and review posts.
Provisioned by the Superadmin — there is no self-signup. Logs in with email +
password on the Client's subdomain. A User belongs to exactly one Client, and an
email is globally unique across the whole platform — the same email can never
belong to two Clients.
_Avoid_: Member, Account, Operator

**Connected Account**:
A social destination a Client has linked via OAuth — specifically a Facebook
Page, an Instagram Business/Creator account (linked to that Page), or a TikTok
account. Never a personal Facebook profile or personal Instagram account, which
the platform APIs cannot publish to at all.
_Avoid_: Channel, Integration, Social Login, Profile

**Plan**:
The Superadmin-configured bundle for a Client: which platforms it may use (e.g.
TikTok only), plus its access status (active, suspended, expired). Gates both
what the Client can do and whether it can log in at all. Payment is handled
manually off-platform — there is no payment gateway; the Superadmin flips the
access status by hand on non-payment or expiry.
_Avoid_: Subscription, Tier, Package, Entitlement, Feature flag

**Branding**:
The Superadmin-configured white-label look of a Client: its logo, primary color,
and app display name. A strict 1:1 with the Client. Resolved from the subdomain
and applied by the Client SPA at load — including on the login screen, before
anyone authenticates — so the app feels like the Client's own tool and shows no
operator identity anywhere on a Client surface. A Client that sets nothing falls
back to a neutral default that names no operator.
_Avoid_: Theme, Skin, White-label config, Customization

**Post**:
A single piece of content a User composes once and sends to one or more of the
Client's Connected Accounts together — immediately or at a scheduled time. Its
content must satisfy the rules of *every* targeted platform before it can be
scheduled (e.g. a targeted TikTok requires a video). One Post fans out to
multiple platforms but is authored once.
_Avoid_: Update, Content, Message, Publication

**Target**:
One Connected Account a Post is being sent to. A Post has one Target per selected
platform. Each Target publishes independently and ends `Published` (with the
platform's post ID/permalink) or `Failed`. A failed Target is retried
automatically twice at 1-minute intervals, then left for the User to retry. A
success is never rolled back because another Target failed.
_Avoid_: Destination, Channel, Recipient

**Media**:
The image or video attached to a Post. Stored on our own server only as long as
it is needed to publish: deleted immediately once every Target is `Published`, or
kept 24 hours after a partial failure so the User can manually retry the failed
Target before it is purged. After purge, retrying a failed Target requires
re-uploading the Media. Post history shows a thumbnail fetched from the
platform's authenticated API using the post/media ID returned at publish time —
not from stored Media. We keep the durable post/media ID; the thumbnail URL
itself is a temporary signed URL that must be re-fetched on demand.
_Avoid_: Asset, Attachment, File

**Metric Snapshot**:
A daily record of a Connected Account's account-level numbers — followers,
reach/impressions, engagement, posts published — stored so the dashboard can
show trends over time. Distinct from per-post metrics, which are live-fetched on
a Post's detail page and never stored.
_Avoid_: Stat, Insight, Report, Analytics record

**Post status**:
A summary of a Post's Target outcomes: `Published` (all Targets succeeded),
`Partially Published` (some succeeded, some failed), or `Failed` (all failed).
Alongside these: `Draft`, `Scheduled`, and `Publishing`.
_Avoid_: Sent, Complete, Done
