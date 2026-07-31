import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  getAnalytics,
  type AccountSeries,
  type Analytics,
  type DailyMetricPoint,
  type PlatformDelivery,
  type PostActivity,
} from "./api.js";
import { PLATFORM_LABELS, PLATFORM_TONES, POST_STATUS_LABELS } from "./postRules.js";
import type { Session } from "./session.js";
import { formatInZone } from "./timezone.js";
import { Columns, Meter, Sparkline, compactNumber, signedNumber } from "./charts.jsx";
import { EmptyNote, ErrorNote, LoadingNote, PlatformTile, SectionHeading } from "./ui.jsx";

/**
 * How the Client's accounts are doing, and what it has been publishing.
 *
 * The screen is two halves that answer two different questions, and the split is
 * the same one the platform draws everywhere else. **Audience** is what the
 * platforms report about a Connected Account — followers, reach, engagement —
 * trended from the daily Metric Snapshots we store ourselves, because no
 * platform's native history is uniform enough to chart all three the same way
 * (ADR 0004). **Publishing** is what *we* did: how many Targets landed, which
 * ones did not, and what is still queued. That half needs no platform at all —
 * every number in it is a by-product of a Target settling.
 *
 * Both halves are cut to the same window by the range control at the top, in one
 * request, so no two numbers on the screen are ever describing different periods.
 *
 * Everything drawn here is also written out in a table behind "Show the numbers",
 * so no value is reachable only by hovering a chart.
 */

/** The windows offered. Presets, not a calendar — nobody picks "last 30 days" from a grid. */
const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

