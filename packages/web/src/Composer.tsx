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
import { blockingReasons, PLATFORM_LABELS } from "./postRules.js";
import type { Session } from "./session.js";
import { nowInZoneInput, utcToZonedInput, zonedToUtc, zoneAbbreviation } from "./timezone.js";
import {
  ErrorNote,
  LoadingNote,
  MediaPreview,
  PlatformTile,
  SectionHeading,
} from "./ui.jsx";

/**
 * Compose a Post once and send it to several platforms at once (PRD stories
 * 29–38; CONTEXT.md `Post`).
 *
 * The screen is built around the one thing that makes this app not three apps:
 * a single body of content, a single attachment, and a *set* of destinations —
 * so the text area is the page and the platforms are checkboxes beside it, not
 * three tabs to fill in separately. The two-column layout says the same thing
 * spatially: what you are writing on the left, where it is going on the right,
 * both visible at once.
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
    return <LoadingNote>Loading composer…</LoadingNote>;
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
    <section>
      <SectionHeading
        eyebrow={editing ? "Editing" : "Compose"}
        title={
          editing
            ? editing.status === "scheduled"
              ? "Edit scheduled post"
              : "Finish draft"
            : "New post"
        }
      >
        {editing && (
          <button type="button" onClick={onLeaveEdit} className="btn-link btn-quiet">
            Discard changes
          </button>
        )}
      </SectionHeading>

      <div className="grid items-start gap-5 lg:grid-cols-[1.35fr_1fr]">
        {/* What is being written. Given the wider column because it is the
            thing being made; everything on the right is a decision about it. */}
        <div className="card overflow-hidden">
          <label className="block px-5 pt-5">
            <span className="field-label">Post text</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={9}
              placeholder="Write once — it goes to every platform you pick."
              // Borderless so the card itself reads as the sheet being written
              // on, but the focus ring is deliberately left alone: the base
              // `:focus-visible` outline is the only thing telling a keyboard
              // User where they are.
              className="mt-2 w-full resize-y rounded-md bg-transparent text-body-md text-ink placeholder:text-faint"
            />
          </label>

          <hr className="rule-soft mx-5" />

          <MediaField
            media={media}
            uploading={busy === "upload"}
            inputRef={fileInput}
            onPick={pickFile}
            onChosen={onFileChosen}
            onRemove={() => setMedia(null)}
          />
        </div>

        {/* Where it goes, and when. */}
        <div className="flex flex-col gap-5">
          {/* A browser places a `legend` at the fieldset's top *border* edge,
              above its padding — so the padding is moved onto the legend
              itself, else the label sits on the card's edge. */}
          <fieldset className="card m-0 border-0 px-5 pb-5 pt-0">
            <legend className="block p-0 pt-5 text-overline uppercase text-muted">
              Publish to
            </legend>

            {connections.length === 0 ? (
              <p className="m-0 mt-3 text-body-sm text-muted">
                No platforms are available on this plan yet.
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-1">
                {connections.map((connection) => {
                  const isSelected = selected.includes(connection.platform);
                  const reason = isSelected ? reasonFor(connection.platform) : null;
                  return (
                    <div key={connection.platform}>
                      <label className="pick-row" data-selected={isSelected}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => togglePlatform(connection.platform)}
                          className="checkbox"
                        />
                        <PlatformTile platform={connection.platform} size="sm" />
                        <span className="flex min-w-0 flex-col">
                          <span className="text-title-sm text-ink">
                            {PLATFORM_LABELS[connection.platform]}
                          </span>
                          {connection.status === "connected" && connection.displayName && (
                            <span className="truncate text-note text-muted">
                              {connection.displayName}
                            </span>
                          )}
                        </span>
                      </label>
                      {/* The reason sits on the platform it is about, so a User reading
                          "TikTok requires a video" is looking at the TikTok row. */}
                      {reason && (
                        <p className="m-0 mb-1 ml-[3.75rem] mt-1 text-note text-[#85560a]">
                          {reason}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </fieldset>

          <div className="card p-5">
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={scheduling}
                onChange={(e) => setScheduling(e.target.checked)}
                className="checkbox"
              />
              <span className="text-title-sm text-ink">Schedule for later</span>
            </label>

            {scheduling && (
              <label className="field mt-4 animate-rise">
                {/* The zone is named, because it is the Client's and not the
                    browser's: the same wall-clock time means different instants to a
                    User travelling, and guessing wrong publishes at the wrong hour. */}
                <span className="field-label">
                  Date and time
                  <span className="ml-1.5 font-normal text-muted">
                    {timeZone} · {zoneAbbreviation(timeZone)}
                  </span>
                </span>
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  min={nowInZoneInput(timeZone)}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  className="input"
                />
              </label>
            )}
          </div>

          {error && <ErrorNote>{error}</ErrorNote>}

          {nothingSelected && (
            <p className="m-0 text-note text-muted">
              Pick at least one platform to publish or schedule. You can still save a draft.
            </p>
          )}

          <div className="flex flex-wrap gap-2.5">
            {scheduling ? (
              <button
                type="button"
                onClick={schedule}
                disabled={working || sendBlocked || scheduleMissing}
                className="btn btn-primary"
              >
                {busy === "schedule" ? "Scheduling…" : editing ? "Save schedule" : "Schedule"}
              </button>
            ) : (
              <button
                type="button"
                onClick={publishNow}
                disabled={working || sendBlocked}
                className="btn btn-primary"
              >
                {busy === "publish" ? "Publishing…" : "Publish now"}
              </button>
            )}

            <button
              type="button"
              onClick={saveDraft}
              disabled={working}
              className="btn btn-secondary"
            >
              {busy === "draft" ? "Saving…" : "Save as draft"}
            </button>

            {editing?.status === "scheduled" && (
              <button
                type="button"
                onClick={cancelSchedule}
                disabled={working}
                className="btn btn-secondary"
              >
                {busy === "cancel" ? "Cancelling…" : "Cancel schedule"}
              </button>
            )}
          </div>
        </div>
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
    <div className="flex items-center gap-4 p-5">
      {media ? (
        <MediaPreview url={media.url} type={media.type} size="4.5rem" />
      ) : (
        // An empty slot rather than nothing, so the field has the same shape
        // whether or not something is attached and the row never jumps.
        <span
          aria-hidden="true"
          className="grid size-[4.5rem] shrink-0 place-items-center rounded-lg bg-surface-card text-faint"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <circle cx="9" cy="10" r="1.6" />
            <path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L20 20" />
          </svg>
        </span>
      )}

      <div className="flex flex-col gap-1.5">
        <strong className="text-title-sm text-ink">
          {media ? (media.type === "video" ? "Video attached" : "Image attached") : "No media"}
        </strong>
        <div className="flex flex-wrap gap-4">
          <button type="button" onClick={onPick} disabled={uploading} className="btn-link">
            {uploading ? "Uploading…" : media ? "Replace" : "Attach image or video"}
          </button>
          {media && (
            <button
              type="button"
              onClick={onRemove}
              disabled={uploading}
              className="btn-link btn-quiet"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        onChange={(e) => onChosen(e.target.files?.[0])}
        className="hidden"
      />
    </div>
  );
}
