import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  attachMediaToPost,
  getPost,
  getPostMetrics,
  retryTarget,
  uploadMedia,
  type Platform,
  type Post,
  type PostTarget,
  type TargetMetrics,
} from "./api.js";
import { PLATFORM_LABELS } from "./postRules.js";
import { compactNumber } from "./charts.jsx";
import type { Session } from "./session.js";
import { formatInZone } from "./timezone.js";
import {
  ErrorNote,
  LoadingNote,
  MediaPreview,
  PlatformTile,
  PostStatusBadge,
  TargetStatusBadge,
} from "./ui.jsx";

/**
 * One Post's outcome, platform by platform (PRD stories 39–46).
 *
 * The per-Target breakdown is the substance of this screen, because a Post does
 * not have *an* outcome: each Target publishes independently and a success is
 * never rolled back because a sibling failed (CONTEXT.md `Target`). So Facebook
 * saying "Published, here's the link" next to TikTok saying "Failed, retry" is
 * the normal case to render well, not an edge case — which is why each Target
 * gets its own card rather than a row in a shared table.
 *
 * Two things are fetched separately and deliberately. The Post itself is a cheap
 * DB read, which is what makes it safe to poll while Targets are still settling.
 * Per-post metrics are live platform round-trips that are never stored
 * (CONTEXT.md `Metric Snapshot`), so they are fetched once, after the Post has
 * stopped moving.
 */

/** How often a still-publishing Post is re-read while its Targets settle. */
const POLL_INTERVAL_MS = 3000;

