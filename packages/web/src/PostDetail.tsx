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
import type { Session } from "./session.js";
import { formatInZone } from "./timezone.js";
import {
  ErrorNote,
  MediaPreview,
  PostStatusBadge,
  TargetStatusBadge,
  cardStyle,
  disabledStyle,
  linkButtonStyle,
  secondaryButtonStyle,
  sectionHeadingStyle,
} from "./ui.jsx";

/**
 * One Post's outcome, platform by platform (PRD stories 39–46).
 *
 * The per-Target breakdown is the substance of this screen, because a Post does
 * not have *an* outcome: each Target publishes independently and a success is
 * never rolled back because a sibling failed (CONTEXT.md `Target`). So Facebook
 * saying "Published, here's the link" next to TikTok saying "Failed, retry" is
 * the normal case to render well, not an edge case.
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
      <section style={{ marginTop: "2rem" }}>
        <button type="button" onClick={onBack} style={linkButtonStyle}>
          ← Back to posts
        </button>
        {error ? <ErrorNote>{error}</ErrorNote> : <p style={{ color: "#64748b" }}>Loading…</p>}
      </section>
    );
  }

  const metricsFor = (platform: Platform) =>
    metrics?.find((entry) => entry.platform === platform)?.metrics ?? null;

  return (
    <section style={{ marginTop: "2rem", maxWidth: "38rem" }}>
      <button type="button" onClick={onBack} style={linkButtonStyle}>
        ← Back to posts
      </button>

      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginTop: "0.75rem" }}>
        <h2 style={{ ...sectionHeadingStyle, margin: 0 }}>Post</h2>
        <PostStatusBadge status={post.status} />
      </div>

      <p style={{ fontSize: "0.813rem", color: "#64748b", margin: "0.25rem 0 1rem" }}>
        {post.status === "scheduled" && post.scheduledAt
          ? `Scheduled for ${formatInZone(post.scheduledAt, timeZone)}`
          : `Created ${formatInZone(post.createdAt, timeZone)}`}
      </p>

      <div style={cardStyle}>
        {post.text ? (
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{post.text}</p>
        ) : (
          <p style={{ margin: 0, color: "#64748b", fontStyle: "italic" }}>No text</p>
        )}
        {post.media && (
          <div style={{ marginTop: "0.75rem" }}>
            <MediaPreview url={post.media.url} type={post.media.type} size="9rem" />
          </div>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {needsReupload && (
        <div role="alert" style={purgedStyle}>
          <p style={{ margin: 0 }}>
            The attached media was purged 24 hours after the failure, so there is nothing left to
            publish. Re-upload it, then retry.
          </p>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy === "upload"}
            style={{
              ...secondaryButtonStyle,
              alignSelf: "flex-start",
              ...disabledStyle(busy === "upload"),
            }}
          >
            {busy === "upload" ? "Uploading…" : "Re-upload media"}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,video/*"
            onChange={(e) => reupload(e.target.files?.[0])}
            style={{ display: "none" }}
          />
        </div>
      )}

      <h3 style={{ ...sectionHeadingStyle, fontSize: "0.938rem", margin: "1.5rem 0 0.5rem" }}>
        Platforms
      </h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {targets.map((target) => (
          <li key={target.platform} style={targetRowStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <strong style={{ fontSize: "0.938rem" }}>{PLATFORM_LABELS[target.platform]}</strong>
              <TargetStatusBadge status={target.status} />
              {/* An auto-retry that has already been scheduled — so a User waiting
                  on a pending Target knows something is still happening. */}
              {target.status === "pending" && target.retryCount > 0 && (
                <span style={{ fontSize: "0.813rem", color: "#64748b" }}>
                  retry {target.retryCount} of 2 queued
                </span>
              )}

              {target.status === "failed" && (
                <button
                  type="button"
                  onClick={() => void retry(target.platform)}
                  disabled={busy !== null}
                  style={{
                    ...secondaryButtonStyle,
                    padding: "0.25rem 0.75rem",
                    ...disabledStyle(busy !== null),
                  }}
                >
                  {busy === target.platform ? "Retrying…" : "Retry"}
                </button>
              )}
            </div>

            {target.error && <p style={targetErrorStyle}>{target.error}</p>}

            {target.permalink && (
              <a
                href={target.permalink}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: "0.813rem", color: "var(--brand-primary)" }}
              >
                View on {PLATFORM_LABELS[target.platform]}
              </a>
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

/**
 * One Target's live numbers. Every field is optional because the platforms
 * disagree on what they expose, and an absent one is left out rather than shown
 * as a zero — a fabricated 0 shares is a worse answer than no answer.
 */
function Metrics({ metrics, published }: { metrics: TargetMetrics["metrics"]; published: boolean }) {
  if (!published) return null;
  if (!metrics) {
    return (
      <p style={{ fontSize: "0.813rem", color: "#94a3b8", margin: "0.375rem 0 0" }}>
        Metrics unavailable right now.
      </p>
    );
  }

  const entries = [
    ["Likes", metrics.likes],
    ["Comments", metrics.comments],
    ["Shares", metrics.shares],
    ["Views", metrics.views],
  ].filter(([, value]) => typeof value === "number") as Array<[string, number]>;

  if (entries.length === 0) {
    return (
      <p style={{ fontSize: "0.813rem", color: "#94a3b8", margin: "0.375rem 0 0" }}>
        This platform reports no numbers for a post.
      </p>
    );
  }

  return (
    <dl style={metricsStyle}>
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt style={{ fontSize: "0.75rem", color: "#64748b" }}>{label}</dt>
          <dd style={{ margin: 0, fontSize: "0.938rem", fontWeight: 600 }}>
            {value.toLocaleString()}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const targetRowStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  padding: "0.875rem 0",
  borderBottom: "1px solid #e2e8f0",
} as const;

const targetErrorStyle = {
  margin: 0,
  fontSize: "0.813rem",
  color: "#b91c1c",
} as const;

const metricsStyle = {
  display: "flex",
  gap: "1.5rem",
  margin: "0.5rem 0 0",
} as const;

const purgedStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.625rem",
  padding: "0.875rem",
  marginTop: "1rem",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  borderRadius: "0.25rem",
  fontSize: "0.875rem",
} as const;
