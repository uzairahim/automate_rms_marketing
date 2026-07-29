import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelScheduledPost,
  composePost,
  getPost,
  listConnections,
  publishPostNow,
  updatePost,
  uploadMedia,
  type ComposeInput,
  type ConnectedAccount,
  type Platform,
  type Post,
} from "./api.js";
import { primaryButtonStyle } from "./LoginScreen.jsx";
import { blockingReasons, PLATFORM_LABELS } from "./postRules.js";
import type { Session } from "./session.js";
import { nowInZoneInput, utcToZonedInput, zonedToUtc, zoneAbbreviation } from "./timezone.js";
import {
  ErrorNote,
  MediaPreview,
  cardStyle,
  fieldLabelStyle,
  inputStyle,
  disabledStyle,
  linkButtonStyle,
  secondaryButtonStyle,
  sectionHeadingStyle,
} from "./ui.jsx";

/**
 * Compose a Post once and send it to several platforms at once (PRD stories
 * 29–38; CONTEXT.md `Post`).
 *
 * The screen is built around the one thing that makes this app not three apps:
 * a single body of content, a single attachment, and a *set* of destinations —
 * so the text area is the page and the platforms are checkboxes beside it, not
 * three tabs to fill in separately.
 *
 * Three outcomes come off the same form, because they differ only in when:
 * publish now, schedule, or save as a Draft. A Draft is the one that is never
 * gated — a User is allowed to save something unfinished — so it stays available
 * even while the other two are refusing.
 *
 * The same component edits an existing Draft or Scheduled Post (`postId`), since
 * "finish the thing I started" is the same act as composing it. What differs is
 * only which API call each button makes.
 */

/** The attachment being composed with: an uploaded Media, or a Post's existing one. */
interface ComposingMedia {
  id: string;
  url: string;
  type: "image" | "video";
}