export function PostDetail({
  session,
  postId,
  onBack,
}: {
  session: Session;
  postId: string;
  onBack: () => void;
}) {
  const timeZone = session.client.timezone;

  const [post, setPost] = useState<Post | null>(null);
  const [targets, setTargets] = useState<PostTarget[]>([]);
  const [metrics, setMetrics] = useState<TargetMetrics[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Platform | "upload" | null>(null);
  /**
   * Set when a retry was refused because the Media has been purged (ADR 0003):
   * 24 hours after a partial failure the file is gone, and retrying needs a
   * re-upload first. Its own state because it is not a failure to report and
   * dismiss — it is an action the User now has to take.
   */
  const [needsReupload, setNeedsReupload] = useState(false);
  /**
   * Bumped whenever a Target's outcome changes under us — a manual retry that
   * succeeded. Metrics were already fetched by then, and nothing else in their
   * dependencies moves (the Post is still settled, something is still published),
   * so without this a newly-published Target would keep showing the "unavailable"
   * it had while it was still failed.
   */
  const [outcomeRevision, setOutcomeRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const { post: fresh, targets: freshTargets } = await getPost(postId);
    setPost(fresh);
    setTargets(freshTargets);
    return fresh;
  }, [postId]);

  useEffect(() => {
    let cancelled = false;
    setPost(null);
    setMetrics(null);
    setNeedsReupload(false);
    load().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load that Post.");
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Poll only while something is still in flight. A Post reaches `publishing`
  // when a Target failed and is waiting on its automatic retry a minute out, so
  // this is what turns "we're on it" into the final answer without a reload.
  useEffect(() => {
    if (post?.status !== "publishing") return;

    const timer = setInterval(() => {
      void load().catch(() => {
        /* A failed poll is not worth reporting — the next one may well work. */
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [post?.status, load]);

  // Metrics once the Post has settled and something actually published. Skipped
  // entirely otherwise: there is nothing on any platform to read numbers from.
  const settled = post !== null && post.status !== "publishing";
  const anyPublished = targets.some((target) => target.status === "published");

  useEffect(() => {
    if (!settled || !anyPublished) return;

    let cancelled = false;
    getPostMetrics(postId)
      .then((result) => {
        if (!cancelled) setMetrics(result.targets);
      })
      .catch(() => {
        // Metrics are an enrichment; the outcome above stands without them.
      });
    return () => {
      cancelled = true;
    };
  }, [postId, settled, anyPublished, outcomeRevision]);

  async function retry(platform: Platform) {
    setBusy(platform);
    setError(null);
    setNeedsReupload(false);
    try {
      const result = await retryTarget(postId, platform);
      setPost(result.post);
      setTargets(result.targets);
      setOutcomeRevision((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiError && err.code === "media_purged") {
        setNeedsReupload(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not retry that platform.");
      }
    } finally {
      setBusy(null);
    }
  }

  function reupload(file: File | undefined) {
    if (!file) return;
    setBusy("upload");
    setError(null);
    void (async () => {
      try {
        const uploaded = await uploadMedia(file);
        const { post: updated } = await attachMediaToPost(postId, uploaded.id);
        setPost(updated);
        setNeedsReupload(false);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not attach that file.");
      } finally {
        setBusy(null);
        if (fileInput.current) fileInput.current.value = "";
      }
    })();
  }

  if (!post) {
    return (
      <section>
        <BackLink onBack={onBack} />
        {error ? <ErrorNote>{error}</ErrorNote> : <LoadingNote>Loading…</LoadingNote>}
      </section>
    );
  }

  const metricsFor = (platform: Platform) =>
    metrics?.find((entry) => entry.platform === platform)?.metrics ?? null;

  return (
    <section>
      <BackLink onBack={onBack} />

      <div className="mb-5 mt-5 flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-display-sm text-ink">Post</h2>
        <PostStatusBadge status={post.status} />
        <span className="text-note text-muted">
          {post.status === "scheduled" && post.scheduledAt
            ? `Scheduled for ${formatInZone(post.scheduledAt, timeZone)}`
            : `Created ${formatInZone(post.createdAt, timeZone)}`}
        </span>
      </div>

      <div className="card p-5">
        {post.text ? (
          <p className="m-0 whitespace-pre-wrap text-body-md text-ink-strong">{post.text}</p>
        ) : (
          <p className="m-0 text-body-md italic text-muted">No text</p>
        )}
        {post.media && (
          <div className="mt-4">
            <MediaPreview url={post.media.url} type={post.media.type} size="9rem" />
          </div>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {needsReupload && (
        <div role="alert" className="callout mt-4">
          <p className="m-0">
            The attached media was purged 24 hours after the failure, so there is nothing left to
            publish. Re-upload it, then retry.
          </p>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy === "upload"}
            className="btn btn-secondary btn-sm self-start"
          >
            {busy === "upload" ? "Uploading…" : "Re-upload media"}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,video/*"
            onChange={(e) => reupload(e.target.files?.[0])}
            className="hidden"
          />
        </div>
      )}

      <h3 className="mb-4 mt-10 text-overline uppercase text-muted">Platforms</h3>

      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {targets.map((target) => (
          <li key={target.platform} className="card p-5">
            <div className="flex flex-wrap items-center gap-3">
              <PlatformTile platform={target.platform} size="sm" />
              <strong className="text-title-sm text-ink">
                {PLATFORM_LABELS[target.platform]}
              </strong>
              <TargetStatusBadge status={target.status} />

              {/* An auto-retry that has already been scheduled — so a User waiting
                  on a pending Target knows something is still happening. */}
              {target.status === "pending" && target.retryCount > 0 && (
                <span className="text-note text-muted">
                  retry {target.retryCount} of 2 queued
                </span>
              )}

              {target.status === "failed" && (
                <button
                  type="button"
                  onClick={() => void retry(target.platform)}
                  disabled={busy !== null}
                  className="btn btn-secondary btn-sm ml-auto"
                >
                  {busy === target.platform ? "Retrying…" : "Retry"}
                </button>
              )}

              {target.permalink && (
                <a
                  href={target.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-link ml-auto"
                >
                  View on {PLATFORM_LABELS[target.platform]}
                  <span aria-hidden="true">↗</span>
                </a>
              )}
            </div>

            {target.error && (
              <p className="m-0 mt-3 text-body-sm text-[#a72020]">{target.error}</p>
            )}

            {/* Only once the Post has settled: before that no metrics have been
                asked for, and "unavailable" would be a claim about the platform
                rather than what it is — a read this screen has not made yet. */}
            {settled && (
              <Metrics
                metrics={metricsFor(target.platform)}
                published={target.status === "published"}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} className="btn-link btn-quiet">
      <span aria-hidden="true">←</span> Back to posts
    </button>
  );
}

/**
 * One Target's live numbers, as a row of stat tiles.
 *
 * A row of headline figures rather than a chart: there are at most four values,
 * no time axis and no prior period to compare against, so a chart would be
 * decoration around numbers that are already the whole story. The figures wear
 * ink rather than the platform's color — color here would imply an encoding
 * that does not exist.
 *
 * Every field is optional because the platforms disagree on what they expose,
 * and an absent one is left out rather than shown as a zero — a fabricated
 * 0 shares is a worse answer than no answer.
 */
function Metrics({ metrics, published }: { metrics: TargetMetrics["metrics"]; published: boolean }) {
  if (!published) return null;
  if (!metrics) {
    return <p className="m-0 mt-3 text-note text-faint">Metrics unavailable right now.</p>;
  }

  const entries = [
    ["Likes", metrics.likes],
    ["Comments", metrics.comments],
    ["Shares", metrics.shares],
    ["Views", metrics.views],
  ].filter(([, value]) => typeof value === "number") as Array<[string, number]>;

  if (entries.length === 0) {
    return (
      <p className="m-0 mt-3 text-note text-faint">This platform reports no numbers for a post.</p>
    );
  }

  return (
    <dl className="m-0 mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {entries.map(([label, value]) => (
        <div key={label} className="card-soft px-3.5 py-3">
          <dt className="text-note text-muted">{label}</dt>
          <dd className="m-0 mt-0.5 text-title-lg font-semibold text-ink">
            {compactNumber(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
