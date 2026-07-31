/**
 * The SPA's one way of talking to the API.
 *
 * Everything goes through {@link apiFetch} so the session token is attached in a
 * single place and every failure arrives as the same {@link ApiError} — which is
 * what lets a screen show what the API actually said (a suspended Client, a
 * missing Page) instead of a generic "something went wrong".
 */

/** The session token, held for the tab. */
let sessionToken: string | null = localStorage.getItem("smma.session");

export function getSessionToken(): string | null {
  return sessionToken;
}

export function setSessionToken(token: string | null): void {
  sessionToken = token;
  if (token) localStorage.setItem("smma.session", token);
  else localStorage.removeItem("smma.session");
}

/** A non-2xx response, carrying the API's own error code and message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * Per-platform detail, when the API refused for reasons that differ by
     * platform (compose's 422 `invalid_content`). Carried alongside `message`
     * rather than flattened into it so the composer can put each reason on the
     * platform it belongs to, which is where a User can act on it.
     */
    readonly reasons?: Partial<Record<Platform, string>>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  reasons?: Partial<Record<Platform, string>>;
}

export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    throw errorFrom(response.status, body);
  }
  return body as T;
}

function errorFrom(status: number, body: unknown): ApiError {
  const { error, message, reasons } = body as ApiErrorBody;
  return new ApiError(
    status,
    error ?? "unknown_error",
    message ?? error ?? `Request failed (${status})`,
    reasons,
  );
}

/**
 * Upload a Media file. Separate from {@link apiFetch} because the upload route
 * takes the file's *raw bytes* under its own Content-Type (ADR 0003) rather than
 * a JSON envelope — a File is sent as-is, and the browser's own type is what
 * tells the API whether this is an image or a video.
 */
export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": file.type,
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: file,
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    throw errorFrom(response.status, body);
  }
  return body as T;
}

export type Platform = "facebook" | "instagram" | "tiktok";

export interface ConnectedAccount {
  platform: Platform;
  status: "connected" | "disconnected" | "token_expired";
  externalId: string | null;
  displayName: string | null;
  connectedAt: string | null;
}

export interface FacebookPageChoice {
  id: string;
  name: string;
}

export const listConnections = () =>
  apiFetch<{ connections: ConnectedAccount[] }>("/api/connections").then((b) => b.connections);

export const startFacebookConnect = () =>
  apiFetch<{ authorizeUrl: string; state: string }>("/api/connections/facebook/start", {
    method: "POST",
  });

export const completeFacebookLogin = (state: string, code: string) =>
  apiFetch<{ pages: FacebookPageChoice[] }>("/api/connections/facebook/callback", {
    method: "POST",
    body: { state, code },
  });

export const selectFacebookPage = (state: string, pageId: string) =>
  apiFetch<{ connection: ConnectedAccount }>("/api/connections/facebook/select", {
    method: "POST",
    body: { state, pageId },
  });

/**
 * Provide a hand-pasted long-lived Facebook Page token (ADR 0008, Option E) — the
 * bring-your-own-token fallback for when our own app review is unavailable. It
 * lands in the same Connected Account slot an OAuth login would, and doubles as
 * the way to regenerate a token_expired Page. Meta only.
 */
export const provideFacebookToken = (token: string, pageId: string, displayName: string) =>
  apiFetch<{ connection: ConnectedAccount }>("/api/connections/facebook/token", {
    method: "POST",
    body: { token, pageId, displayName },
  });

/**
 * Connect Instagram. No redirect and no callback screen: an IG Business account
 * is reached through the already-connected Page, so this one call is the whole
 * flow (ADR 0005).
 */
export const connectInstagram = () =>
  apiFetch<{ connection: ConnectedAccount }>("/api/connections/instagram/connect", {
    method: "POST",
  });

export const startTikTokConnect = () =>
  apiFetch<{ authorizeUrl: string; state: string }>("/api/connections/tiktok/start", {
    method: "POST",
  });

/** Finish TikTok login. One step — TikTok authorizes one account, so it connects. */
export const completeTikTokLogin = (state: string, code: string) =>
  apiFetch<{ connection: ConnectedAccount }>("/api/connections/tiktok/callback", {
    method: "POST",
    body: { state, code },
  });

export const disconnectPlatform = (platform: Platform) =>
  apiFetch<{ connection: ConnectedAccount }>(`/api/connections/${platform}`, {
    method: "DELETE",
  });

/* ---------------------------------------------------------------- Composing */

export type PostStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "partially_published"
  | "failed";

export type TargetStatus = "pending" | "published" | "failed";

export interface UploadedMedia {
  id: string;
  url: string;
  type: "image" | "video";
}

