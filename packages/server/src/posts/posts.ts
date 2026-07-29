import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { Platform } from "../core/publisher.js";
import type { ComposedMedia } from "./validation.js";

/**
 * The Post/Target store (CONTEXT.md `Post`, `Target`).
 *
 * A Post is authored once and fans out to one Target per selected platform.
 * Each Target's outcome is recorded independently — a successful Target is
 * never rolled back because another failed — and {@link rollupStatus} derives
 * the Post's own status from the Targets underneath it, rather than the Post
 * carrying an independent status a caller could let drift out of sync.
 */

/**
 * `draft`/`scheduled` arrive with Slice 10 — nothing here produces them yet,
 * but the vocabulary is CONTEXT.md's in full so the type never needs revisiting.
 * `publishing` covers a Post with any Target still `pending` (including one
 * awaiting an auto-retry); `published`/`partially_published`/`failed` are the
 * terminal roll-ups once every Target has settled (see {@link rollupStatus}).
 */
export const POST_STATUSES = [
  "draft",
  "scheduled",
  "publishing",
  "published",
  "partially_published",
  "failed",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/**
 * Smaller than a Post's: a Target only ever *becomes* `pending` (freshly
 * created, or scheduled for an auto-retry after a failure) and then settles
 * once, terminally, into `published` or `failed`.
 */
export const TARGET_STATUSES = ["pending", "published", "failed"] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

export interface Post {
  id: string;
  clientId: string;
  authorId: string;
  text: string;
  media: ComposedMedia | null;
  /** The attached Media's id (Slice 9), if any — what the purge job keys off. */
  mediaId: string | null;
  status: PostStatus;
  /** UTC. Set only while `scheduled`; rendered in the Client's timezone by the caller. */
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Target {
  id: string;
  postId: string;
  platform: Platform;
  status: TargetStatus;
  externalId: string | null;
  permalink: string | null;
  error: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  updatedAt: string;
}

interface PostRow {
  id: string;
  client_id: string;
  author_id: string;
  text: string;
  media_url: string | null;
  media_type: string | null;
  media_id: string | null;
  status: string;
  scheduled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface TargetRow {
  id: string;
  post_id: string;
  platform: string;
  status: string;
  external_id: string | null;
  permalink: string | null;
  error: string | null;
  retry_count: number;
  next_retry_at: Date | null;
  updated_at: Date;
}

const POST_COLUMNS = `id, client_id, author_id, text, media_url, media_type, media_id, status, scheduled_at, created_at, updated_at`;
const TARGET_COLUMNS = `id, post_id, platform, status, external_id, permalink, error, retry_count, next_retry_at, updated_at`;

function postFromRow(row: PostRow): Post {
  return {
    id: row.id,
    clientId: row.client_id,
    authorId: row.author_id,
    text: row.text,
    media:
      row.media_url && row.media_type
        ? { url: row.media_url, type: row.media_type as "image" | "video" }
        : null,
    mediaId: row.media_id,
    status: row.status as PostStatus,
    scheduledAt: row.scheduled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function targetFromRow(row: TargetRow): Target {
  return {
    id: row.id,
    postId: row.post_id,
    platform: row.platform as Platform,
    status: row.status as TargetStatus,
    externalId: row.external_id,
    permalink: row.permalink,
    error: row.error,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Create a Post and its Targets — one per selected platform, all `pending`.
 *
 * `status` decides what happens next, not this function: `publishing` is fanned
 * out immediately by the caller, `scheduled` waits for the scheduler's due-query
 * to find it, and `draft` waits for a User to finish and either schedule or
 * publish it. A Scheduled/Draft Post's Targets still exist from the moment of
 * creation — they carry the platform selection — but are never attempted until
 * the Post leaves that state.
 */
export async function createPost(
  pool: pg.Pool,
  clock: Clock,
  input: {
    clientId: string;
    authorId: string;
    text: string;
    media: ComposedMedia | null;
    mediaId: string | null;
    platforms: readonly Platform[];
    status: PostStatus;
    scheduledAt: Date | null;
  },
): Promise<{ post: Post; targets: Target[] }> {
  const now = clock.now().toISOString();
  const { rows } = await pool.query<PostRow>(
    `INSERT INTO posts (client_id, author_id, text, media_url, media_type, media_id, status, scheduled_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING ${POST_COLUMNS}`,
    [
      input.clientId,
      input.authorId,
      input.text,
      input.media?.url ?? null,
      input.media?.type ?? null,
      input.mediaId,
      input.status,
      input.scheduledAt?.toISOString() ?? null,
      now,
    ],
  );
  const post = postFromRow(rows[0]!);

  const targets: Target[] = [];
  for (const platform of input.platforms) {
    const { rows: targetRows } = await pool.query<TargetRow>(
      `INSERT INTO targets (post_id, platform, status, updated_at)
       VALUES ($1, $2, 'pending', $3)
       RETURNING ${TARGET_COLUMNS}`,
      [post.id, platform, now],
    );
    targets.push(targetFromRow(targetRows[0]!));
  }
  return { post, targets };
}

/**
 * A Client's Post history (PRD story 46): every Post it has actually sent, newest
 * first. A `draft`/`scheduled` Post is deliberately excluded — history is what a
 * User *published*, not what they are still composing or waiting to fire; the
 * remaining statuses (`publishing`/`published`/`partially_published`/`failed`)
 * are exactly the Posts that have left the composer and have a Target outcome to
 * show. Scoped to the Client, like every other read here.
 */
export async function listPostHistory(pool: pg.Pool, clientId: string): Promise<Post[]> {
  const { rows } = await pool.query<PostRow>(
    `SELECT ${POST_COLUMNS} FROM posts
     WHERE client_id = $1 AND status NOT IN ('draft', 'scheduled')
     ORDER BY created_at DESC`,
    [clientId],
  );
  return rows.map(postFromRow);
}

/**
 * The Posts a User is still working on: every Draft and Scheduled Post this
 * Client holds — the exact complement of {@link listPostHistory}, which shows
 * only what has already left the composer.
 *
 * Without this a Draft is write-only. It has no Target outcome, so history will
 * never list it, and its id is the only way back to it — which the composer has
 * no way to have kept.
 *
 * Soonest-due first, so a Scheduled Post about to fire sits at the top; Drafts
 * have no fire time at all and follow, most recently touched first.
 */
export async function listPendingPosts(pool: pg.Pool, clientId: string): Promise<Post[]> {
  const { rows } = await pool.query<PostRow>(
    `SELECT ${POST_COLUMNS} FROM posts
     WHERE client_id = $1 AND status IN ('draft', 'scheduled')
     ORDER BY scheduled_at ASC NULLS LAST, updated_at DESC`,
    [clientId],
  );
  return rows.map(postFromRow);
}

/** A Post scoped to a Client — never lets one Client read another's Post. */
export async function findPost(
  pool: pg.Pool,
  clientId: string,
  postId: string,
): Promise<Post | null> {
  const { rows } = await pool.query<PostRow>(
    `SELECT ${POST_COLUMNS} FROM posts WHERE id = $1 AND client_id = $2`,
    [postId, clientId],
  );
  const row = rows[0];
  return row ? postFromRow(row) : null;
}

/** A Post's Targets, in the order they were created (platform fan-out order). */
export async function listTargets(pool: pg.Pool, postId: string): Promise<Target[]> {
  const { rows } = await pool.query<TargetRow>(
    `SELECT ${TARGET_COLUMNS} FROM targets WHERE post_id = $1 ORDER BY updated_at ASC, platform ASC`,
    [postId],
  );
  return rows.map(targetFromRow);
}

/** One Target of a Post, by platform. */
export async function findTarget(
  pool: pg.Pool,
  postId: string,
  platform: Platform,
): Promise<Target | null> {
  const { rows } = await pool.query<TargetRow>(
    `SELECT ${TARGET_COLUMNS} FROM targets WHERE post_id = $1 AND platform = $2`,
    [postId, platform],
  );
  const row = rows[0];
  return row ? targetFromRow(row) : null;
}

/** Targets whose scheduled auto-retry is due, across every Post — the job's query. */
export async function findDueTargets(pool: pg.Pool, asOf: Date): Promise<Target[]> {
  const { rows } = await pool.query<TargetRow>(
    `SELECT ${TARGET_COLUMNS} FROM targets
     WHERE status = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at <= $1
     ORDER BY next_retry_at ASC`,
    [asOf.toISOString()],
  );
  return rows.map(targetFromRow);
}

/** Scheduled Posts whose fire time has arrived — the scheduler's due-query. */
export async function findDuePosts(pool: pg.Pool, asOf: Date): Promise<Post[]> {
  const { rows } = await pool.query<PostRow>(
    `SELECT ${POST_COLUMNS} FROM posts
     WHERE status = 'scheduled' AND scheduled_at <= $1
     ORDER BY scheduled_at ASC`,
    [asOf.toISOString()],
  );
  return rows.map(postFromRow);
}

/** Persist the outcome of one publish attempt against a Target. */
export async function recordTargetOutcome(
  pool: pg.Pool,
  clock: Clock,
  targetId: string,
  outcome: {
    status: TargetStatus;
    externalId: string | null;
    permalink: string | null;
    error: string | null;
    retryCount: number;
    nextRetryAt: Date | null;
  },
): Promise<Target> {
  const { rows } = await pool.query<TargetRow>(
    `UPDATE targets SET
       status        = $2,
       external_id   = $3,
       permalink     = $4,
       error         = $5,
       retry_count   = $6,
       next_retry_at = $7,
       updated_at    = $8
     WHERE id = $1
     RETURNING ${TARGET_COLUMNS}`,
    [
      targetId,
      outcome.status,
      outcome.externalId,
      outcome.permalink,
      outcome.error,
      outcome.retryCount,
      outcome.nextRetryAt?.toISOString() ?? null,
      clock.now().toISOString(),
    ],
  );
  return targetFromRow(rows[0]!);
}

/** The Post status derived from its Targets' outcomes (CONTEXT.md `Post status`). */
export function rollupStatus(targetStatuses: readonly TargetStatus[]): PostStatus {
  if (targetStatuses.some((status) => status === "pending")) return "publishing";
  const publishedCount = targetStatuses.filter((status) => status === "published").length;
  if (publishedCount === targetStatuses.length) return "published";
  if (publishedCount === 0) return "failed";
  return "partially_published";
}

/**
 * Re-upload after purge (ADR 0003): attach a freshly uploaded Media to a Post
 * so a manual retry can proceed. Replaces whatever Media the Post previously
 * pointed to — the purge job keys off `media_id`, so once this returns, the
 * old (purged) Media is no longer this Post's concern.
 */
export async function attachMedia(
  pool: pg.Pool,
  clock: Clock,
  postId: string,
  input: { mediaId: string; media: ComposedMedia },
): Promise<Post> {
  const { rows } = await pool.query<PostRow>(
    `UPDATE posts SET media_id = $2, media_url = $3, media_type = $4, updated_at = $5
     WHERE id = $1
     RETURNING ${POST_COLUMNS}`,
    [postId, input.mediaId, input.media.url, input.media.type, clock.now().toISOString()],
  );
  return postFromRow(rows[0]!);
}

/**
 * Persist a Post's roll-up status, recomputed from its current Targets.
 *
 * Always called with a status {@link rollupStatus} derives from Target
 * outcomes (`publishing`/`published`/`partially_published`/`failed`) — never
 * `draft`/`scheduled` — so `scheduled_at` is unconditionally cleared here too:
 * once a Post has left `scheduled` for good, its schedule is no longer live
 * (`Post.scheduledAt` is documented as "set only while scheduled").
 */
export async function updatePostStatus(
  pool: pg.Pool,
  clock: Clock,
  postId: string,
  status: PostStatus,
): Promise<void> {
  await pool.query(
    `UPDATE posts SET status = $2, scheduled_at = NULL, updated_at = $3 WHERE id = $1`,
    [postId, status, clock.now().toISOString()],
  );
}

/**
 * Overwrite a Draft or Scheduled Post's content wholesale (Slice 10) — editing
 * before it fires (PRD stories 36–38). The caller (the route) is the only place
 * that enforces the Post is still `draft`/`scheduled`; this is a plain write.
 */
export async function updatePostContent(
  pool: pg.Pool,
  clock: Clock,
  postId: string,
  input: {
    text: string;
    media: ComposedMedia | null;
    mediaId: string | null;
    status: PostStatus;
    scheduledAt: Date | null;
  },
): Promise<Post> {
  const { rows } = await pool.query<PostRow>(
    `UPDATE posts SET
       text         = $2,
       media_url    = $3,
       media_type   = $4,
       media_id     = $5,
       status       = $6,
       scheduled_at = $7,
       updated_at   = $8
     WHERE id = $1
     RETURNING ${POST_COLUMNS}`,
    [
      postId,
      input.text,
      input.media?.url ?? null,
      input.media?.type ?? null,
      input.mediaId,
      input.status,
      input.scheduledAt?.toISOString() ?? null,
      clock.now().toISOString(),
    ],
  );
  return postFromRow(rows[0]!);
}

/**
 * Replace a Post's platform selection wholesale. Only meaningful before any
 * Target has been attempted (a Draft or Scheduled Post's edit) — a plain
 * delete-and-recreate is safe there because nothing has a publish outcome yet
 * worth preserving.
 */
export async function replaceTargets(
  pool: pg.Pool,
  clock: Clock,
  postId: string,
  platforms: readonly Platform[],
): Promise<void> {
  const now = clock.now().toISOString();
  await pool.query(`DELETE FROM targets WHERE post_id = $1`, [postId]);
  for (const platform of platforms) {
    await pool.query(
      `INSERT INTO targets (post_id, platform, status, updated_at) VALUES ($1, $2, 'pending', $3)`,
      [postId, platform, now],
    );
  }
}