export function Composer({
  session,
  postId,
  onPublished,
  onSaved,
  onLeaveEdit,
}: {
  session: Session;
  /** An existing Draft/Scheduled Post to finish, or null to start a new one. */
  postId: string | null;
  /** A Post was sent — the caller shows its outcome, which is what to look at next. */
  onPublished: (id: string) => void;
  /** Saved for later (Draft or Scheduled), so the caller can show the list of those. */
  onSaved: () => void;
  /** Leave an edit without saving. */
  onLeaveEdit: () => void;
}) {
  const timeZone = session.client.timezone;

  const [connections, setConnections] = useState<ConnectedAccount[] | null>(null);
  const [loadingPost, setLoadingPost] = useState(postId !== null);
  /** The Post being edited, for the copy that depends on what it currently is. */
  const [editing, setEditing] = useState<Post | null>(null);

  const [text, setText] = useState("");
  const [selected, setSelected] = useState<Platform[]>([]);
  const [media, setMedia] = useState<ComposingMedia | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");

  const [busy, setBusy] = useState<null | "publish" | "schedule" | "draft" | "upload" | "cancel">(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  /**
   * Per-platform refusals from the API's 422, shown on the platform each belongs
   * to. Held separately from `error` because they are not one message — they are
   * a list of specific things to go fix.
   */
  const [serverReasons, setServerReasons] = useState<Partial<Record<Platform, string>>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    listConnections()
      .then((list) => {
        if (!cancelled) setConnections(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Could not load connected accounts.");
          setConnections([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the Post being finished. Its Targets *are* the platform selection: a
  // Draft's Targets exist from the moment it was saved, they have just never
  // been attempted.
  useEffect(() => {
    if (!postId) {
      setEditing(null);
      setLoadingPost(false);
      return;
    }

    let cancelled = false;
    setLoadingPost(true);
    getPost(postId)
      .then(({ post, targets }) => {
        if (cancelled) return;
        setEditing(post);
        setText(post.text);
        setSelected(targets.map((target) => target.platform));
        setMedia(
          post.media && post.mediaId
            ? { id: post.mediaId, url: post.media.url, type: post.media.type }
            : null,
        );
        setScheduling(post.scheduledAt !== null);
        setScheduleAt(post.scheduledAt ? utcToZonedInput(post.scheduledAt, timeZone) : "");
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not open that Post.");
      })
      .finally(() => {
        if (!cancelled) setLoadingPost(false);
      });

    return () => {
      cancelled = true;
    };
  }, [postId, timeZone]);

  const togglePlatform = (platform: Platform) => {
    setServerReasons({});
    setSelected((current) =>
      current.includes(platform)
        ? current.filter((p) => p !== platform)
        : [...current, platform],
    );
  };

  /** Run one action, keeping the form locked and surfacing whatever the API said. */
  const run = useCallback(
    async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
      setBusy(kind);
      setError(null);
      setServerReasons({});
      try {
        await action();
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message);
          if (err.reasons) setServerReasons(err.reasons);
        } else {
          setError("Something went wrong. Please try again.");
        }
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  function pickFile() {
    fileInput.current?.click();
  }

  function onFileChosen(file: File | undefined) {
    if (!file) return;
    void run("upload", async () => {
      const uploaded = await uploadMedia(file);
      setMedia({ id: uploaded.id, url: uploaded.url, type: uploaded.type });
    });
    // Cleared so choosing the same file twice still fires a change event.
    if (fileInput.current) fileInput.current.value = "";
  }

  /** What every one of the three actions sends, differing only in the timing fields. */
  const baseInput = (): Omit<ComposeInput, "draft" | "scheduledAt"> => ({
    text,
    platforms: selected,
    mediaId: media?.id ?? null,
  });

  function publishNow() {
    void run("publish", async () => {
      if (postId) {
        // Persist the edits first, as a Draft — that write is never gated, so a
        // User's changes are safely stored even if the publish is then refused
        // (a dead token, a purged attachment). Then send it.
        await updatePost(postId, { ...baseInput(), draft: true });
        await publishPostNow(postId);
        onPublished(postId);
        return;
      }
      const { post } = await composePost(baseInput());
      onPublished(post.id);
    });
  }

  function schedule() {
    void run("schedule", async () => {
      // Inside `run`, so an unparseable value surfaces as an error on the form
      // rather than an uncaught throw. The button guards against the empty case.
      const scheduledAt = zonedToUtc(scheduleAt, timeZone).toISOString();
      if (postId) {
        await updatePost(postId, { ...baseInput(), scheduledAt });
      } else {
        await composePost({ ...baseInput(), scheduledAt });
      }
      onSaved();
    });
  }

  function saveDraft() {
    void run("draft", async () => {
      if (postId) {
        await updatePost(postId, { ...baseInput(), draft: true });
      } else {
        await composePost({ ...baseInput(), draft: true });
      }
      onSaved();
    });
  }

  /** Un-schedule a Scheduled Post. It stays as a Draft — the content survives. */
  function cancelSchedule() {
    if (!postId) return;
    void run("cancel", async () => {
      await cancelScheduledPost(postId);
      onSaved();
    });
  }

  if (loadingPost || !connections) {
    return <p style={{ color: "#64748b" }}>Loading composer…</p>;
  }

  const blocking = blockingReasons(selected, media, connections);
  const reasonFor = (platform: Platform) => serverReasons[platform] ?? blocking[platform];
  const nothingSelected = selected.length === 0;
  // A Draft is deliberately exempt: saving unfinished work is the whole point of
  // one, so it stays clickable while the other two are blocked.
  const sendBlocked = nothingSelected || Object.keys(blocking).length > 0;
  const scheduleMissing = scheduling && !scheduleAt;
  const working = busy !== null;

  return (
    <section style={{ marginTop: "2rem", maxWidth: "38rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "1rem" }}>
        <h2 style={sectionHeadingStyle}>
          {editing ? (editing.status === "scheduled" ? "Edit scheduled post" : "Finish draft") : "New post"}
        </h2>
        {editing && (
          <button type="button" onClick={onLeaveEdit} style={linkButtonStyle}>
            Discard changes
          </button>
        )}
      </div>

      <label style={{ ...fieldLabelStyle, marginBottom: "1rem" }}>
        Post text
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="Write once — it goes to every platform you pick below."
          style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
        />
      </label>

      <MediaField
        media={media}
        uploading={busy === "upload"}
        inputRef={fileInput}
        onPick={pickFile}
        onChosen={onFileChosen}
        onRemove={() => setMedia(null)}
      />

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Publish to</legend>
        {connections.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: "0.875rem", margin: 0 }}>
            No platforms are available on this plan yet.
          </p>
        ) : (
          connections.map((connection) => {
            const isSelected = selected.includes(connection.platform);
            const reason = isSelected ? reasonFor(connection.platform) : null;
            return (
              <div key={connection.platform} style={{ padding: "0.375rem 0" }}>
                <label style={checkboxRowStyle}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => togglePlatform(connection.platform)}
                  />
                  <span>{PLATFORM_LABELS[connection.platform]}</span>
                  {connection.status === "connected" && connection.displayName && (
                    <span style={{ color: "#64748b", fontSize: "0.813rem" }}>
                      {connection.displayName}
                    </span>
                  )}
                </label>
                {/* The reason sits on the platform it is about, so a User reading
                    "TikTok requires a video" is looking at the TikTok row. */}
                {reason && <p style={reasonStyle}>{reason}</p>}
              </div>
            );
          })
        )}
      </fieldset>

      <div style={{ ...cardStyle, marginTop: "1rem" }}>
        <label style={checkboxRowStyle}>
          <input
            type="checkbox"
            checked={scheduling}
            onChange={(e) => setScheduling(e.target.checked)}
          />
          <span>Schedule for later</span>
        </label>

        {scheduling && (
          <label style={{ ...fieldLabelStyle, marginTop: "0.75rem" }}>
            {/* The zone is named, because it is the Client's and not the
                browser's: the same wall-clock time means different instants to a
                User travelling, and guessing wrong publishes at the wrong hour. */}
            Date and time ({timeZone} · {zoneAbbreviation(timeZone)})
            <input
              type="datetime-local"
              value={scheduleAt}
              min={nowInZoneInput(timeZone)}
              onChange={(e) => setScheduleAt(e.target.value)}
              style={inputStyle}
            />
          </label>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {nothingSelected && (
        <p style={{ ...reasonStyle, marginTop: "0.75rem" }}>
          Pick at least one platform to publish or schedule. You can still save a draft.
        </p>
      )}

      <div style={actionsStyle}>
        {scheduling ? (
          <button
            type="button"
            onClick={schedule}
            disabled={working || sendBlocked || scheduleMissing}
            style={{
              ...primaryButtonStyle,
              marginTop: 0,
              ...disabledStyle(working || sendBlocked || scheduleMissing),
            }}
          >
            {busy === "schedule" ? "Scheduling…" : editing ? "Save schedule" : "Schedule"}
          </button>
        ) : (
          <button
            type="button"
            onClick={publishNow}
            disabled={working || sendBlocked}
            style={{ ...primaryButtonStyle, marginTop: 0, ...disabledStyle(working || sendBlocked) }}
          >
            {busy === "publish" ? "Publishing…" : "Publish now"}
          </button>
        )}

        <button
          type="button"
          onClick={saveDraft}
          disabled={working}
          style={{ ...secondaryButtonStyle, ...disabledStyle(working) }}
        >
          {busy === "draft" ? "Saving…" : "Save as draft"}
        </button>

        {editing?.status === "scheduled" && (
          <button
            type="button"
            onClick={cancelSchedule}
            disabled={working}
            style={{ ...secondaryButtonStyle, ...disabledStyle(working) }}
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel schedule"}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The attachment field. Media is what decides whether Instagram and TikTok can
 * be published to at all, so it shows the type it uploaded as ("Video") rather
 * than just a filename — that word is the difference between TikTok accepting
 * this Post and refusing it.
 */
function MediaField({
  media,
  uploading,
  inputRef,
  onPick,
  onChosen,
  onRemove,
}: {
  media: ComposingMedia | null;
  uploading: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  onPick: () => void;
  onChosen: (file: File | undefined) => void;
  onRemove: () => void;
}) {
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        {media && <MediaPreview url={media.url} type={media.type} />}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
          <strong style={{ fontSize: "0.875rem" }}>
            {media ? (media.type === "video" ? "Video attached" : "Image attached") : "No media"}
          </strong>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button
              type="button"
              onClick={onPick}
              disabled={uploading}
              style={{ ...linkButtonStyle, ...disabledStyle(uploading) }}
            >
              {uploading ? "Uploading…" : media ? "Replace" : "Attach image or video"}
            </button>
            {media && (
              <button
                type="button"
                onClick={onRemove}
                disabled={uploading}
                style={{ ...linkButtonStyle, ...disabledStyle(uploading) }}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        onChange={(e) => onChosen(e.target.files?.[0])}
        style={{ display: "none" }}
      />
    </div>
  );
}

const fieldsetStyle = {
  marginTop: "1rem",
  padding: "0.75rem 1rem 1rem",
  border: "1px solid #e2e8f0",
  borderRadius: "0.375rem",
} as const;

const legendStyle = {
  padding: "0 0.375rem",
  fontSize: "0.813rem",
  color: "#475569",
} as const;

const checkboxRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.938rem",
  cursor: "pointer",
} as const;

const reasonStyle = {
  margin: "0.25rem 0 0 1.5rem",
  color: "#b45309",
  fontSize: "0.813rem",
} as const;

const actionsStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.75rem",
  marginTop: "1.25rem",
} as const;
