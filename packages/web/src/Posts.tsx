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
  LoadingNote,
  MediaPreview,
  PlatformChip,
  PostStatusBadge,
  SectionHeading,
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
    return error ? <ErrorNote>{error}</ErrorNote> : <LoadingNote>Loading posts…</LoadingNote>;
  }

  return (
    <div>
      {error && <ErrorNote>{error}</ErrorNote>}

      <section>
        <SectionHeading eyebrow="Waiting" title="Scheduled and drafts" />

        {pending.length === 0 ? (
          <EmptyNote>Nothing waiting. Anything you schedule or save will show up here.</EmptyNote>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {pending.map((post) => (
              <li key={post.id} className="card p-5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <PostStatusBadge status={post.status} />
                  <span className="text-note text-muted">
                    {post.scheduledAt
                      ? formatInZone(post.scheduledAt, timeZone)
                      : `Saved ${formatInZone(post.updatedAt, timeZone)}`}
                  </span>
                </div>

                <div className="mt-3">
                  <Excerpt post={post} />
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <Platforms targets={post.targets} />

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onEdit(post.id)}
                      disabled={busy === post.id}
                      className="btn btn-secondary btn-sm"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void publishNow(post.id)}
                      disabled={busy === post.id}
                      className="btn btn-secondary btn-sm"
                    >
                      {busy === post.id ? "Working…" : "Publish now"}
                    </button>
                    {post.status === "scheduled" && (
                      <button
                        type="button"
                        onClick={() => void unschedule(post.id)}
                        disabled={busy === post.id}
                        className="btn btn-secondary btn-sm"
                      >
                        Cancel schedule
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-14">
        <SectionHeading eyebrow="Sent" title="History" />

        {history.length === 0 ? (
          <EmptyNote>Nothing published yet.</EmptyNote>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {history.map((post) => (
              <li key={post.id} className="card p-5">
                <div className="flex gap-4">
                  {/* Fetched live from the platform, and null whenever it cannot be
                      (ADR 0003) — so the row is built to read without it. */}
                  {post.thumbnailUrl && (
                    <MediaPreview url={post.thumbnailUrl} type="image" size="4.5rem" />
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <PostStatusBadge status={post.status} />
                      <span className="text-note text-muted">
                        {formatInZone(post.createdAt, timeZone)}
                      </span>
                    </div>

                    <div className="mt-3">
                      <Excerpt post={post} />
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <Platforms targets={post.targets} />
                      <button type="button" onClick={() => onOpen(post.id)} className="btn-link">
                        {/* Named for what is behind it, since the reason to open a
                            Post differs by status: a failure to fix, or numbers. */}
                        {post.status === "published" ? "View results" : "View and retry"}
                        <span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </div>
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
      <p className="m-0 text-body-sm italic text-faint">
        {post.media ? "Media only, no text" : "Empty"}
      </p>
    );
  }
  return <p className="m-0 line-clamp-2 text-body-md text-ink-strong">{post.text}</p>;
}

/** The platforms a Post fans out to. Empty is worth saying — it cannot be sent. */
function Platforms({ targets }: { targets: PostTarget[] }) {
  if (targets.length === 0) {
    return <p className="m-0 text-note text-muted">No platforms selected yet</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {targets.map((target) => (
        <PlatformChip key={target.platform} platform={target.platform} />
      ))}
    </div>
  );
}
