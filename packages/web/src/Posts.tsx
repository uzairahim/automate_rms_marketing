import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  cancelScheduledPost,
  listPendingPosts,
  listPostHistory,
  publishPostNow,
  type PendingPost,
  type Post,
  type PostHistoryEntry,
  type PostTarget,
} from "./api.js";
import type { Session } from "./session.js";
import { formatInZone } from "./timezone.js";
import {
  EmptyNote,
  ErrorNote,
  MediaPreview,
  PlatformChip,
  PostStatusBadge,
  disabledStyle,
  linkButtonStyle,
  secondaryButtonStyle,
  sectionHeadingStyle,
} from "./ui.jsx";

/**
 * Everything this Client has written: what is still waiting, and what has been
 * sent (PRD stories 37–38, 46).
 *
 * Two lists, not one, because the two halves answer different questions and
 * offer different actions. A Scheduled Post or Draft is something a User can
 * still change — edit it, send it early, call it off — while a Post in history
 * has an outcome to inspect and, at most, a failed platform to retry. Merging
 * them into one feed would put "Edit" next to something already live on
 * Facebook.
 *
 * The waiting list comes first: it is the one with a deadline attached.
 */
export function Posts({
  session,
  onEdit,
  onOpen,
}: {
  session: Session;
  /** Open a Draft/Scheduled Post back in the composer. */
  onEdit: (postId: string) => void;
  /** Open a Post's outcome — its per-platform results and metrics. */
  onOpen: (postId: string) => void;
}) {
  const timeZone = session.client.timezone;

  const [pending, setPending] = useState<PendingPost[] | null>(null);
  const [history, setHistory] = useState<PostHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Both at once: a Post that just fired leaves one list for the other, and
    // fetching them in sequence would briefly show it in neither or in both.
    const [pendingPosts, historyPosts] = await Promise.all([
      listPendingPosts(),
      listPostHistory(),
    ]);
    setPending(pendingPosts);
    setHistory(historyPosts);
  }, []);

  useEffect(() => {
    void refresh().catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Could not load posts.");
    });
  }, [refresh]);

  /** Run one row's action, keeping that row busy and reporting what the API said. */
  async function run(postId: string, action: () => Promise<void>) {
    setBusy(postId);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not do that.");
    } finally {
      setBusy(null);
    }
  }

  function publishNow(postId: string) {
    return run(postId, async () => {
      await publishPostNow(postId);
      // Straight to the outcome: a User who just sent something wants to know
      // which platforms took it, not to be returned to a list it has left.
      onOpen(postId);
    });
  }

  function unschedule(postId: string) {
    return run(postId, async () => {
      await cancelScheduledPost(postId);
      await refresh();
    });
  }

  if (!pending || !history) {
    return error ? <ErrorNote>{error}</ErrorNote> : <p style={{ color: "#64748b" }}>Loading posts…</p>;
  }

  return (
    <div style={{ marginTop: "2rem", maxWidth: "38rem" }}>
      {error && <ErrorNote>{error}</ErrorNote>}

      <section>
        <h2 style={sectionHeadingStyle}>Scheduled and drafts</h2>
        {pending.length === 0 ? (
          <EmptyNote>Nothing waiting. Anything you schedule or save will show up here.</EmptyNote>
        ) : (
          <ul style={listStyle}>
            {pending.map((post) => (
              <li key={post.id} style={rowStyle}>
                <div style={{ display: "flex", alignItems: "baseline", gap: "0.625rem" }}>
                  <PostStatusBadge status={post.status} />
                  <span style={timeStyle}>
                    {post.scheduledAt
                      ? formatInZone(post.scheduledAt, timeZone)
                      : `Saved ${formatInZone(post.updatedAt, timeZone)}`}
                  </span>
                </div>

                <Excerpt post={post} />
                <Platforms targets={post.targets} />

                <div style={rowActionsStyle}>
                  <button
                    type="button"
                    onClick={() => onEdit(post.id)}
                    disabled={busy === post.id}
                    style={{ ...smallButtonStyle, ...disabledStyle(busy === post.id) }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void publishNow(post.id)}
                    disabled={busy === post.id}
                    style={{ ...smallButtonStyle, ...disabledStyle(busy === post.id) }}
                  >
                    {busy === post.id ? "Working…" : "Publish now"}
                  </button>
                  {post.status === "scheduled" && (
                    <button
                      type="button"
                      onClick={() => void unschedule(post.id)}
                      disabled={busy === post.id}
                      style={{ ...smallButtonStyle, ...disabledStyle(busy === post.id) }}
                    >
                      Cancel schedule
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: "2.5rem" }}>
        <h2 style={sectionHeadingStyle}>History</h2>
        {history.length === 0 ? (
          <EmptyNote>Nothing published yet.</EmptyNote>
        ) : (
          <ul style={listStyle}>
            {history.map((post) => (
              <li key={post.id} style={rowStyle}>
                <div style={{ display: "flex", gap: "0.875rem" }}>
                  {/* Fetched live from the platform, and null whenever it cannot be
                      (ADR 0003) — so the row is built to read without it. */}
                  {post.thumbnailUrl && (
                    <MediaPreview url={post.thumbnailUrl} type="image" size="4rem" />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: "0.625rem" }}>
                      <PostStatusBadge status={post.status} />
                      <span style={timeStyle}>{formatInZone(post.createdAt, timeZone)}</span>
                    </div>
                    <Excerpt post={post} />
                    <Platforms targets={post.targets} />
                  </div>
                </div>

                <div style={rowActionsStyle}>
                  <button type="button" onClick={() => onOpen(post.id)} style={linkButtonStyle}>
                    {/* Named for what is behind it, since the reason to open a
                        Post differs by status: a failure to fix, or numbers. */}
                    {post.status === "published" ? "View results" : "View and retry"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A Post's text, clamped to two lines — enough to recognize which Post this is. */
function Excerpt({ post }: { post: Post }) {
  if (!post.text) {
    return (
      <p style={{ ...excerptStyle, color: "#94a3b8", fontStyle: "italic" }}>
        {post.media ? "Media only, no text" : "Empty"}
      </p>
    );
  }
  return <p style={excerptStyle}>{post.text}</p>;
}

/** The platforms a Post fans out to. Empty is worth saying — it cannot be sent. */
function Platforms({ targets }: { targets: PostTarget[] }) {
  if (targets.length === 0) {
    return <p style={{ ...timeStyle, margin: 0 }}>No platforms selected yet</p>;
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
      {targets.map((target) => (
        <PlatformChip key={target.platform} platform={target.platform} />
      ))}
    </div>
  );
}

const listStyle = {
  listStyle: "none",
  padding: 0,
  margin: 0,
} as const;

const rowStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  padding: "1rem 0",
  borderBottom: "1px solid #e2e8f0",
} as const;

const rowActionsStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.625rem",
} as const;

const smallButtonStyle = {
  ...secondaryButtonStyle,
  padding: "0.25rem 0.75rem",
  fontSize: "0.875rem",
} as const;

const excerptStyle = {
  margin: 0,
  fontSize: "0.938rem",
  color: "#1e293b",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
} as const;

const timeStyle = {
  fontSize: "0.813rem",
  color: "#64748b",
} as const;
