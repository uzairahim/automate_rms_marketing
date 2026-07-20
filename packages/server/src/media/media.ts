import type pg from "pg";
import type { Clock } from "../core/clock.js";
import type { PostStatus } from "../posts/posts.js";
import { deleteMediaFile } from "./storage.js";

/**
 * The Media store and retention rule (ADR 0003; CONTEXT.md `Media`).
 *
 * Uploaded image/video lives on this server's disk only as long as publishing
 * needs it: deleted immediately once every Target of the Post it is attached
 * to is `Published`, or kept 24 hours after a partial/total failure so the
 * User can manually retry before it is purged. {@link settleMediaForPost} is
 * the single place that decision is made, called every time a Post's Target
 * roll-up is recomputed — it must key off *all* Targets terminal, never a
 * first success, or a manual retry would be stranded.
 */

export const MEDIA_TYPES = ["image", "video"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const MEDIA_STATUSES = ["active", "purged"] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** How long a partial/total failure retains Media before it is purged. */
export const MEDIA_PURGE_DELAY_MS = 24 * 60 * 60 * 1000;

export interface Media {
  id: string;
  clientId: string;
  type: MediaType;
  storageKey: string;
  contentType: string;
  byteSize: number;
  status: MediaStatus;
  purgeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MediaRow {
  id: string;
  client_id: string;
  type: string;
  storage_key: string;
  content_type: string;
  byte_size: string | number;
  status: string;
  purge_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const MEDIA_COLUMNS = `id, client_id, type, storage_key, content_type, byte_size, status, purge_at, created_at, updated_at`;

function mediaFromRow(row: MediaRow): Media {
  return {
    id: row.id,
    clientId: row.client_id,
    type: row.type as MediaType,
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    status: row.status as MediaStatus,
    purgeAt: row.purge_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The URL Meta/TikTok fetch a Media at — always this API's own origin (ADR 0003). */
export function mediaPublicUrl(mediaBaseUrl: string, mediaId: string): string {
  return `${mediaBaseUrl}/api/media/${mediaId}`;
}

/** Persist an already-written file's row. The caller writes the file first. */
export async function createMedia(
  pool: pg.Pool,
  clock: Clock,
  input: {
    id: string;
    clientId: string;
    type: MediaType;
    storageKey: string;
    contentType: string;
    byteSize: number;
  },
): Promise<Media> {
  const now = clock.now().toISOString();
  const { rows } = await pool.query<MediaRow>(
    `INSERT INTO media (id, client_id, type, storage_key, content_type, byte_size, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)
     RETURNING ${MEDIA_COLUMNS}`,
    [input.id, input.clientId, input.type, input.storageKey, input.contentType, input.byteSize, now],
  );
  return mediaFromRow(rows[0]!);
}

/** A Media scoped to a Client — never lets one Client reference another's upload. */
export async function findMedia(
  pool: pg.Pool,
  clientId: string,
  mediaId: string,
): Promise<Media | null> {
  const { rows } = await pool.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media WHERE id = $1 AND client_id = $2`,
    [mediaId, clientId],
  );
  return rows[0] ? mediaFromRow(rows[0]) : null;
}

/** A Media by id, unscoped — the public serve route: the platform fetches it, not a Client session. */
export async function findMediaById(pool: pg.Pool, mediaId: string): Promise<Media | null> {
  const { rows } = await pool.query<MediaRow>(`SELECT ${MEDIA_COLUMNS} FROM media WHERE id = $1`, [
    mediaId,
  ]);
  return rows[0] ? mediaFromRow(rows[0]) : null;
}

/** The Media currently attached to a Post, if any. */
export async function findMediaForPost(pool: pg.Pool, postId: string): Promise<Media | null> {
  const { rows } = await pool.query<MediaRow>(
    `SELECT media.id, media.client_id, media.type, media.storage_key, media.content_type,
            media.byte_size, media.status, media.purge_at, media.created_at, media.updated_at
     FROM media
     JOIN posts ON posts.media_id = media.id
     WHERE posts.id = $1`,
    [postId],
  );
  return rows[0] ? mediaFromRow(rows[0]) : null;
}

/** Delete a Media's file and mark it purged. Idempotent-safe: the file may already be gone. */
async function purgeMedia(
  pool: pg.Pool,
  clock: Clock,
  mediaDir: string,
  media: Media,
): Promise<void> {
  await deleteMediaFile(mediaDir, media.storageKey);
  await pool.query(`UPDATE media SET status = 'purged', updated_at = $2 WHERE id = $1`, [
    media.id,
    clock.now().toISOString(),
  ]);
}

/**
 * Set a Media's purge time, once. Kept idempotent under repeated settling
 * (e.g. a failed manual retry re-settling an already-scheduled Media) — the
 * original failure's 24-hour window is never pushed out.
 */
async function scheduleMediaPurge(
  pool: pg.Pool,
  clock: Clock,
  mediaId: string,
  purgeAt: Date,
): Promise<void> {
  await pool.query(
    `UPDATE media SET purge_at = $2, updated_at = $3 WHERE id = $1 AND purge_at IS NULL`,
    [mediaId, purgeAt.toISOString(), clock.now().toISOString()],
  );
}

/**
 * Apply the retention rule for a Post's Media once its Target roll-up is
 * recomputed. A Post still `publishing` (any Target non-terminal) has no
 * effect here — the caller passes the freshly rolled-up status every time, so
 * this only ever acts once every Target has settled.
 */
export async function settleMediaForPost(
  pool: pg.Pool,
  clock: Clock,
  mediaDir: string,
  postId: string,
  postStatus: PostStatus,
): Promise<void> {
  if (postStatus !== "published" && postStatus !== "partially_published" && postStatus !== "failed") {
    return;
  }

  const media = await findMediaForPost(pool, postId);
  if (!media || media.status !== "active") return;

  if (postStatus === "published") {
    await purgeMedia(pool, clock, mediaDir, media);
  } else {
    await scheduleMediaPurge(pool, clock, media.id, new Date(clock.now().getTime() + MEDIA_PURGE_DELAY_MS));
  }
}

/** Media whose scheduled purge is due — the purge job's due-query. Returns how many were purged. */
export async function purgeDueMedia(pool: pg.Pool, clock: Clock, mediaDir: string): Promise<number> {
  const { rows } = await pool.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media
     WHERE status = 'active' AND purge_at IS NOT NULL AND purge_at <= $1`,
    [clock.now().toISOString()],
  );
  for (const row of rows) {
    await purgeMedia(pool, clock, mediaDir, mediaFromRow(row));
  }
  return rows.length;
}