export function Dashboard({ session }: { session: Session }) {
  const timeZone = session.client.timezone;

  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * A range change refetches, but the previous render stays on screen at reduced
   * opacity while it does. Dropping back to a spinner would collapse the page's
   * height and bounce everything below it for the length of one request.
   */
  const [refetching, setRefetching] = useState(false);
  /** Whether anything has ever rendered — a first load has no frame to hold. */
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (loaded.current) setRefetching(true);

    getAnalytics(days)
      .then((fresh) => {
        if (cancelled) return;
        loaded.current = true;
        setData(fresh);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Could not load analytics.");
        }
      })
      .finally(() => {
        if (!cancelled) setRefetching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [days]);

  if (!data) {
    return error ? <ErrorNote>{error}</ErrorNote> : <LoadingNote>Loading analytics…</LoadingNote>;
  }

  const { accounts, posts } = data;
  const day = formatDay;

  return (
    <div>
      <SectionHeading eyebrow="Overview" title="Dashboard">
        {/* One filter row, above everything it scopes: every chart, stat and table
            below re-renders against this same slice. */}
        <div
          className="flex gap-1 rounded-md bg-[color-mix(in_oklab,var(--color-surface-card)_55%,transparent)] p-1"
          role="group"
          aria-label="Time range"
        >
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              onClick={() => setDays(range.days)}
              aria-pressed={days === range.days}
              className={`rounded-xs px-3 py-1.5 text-note transition-colors ${
                days === range.days
                  ? "bg-canvas text-ink shadow-clay-inset font-semibold"
                  : "text-muted hover:text-ink"
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </SectionHeading>

      <p className="-mt-2 mb-6 text-body-sm text-muted">
        {day(data.range.from)} – {day(data.range.to)}, in {timeZone.replace("_", " ")}.
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className={refetching ? "opacity-50 transition-opacity" : "transition-opacity"}>
        <Headline accounts={accounts} posts={posts} timeZone={timeZone} days={data.range.days} />

        <Audience accounts={accounts} formatDate={day} days={data.range.days} />

        <Publishing posts={posts} formatDate={day} days={data.range.days} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Headline */

/**
 * The four numbers the screen leads with.
 *
 * Stat tiles rather than a chart, because each of these is one current value:
 * a four-bar bar chart of four unrelated measures would be a chart doing a
 * number's job. Followers is a level and carries its change across the window;
 * reach and engagement are sums *over* the window, so a change against the same
 * window would be comparing a period to itself.
 */
function Headline({
  accounts,
  posts,
  timeZone,
  days,
}: {
  accounts: AccountSeries[];
  posts: PostActivity;
  timeZone: string;
  days: number;
}) {
  const followers = totalFollowers(accounts);
  const delivered = posts.daily.reduce((sum, point) => sum + point.published, 0);

  return (
    <dl className="m-0 mb-12 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label="Followers"
        value={followers.now === null ? "—" : compactNumber(followers.now)}
        note={
          followers.now === null
            ? "No snapshots yet"
            : followers.change === null
              ? `Across ${accounts.length} account${accounts.length === 1 ? "" : "s"}`
              : `${signedNumber(followers.change)} in ${days} days`
        }
      />
      <StatTile
        label="Reach"
        value={compactNumber(sumOver(accounts, "reach"))}
        note={`Reported over ${days} days`}
      />
      <StatTile
        label="Engagement"
        value={compactNumber(sumOver(accounts, "engagement"))}
        note={`Reported over ${days} days`}
      />
      <StatTile
        label="Delivered"
        value={compactNumber(delivered)}
        note={
          posts.upcoming.nextScheduledAt
            ? `Next post ${formatInZone(posts.upcoming.nextScheduledAt, timeZone)}`
            : posts.upcoming.drafts > 0
              ? `${posts.upcoming.drafts} draft${posts.upcoming.drafts === 1 ? "" : "s"} waiting`
              : "Nothing scheduled"
        }
      />
    </dl>
  );
}

/** One headline number: what it is, what it reads, and what it is measured against. */
function StatTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card p-5">
      <dt className="text-note text-muted">{label}</dt>
      {/* Proportional figures: `tabular-nums` is for columns that align, and it
          makes a standalone number look loose at this size. */}
      <dd className="m-0 mt-1 text-display-sm text-ink">{value}</dd>
      <p className="m-0 mt-1.5 text-note text-faint">{note}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- Audience */

/**
 * One card per connected platform — small multiples, not three lines on one plot.
 *
 * Followers, reach and engagement live on wildly different scales across
 * Facebook, Instagram and TikTok, and putting them on a shared axis would either
 * flatten the small account into the baseline or need a second y-axis, which is
 * the one thing a chart must never have. Faceting sidesteps it: each card has its
 * own scale, its own headline, and its own name, so hue never has to carry
 * identity at all.
 */
function Audience({
  accounts,
  formatDate,
  days,
}: {
  accounts: AccountSeries[];
  formatDate: (date: string) => string;
  days: number;
}) {
  if (accounts.length === 0) {
    return (
      <section className="mb-12">
        <SectionHeading eyebrow="Audience" title="Accounts" />
        <EmptyNote>
          Nothing connected yet. Link an account and its numbers start being recorded from that
          day on.
        </EmptyNote>
      </section>
    );
  }

  return (
    <section className="mb-12">
      <SectionHeading eyebrow="Audience" title="Accounts" />

      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 lg:grid-cols-2">
        {accounts.map((account) => (
          <AccountCard
            key={account.platform}
            account={account}
            formatDate={formatDate}
            days={days}
          />
        ))}
      </ul>

      <NumbersTable
        summary="Show the numbers"
        head={["Account", "Day", "Followers", "Reach", "Engagement", "Posts on platform"]}
        rows={accounts.flatMap((account) =>
          account.series.map((point) => [
            PLATFORM_LABELS[account.platform],
            formatDate(point.date),
            cell(point.followers),
            cell(point.reach),
            cell(point.engagement),
            cell(point.postsPublished),
          ]),
        )}
      />
    </section>
  );
}

function AccountCard({
  account,
  formatDate,
  days,
}: {
  account: AccountSeries;
  formatDate: (date: string) => string;
  days: number;
}) {
  const followers = seriesOf(account, "followers");
  const latest = lastKnown(followers);
  const earliest = firstKnown(followers);
  const change = latest !== null && earliest !== null ? latest - earliest : null;

  return (
    <li className="card p-5">
      <div className="flex items-center gap-3">
        <PlatformTile platform={account.platform} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="m-0 text-title-sm text-ink">{PLATFORM_LABELS[account.platform]}</p>
          {account.displayName && (
            <p className="m-0 truncate text-note text-muted" title={account.displayName}>
              {account.displayName}
            </p>
          )}
        </div>
      </div>

      {account.series.length === 0 ? (
        <p className="m-0 mt-5 text-body-sm text-faint">
          No numbers for this window yet — the daily snapshot records them from the day this
          account was connected, and never backfills what came before.
        </p>
      ) : (
        <>
          <div className="mt-5 flex items-end justify-between gap-3">
            <div>
              <p className="m-0 text-note text-muted">Followers</p>
              <p className="m-0 mt-0.5 text-display-sm text-ink">
                {latest === null ? "—" : compactNumber(latest)}
              </p>
            </div>
            {change !== null && (
              <p
                className={`m-0 text-note font-semibold ${
                  change > 0 ? "text-[#15683c]" : change < 0 ? "text-[#a72020]" : "text-muted"
                }`}
              >
                {/* The arrow, not the color, is what says which way this went —
                    the color only agrees with it. */}
                {change !== 0 && <span aria-hidden="true">{change > 0 ? "↑ " : "↓ "}</span>}
                {signedNumber(change)}
                <span className="font-normal text-muted"> · {days}d</span>
              </p>
            )}
          </div>

          <div className="mt-3">
            <Sparkline
              points={followers}
              tone={PLATFORM_TONES[account.platform]}
              label={`${PLATFORM_LABELS[account.platform]} followers`}
              formatDate={formatDate}
            />
          </div>

          <dl className="m-0 mt-4 grid grid-cols-3 gap-2">
            <MiniStat label="Reach" value={sumSeries(account, "reach")} />
            <MiniStat label="Engagement" value={sumSeries(account, "engagement")} />
            <MiniStat label="Posts there" value={lastKnown(seriesOf(account, "postsPublished"))} />
          </dl>
        </>
      )}
    </li>
  );
}

/**
 * A supporting number inside a card. Null is written as an em dash rather than a
 * zero: TikTok's basic API reports no reach at all, and a fabricated 0 would read
 * as "nobody saw this" instead of "this platform does not say" (ADR 0004).
 */
function MiniStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="card-soft px-3 py-2.5">
      <dt className="text-note text-muted">{label}</dt>
      <dd className="m-0 mt-0.5 text-title-sm text-ink">
        {value === null ? <span className="text-faint">—</span> : compactNumber(value)}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------- Publishing */

/**
 * What went out, and whether it landed.
 *
 * Volume is a chart because it has a time axis and a shape worth seeing.
 * Reliability is not: it is one ratio per platform, which a meter and a written
 * percentage say better than any plot would.
 */
function Publishing({
  posts,
  formatDate,
  days,
}: {
  posts: PostActivity;
  formatDate: (date: string) => string;
  days: number;
}) {
  const delivered = posts.daily.reduce((sum, point) => sum + point.published, 0);
  const failed = posts.daily.reduce((sum, point) => sum + point.failed, 0);
  const composed = Object.values(posts.posts).reduce((sum, count) => sum + count, 0);

  return (
    <section>
      <SectionHeading eyebrow="Publishing" title="What you sent" />

      <div className="card p-5">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="m-0 text-note text-muted">Deliveries per day</p>
            <p className="m-0 mt-0.5 text-body-sm text-faint">
              One per platform a post went out to, on the day it landed there.
            </p>
          </div>
          <p className="m-0 text-note text-muted">
            <strong className="text-title-sm font-semibold text-ink">
              {compactNumber(delivered)}
            </strong>{" "}
            in {days} days
            {failed > 0 && (
              <>
                {" · "}
                <strong className="font-semibold text-[#a72020]">{compactNumber(failed)}</strong>{" "}
                failed
              </>
            )}
          </p>
        </div>

        {delivered === 0 && failed === 0 ? (
          <p className="m-0 text-body-sm text-faint">
            Nothing was published in this window.
          </p>
        ) : (
          <Columns
            points={posts.daily.map((point) => ({
              date: point.date,
              value: point.published,
              detail: point.failed > 0 ? `${point.failed} failed` : undefined,
            }))}
            label={(value) => `${value.toLocaleString()} delivered`}
            formatDate={formatDate}
          />
        )}
      </div>

      {posts.byPlatform.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {posts.byPlatform.map((platform) => (
            <Reliability key={platform.platform} delivery={platform} />
          ))}
        </div>
      )}

      {composed > 0 && (
        <div className="card-soft mt-3 flex flex-wrap gap-x-8 gap-y-3 px-5 py-4">
          <p className="m-0 w-full text-note text-muted">
            Posts written in this window, by how they ended
          </p>
          {(Object.entries(posts.posts) as Array<[keyof PostActivity["posts"], number]>)
            .filter(([, count]) => count > 0)
            .map(([status, count]) => (
              <p key={status} className="m-0 text-body-sm text-prose">
                <strong className="text-title-sm font-semibold text-ink">{count}</strong>{" "}
                {POST_STATUS_LABELS[status].replace("…", "").toLowerCase()}
              </p>
            ))}
        </div>
      )}

      <NumbersTable
        summary="Show the numbers"
        head={["Day", "Delivered", "Failed"]}
        rows={posts.daily.map((point) => [
          formatDate(point.date),
          point.published.toLocaleString(),
          point.failed.toLocaleString(),
        ])}
      />
    </section>
  );
}

/**
 * One platform's delivery record.
 *
 * The rate is always written out beside the meter: a bar that is 4% short of full
 * is not something anyone reads off a bar, and the severity color is never the
 * only thing saying a platform is failing.
 */
function Reliability({ delivery }: { delivery: PlatformDelivery }) {
  const attempts = delivery.published + delivery.failed;
  const rate = attempts === 0 ? 1 : delivery.published / attempts;
  const tone = rate >= 0.95 ? "good" : rate >= 0.8 ? "warning" : "bad";

  return (
    <div className="card p-5">
      <div className="flex items-center gap-3">
        <PlatformTile platform={delivery.platform} size="sm" />
        <p className="m-0 flex-1 text-title-sm text-ink">
          {PLATFORM_LABELS[delivery.platform]}
        </p>
        <p className="m-0 text-title-sm font-semibold text-ink">{Math.round(rate * 100)}%</p>
      </div>

      <div className="mt-3">
        <Meter ratio={rate} tone={tone} />
      </div>

      <p className="m-0 mt-2.5 text-note text-muted">
        {delivery.published.toLocaleString()} delivered
        {delivery.failed > 0 && ` · ${delivery.failed.toLocaleString()} failed`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ Table view */

/**
 * Every charted value, written out.
 *
 * Not an afterthought: it is what makes a tooltip an enhancement rather than the
 * only way to read the chart, and it is the version that works with a screen
 * reader, in print, and for anyone who just wants to copy a column out.
 * Collapsed by default because the charts are the answer for most readers.
 */
function NumbersTable({
  summary,
  head,
  rows,
}: {
  summary: string;
  head: string[];
  rows: ReactNode[][];
}) {
  if (rows.length === 0) return null;

  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-note text-muted hover:text-ink">{summary}</summary>
      <div className="mt-3 max-h-80 overflow-auto">
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr>
              {head.map((label) => (
                <th
                  key={label}
                  scope="col"
                  className="sticky top-0 bg-canvas px-3 py-2 text-left text-note font-semibold text-muted"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((value, column) => (
                  <td
                    key={column}
                    // Rows are separated by a hairline on the cells themselves.
                    // Not `.divide-soft`: its separator is a `::before`, and a
                    // pseudo-element inside a `<tr>` is laid out as an anonymous
                    // *cell*, which shifts every real cell one column right.
                    className={`border-b border-hairline-soft px-3 py-2 text-prose ${
                      column === 0 ? "" : "tabular-nums"
                    }`}
                  >
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ Series */

type MetricKey = "followers" | "reach" | "engagement" | "postsPublished";

/** One metric pulled out of an account's series, keeping every day's slot. */
function seriesOf(account: AccountSeries, metric: MetricKey) {
  return account.series.map((point) => ({ date: point.date, value: point[metric] }));
}

function firstKnown(points: Array<{ value: number | null }>): number | null {
  return points.find((point) => point.value !== null)?.value ?? null;
}

function lastKnown(points: Array<{ value: number | null }>): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index]!.value;
    if (value !== null) return value;
  }
  return null;
}

/**
 * A metric summed across the window for one account, or null when the platform
 * never reported it — which is not the same as it being zero.
 */
function sumSeries(account: AccountSeries, metric: MetricKey): number | null {
  const known = account.series
    .map((point: DailyMetricPoint) => point[metric])
    .filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

/** The same, across every account — the headline row's totals. */
function sumOver(accounts: AccountSeries[], metric: MetricKey): number {
  return accounts.reduce((sum, account) => sum + (sumSeries(account, metric) ?? 0), 0);
}

/**
 * Followers across every connected account, now and over the window.
 *
 * Summed at the *account* level rather than per day: the platforms are
 * snapshotted independently and one can be missing a day the others have, so
 * adding whatever happens to share a date would show a cliff on a day that only
 * means "TikTok's read was throttled".
 */
function totalFollowers(accounts: AccountSeries[]): { now: number | null; change: number | null } {
  let now: number | null = null;
  let change: number | null = null;

  for (const account of accounts) {
    const followers = seriesOf(account, "followers");
    const latest = lastKnown(followers);
    const earliest = firstKnown(followers);
    if (latest !== null) now = (now ?? 0) + latest;
    // A change needs both ends: an account with a single day of history has a
    // level but no movement, and counting it as +0 would be a claim.
    if (latest !== null && earliest !== null && followers.length > 1) {
      change = (change ?? 0) + (latest - earliest);
    }
  }

  return { now, change };
}

/** A nullable metric in a table cell. */
function cell(value: number | null): ReactNode {
  return value === null ? <span className="text-faint">—</span> : value.toLocaleString();
}

/**
 * A `YYYY-MM-DD` day rendered for reading.
 *
 * Formatted in UTC on purpose, even though every other time on this screen is
 * rendered in the Client's timezone. These dates are *already* calendar days in
 * that zone — the API cut them there — so projecting them through a timezone a
 * second time would shift half of them by a day. UTC is the identity conversion
 * for a date that has no time in it.
 */
function formatDay(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}