export interface Post {
  id: string;
  text: string;
  media: { url: string; type: "image" | "video" } | null;
  /** The attached Media's id — what an edit re-sends to keep the attachment. */
  mediaId: string | null;
  status: PostStatus;
  /** UTC, and set only while `scheduled`. Rendered in the Client's timezone. */
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One platform a Post was sent to, and how that one landed. */
export interface PostTarget {
  platform: Platform;
  status: TargetStatus;
  externalId: string | null;
  permalink: string | null;
  error: string | null;
  retryCount: number;
}

export interface PostWithTargets {
  post: Post;
  targets: PostTarget[];
}

/** A history row: a Post, its Targets, and a thumbnail fetched live (ADR 0003). */
export interface PostHistoryEntry extends Post {
  thumbnailUrl: string | null;
  targets: PostTarget[];
}

/** A Draft or Scheduled Post, with the platform selection it is holding. */
export interface PendingPost extends Post {
  targets: PostTarget[];
}

/** Live per-post numbers. Every field optional — platforms expose different ones. */
export interface PostMetrics {
  likes?: number;
  comments?: number;
  shares?: number;
  views?: number;
}

export interface TargetMetrics {
  platform: Platform;
  status: TargetStatus;
  permalink: string | null;
  /** Null when there is nothing readable — not published, or the platform refused. */
  metrics: PostMetrics | null;
}

/**
 * What a compose or edit sends. `platforms` is the whole selection every time —
 * the API replaces a Post's Targets wholesale rather than diffing them.
 *
 * Which of the three outcomes this becomes is decided by these two fields, not
 * by a mode flag: `draft: true` saves it as-is and ungated, a `scheduledAt`
 * schedules it, and neither publishes it immediately.
 */
export interface ComposeInput {
  text: string;
  platforms: Platform[];
  mediaId?: string | null;
  /** ISO UTC. Built from the Client's timezone, never the browser's. */
  scheduledAt?: string | null;
  draft?: boolean;
}

function composeBody(input: ComposeInput): Record<string, unknown> {
  return {
    text: input.text,
    platforms: input.platforms,
    // Omitted rather than nulled: the API reads a *present* `media` key as "this
    // Post has an attachment", and a present-but-empty one is a 400.
    ...(input.mediaId ? { media: { mediaId: input.mediaId } } : {}),
    ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
    ...(input.draft ? { draft: true } : {}),
  };
}

export const uploadMedia = (file: File) => apiUpload<UploadedMedia>("/api/media", file);

export const composePost = (input: ComposeInput) =>
  apiFetch<PostWithTargets>("/api/posts", { method: "POST", body: composeBody(input) });

/** Edit a Draft or Scheduled Post before it fires. Cannot publish — see below. */
export const updatePost = (id: string, input: ComposeInput) =>
  apiFetch<PostWithTargets>(`/api/posts/${id}`, { method: "PATCH", body: composeBody(input) });

/**
 * Send a Draft or Scheduled Post now. Its own call because `updatePost` is
 * editing-before-it-fires and refuses to publish: finishing a Draft is a
 * separate act from revising one.
 */
export const publishPostNow = (id: string) =>
  apiFetch<PostWithTargets>(`/api/posts/${id}/publish`, { method: "POST" });

/** Cancel a Scheduled Post. It becomes a Draft — the content survives. */
export const cancelScheduledPost = (id: string) =>
  apiFetch<{ post: Post }>(`/api/posts/${id}/cancel`, { method: "POST" });

export const listPostHistory = () =>
  apiFetch<{ posts: PostHistoryEntry[] }>("/api/posts").then((b) => b.posts);

export const listPendingPosts = () =>
  apiFetch<{ posts: PendingPost[] }>("/api/posts/drafts").then((b) => b.posts);

export const getPost = (id: string) => apiFetch<PostWithTargets>(`/api/posts/${id}`);

export const getPostMetrics = (id: string) =>
  apiFetch<{ post: Post; targets: TargetMetrics[] }>(`/api/posts/${id}/metrics`);

/** Retry one failed Target, after the automatic attempts have given up. */
export const retryTarget = (id: string, platform: Platform) =>
  apiFetch<PostWithTargets>(`/api/posts/${id}/targets/${platform}/retry`, { method: "POST" });

/** Re-attach freshly uploaded Media to a Post whose own was purged (ADR 0003). */
export const attachMediaToPost = (id: string, mediaId: string) =>
  apiFetch<{ post: Post }>(`/api/posts/${id}/media`, { method: "POST", body: { mediaId } });

/* --------------------------------------------------------------- Analytics */

/**
 * One day on a Connected Account's trend line. Every metric is nullable because
 * the platforms disagree on what they expose (TikTok reports no reach at all), and
 * a field we could not read is a null rather than a fabricated zero (ADR 0004).
 */
export interface DailyMetricPoint {
  /** `YYYY-MM-DD` in the Client's timezone. */
  date: string;
  followers: number | null;
  reach: number | null;
  engagement: number | null;
  postsPublished: number | null;
}

/** One connected platform's whole trend. Identical in shape across all three. */
export interface AccountSeries {
  platform: Platform;
  displayName: string | null;
  /** Empty for an account connected but not yet snapshotted — never a gap. */
  series: DailyMetricPoint[];
}

/** One day's deliveries. Every day in the range is present, zeros included. */
export interface DeliveryPoint {
  date: string;
  published: number;
  failed: number;
}

export interface PlatformDelivery {
  platform: Platform;
  published: number;
  failed: number;
}

/** What is still ahead — deliberately not scoped to the range. */
export interface Upcoming {
  scheduled: number;
  drafts: number;
  /** UTC. Rendered in the Client's timezone. */
  nextScheduledAt: string | null;
}

/** What this Client published, counted from our own records — no platform calls. */
export interface PostActivity {
  daily: DeliveryPoint[];
  byPlatform: PlatformDelivery[];
  /** Posts *composed* in the range, by the state they ended in. */
  posts: Record<PostStatus, number>;
  upcoming: Upcoming;
}

/** The window everything on the dashboard is cut to, in the Client's timezone. */
export interface AnalyticsRange {
  days: number;
  from: string;
  to: string;
}

export interface Analytics {
  range: AnalyticsRange;
  accounts: AccountSeries[];
  posts: PostActivity;
}

/**
 * The dashboard's one read. `days` scopes both halves together — the account
 * trends and the publishing activity are always on the same window.
 */
export const getAnalytics = (days: number) =>
  apiFetch<Analytics>(`/api/analytics?days=${days}`);
