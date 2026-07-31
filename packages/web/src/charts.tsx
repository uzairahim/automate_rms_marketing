import {
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

/**
 * The three marks the dashboard draws, hand-built in SVG.
 *
 * No charting library, for the same reason the nav icons are drawn by hand: three
 * marks do not justify a dependency, and a library's defaults — its palette, its
 * gridlines, its tooltips — would arrive as a second design system sitting on top
 * of Clay's.
 *
 * Two rules run through all of them, and are worth stating once here rather than
 * re-deriving at each use:
 *
 * **Marks wear ink, not the platform's color.** Every series here is a lone
 * series inside a card that already names what it is — the account card is headed
 * by its platform tile, the activity chart by its title — so there is no identity
 * for hue to carry, and coloring the mark would imply an encoding that does not
 * exist (the same reasoning the per-post metrics on a Post's detail follow). The
 * platform's own color appears as the area wash under the line: warmth and a
 * quiet cue, at an opacity no one could mistake for a value.
 *
 * **A tooltip never holds the only copy of a number.** Every value drawn here is
 * also in the dashboard's "show the numbers" table, so hovering is a convenience
 * and not the price of reading the chart.
 */

/* ------------------------------------------------------------------ Sizing */

/**
 * The pixel width a chart has to draw into, tracked as its container resizes.
 *
 * Measured rather than handed to the SVG as a percentage: a stretched viewBox
 * would scale the geometry non-uniformly, turning a 2px line into a different
 * weight horizontally than vertically and an end-dot into an ellipse. Drawing in
 * real pixels keeps every mark spec true at every width, and makes the hover math
 * a plain pointer-x lookup.
 */
function useChartWidth(): [MutableRefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/* ---------------------------------------------------------------- Tooltips */

/** Where a tooltip is anchored, in the chart's own pixel space. */
interface TipAnchor {
  x: number;
  y: number;
}

/**
 * A readout pinned above a mark. The value leads and the label follows — the
 * reader already knows which series they are pointing at; what they came for is
 * the number.
 *
 * Kept inside the chart's box and nudged back from either edge, so a tooltip on
 * the first or last point does not hang off the card.
 */
function ChartTip({
  anchor,
  width,
  title,
  children,
}: {
  anchor: TipAnchor;
  width: number;
  title: string;
  children: ReactNode;
}) {
  const clamped = Math.min(Math.max(anchor.x, 56), Math.max(width - 56, 56));
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md bg-surface-dark px-2.5 py-1.5 text-note text-white shadow-clay-lifted"
      style={{ left: clamped, top: Math.max(anchor.y - 10, 0) }}
    >
      <span className="block whitespace-nowrap font-semibold">{children}</span>
      <span className="block whitespace-nowrap text-[0.6875rem] font-normal opacity-70">
        {title}
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- Sparkline */

export interface TrendPoint {
  /** `YYYY-MM-DD` in the Client's timezone. */
  date: string;
  /** Null for a day the platform did not report this number (ADR 0004). */
  value: number | null;
}

const SPARK_HEIGHT = 72;
/** Room above and below the line, so the extremes are not drawn on the edge. */
const SPARK_PAD = 8;

/**
 * A single metric's trend, at card size.
 *
 * Deliberately axis-less: the card states the current value at headline size and
 * the change across the window beside it, so the line's job is only the *shape*
 * of how it got there. Adding a y-axis to a 72px-tall mark would spend more ink on
 * chrome than on data.
 *
 * Days the platform reported nothing are skipped rather than drawn as zero — a
 * missing snapshot is not a collapse to nothing — so the line simply spans the
 * gap between the days that do have a number.
 */
export function Sparkline({
  points,
  tone,
  label,
  formatDate,
}: {
  points: TrendPoint[];
  /** The platform's color, used only as the area wash under the line. */
  tone: string;
  /** What the series is, for the tooltip and the accessible summary. */
  label: string;
  formatDate: (date: string) => string;
}) {
  const [ref, width] = useChartWidth();
  const [hovered, setHovered] = useState<number | null>(null);

  const known = points.filter((point) => point.value !== null);
  const values = known.map((point) => point.value!);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero; drawing it down the middle is the honest
  // rendering of "this did not move".
  const span = max - min || 1;

  const x = (index: number) =>
    points.length > 1 ? (index / (points.length - 1)) * width : width / 2;
  const y = (value: number) =>
    SPARK_HEIGHT - SPARK_PAD - ((value - min) / span) * (SPARK_HEIGHT - SPARK_PAD * 2);

  /** The drawable points, carrying their index so the x-position stays on the day. */
  const plotted = points
    .map((point, index) => ({ ...point, index }))
    .filter((point) => point.value !== null);

  const line = plotted.map((point) => `${x(point.index)},${y(point.value!)}`).join(" ");
  const last = plotted[plotted.length - 1];
  const first = plotted[0];

  /** Snap the pointer to the nearest plotted day — nobody aims at a 2px line. */
  function track(event: React.PointerEvent<HTMLDivElement>) {
    if (plotted.length === 0 || width === 0) return;
    const offset = event.clientX - event.currentTarget.getBoundingClientRect().left;
    let nearest = plotted[0]!;
    for (const point of plotted) {
      if (Math.abs(x(point.index) - offset) < Math.abs(x(nearest.index) - offset)) {
        nearest = point;
      }
    }
    setHovered(nearest.index);
  }

  const hoveredPoint = hovered === null ? null : points[hovered];
  const summary =
    values.length === 0
      ? `${label}: nothing recorded yet`
      : `${label}: ${values[0]!.toLocaleString()} on ${formatDate(known[0]!.date)}, ` +
        `${values[values.length - 1]!.toLocaleString()} on ${formatDate(known[known.length - 1]!.date)}`;

  return (
    <div
      ref={ref}
      className="relative"
      style={{ height: SPARK_HEIGHT }}
      onPointerMove={track}
      onPointerLeave={() => setHovered(null)}
    >
      {width > 0 && plotted.length > 0 && (
        <svg
          width={width}
          height={SPARK_HEIGHT}
          role="img"
          aria-label={summary}
          className="overflow-visible"
        >
          {/* The wash: the platform's hue at a tenth, closing down to the
              baseline. A single point has no area to fill. */}
          {plotted.length > 1 && (
            <polygon
              points={`${x(first!.index)},${SPARK_HEIGHT} ${line} ${x(last!.index)},${SPARK_HEIGHT}`}
              fill={tone}
              opacity={0.12}
            />
          )}

          <polyline
            points={line}
            fill="none"
            stroke="var(--color-ink-strong)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* The endpoint, ringed in the surface color so it stays legible where
              it sits on the line rather than beside it. */}
          <circle
            cx={x(last!.index)}
            cy={y(last!.value!)}
            r={4}
            fill="var(--color-ink-strong)"
            stroke="var(--color-canvas)"
            strokeWidth={2}
          />

          {hovered !== null && hoveredPoint?.value != null && (
            <>
              {/* The crosshair finds the day; the dot confirms which point. */}
              <line
                x1={x(hovered)}
                y1={0}
                x2={x(hovered)}
                y2={SPARK_HEIGHT}
                stroke="var(--color-hairline)"
                strokeWidth={1}
              />
              <circle
                cx={x(hovered)}
                cy={y(hoveredPoint.value)}
                r={4}
                fill="var(--color-ink)"
                stroke="var(--color-canvas)"
                strokeWidth={2}
              />
            </>
          )}
        </svg>
      )}

      {hovered !== null && hoveredPoint?.value != null && (
        <ChartTip
          anchor={{ x: x(hovered), y: y(hoveredPoint.value) }}
          width={width}
          title={`${label} · ${formatDate(hoveredPoint.date)}`}
        >
          {hoveredPoint.value.toLocaleString()}
        </ChartTip>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Columns */

export interface ColumnPoint {
  date: string;
  value: number;
  /** Extra lines for this column's tooltip — context the mark itself omits. */
  detail?: string;
}

const COLUMN_HEIGHT = 132;
/** Bars are capped rather than filling their slot; the leftover band is air. */
const MAX_COLUMN_WIDTH = 18;
/** The smallest the y-scale ever tops out at — see where it is applied. */
const MIN_COLUMN_SCALE = 4;

/**
 * A column rounded at the data end and square where it meets the baseline —
 * `rect rx` would round all four corners and lift the bar off its own axis. The
 * radius is clamped to half the height so a one-unit column is not all corner.
 */
function columnPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height / 2);
  return (
    `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} ` +
    `L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} ` +
    `L${x + width},${y + height} Z`
  );
}

/**
 * Volume over time, one column per day.
 *
 * A single series on a single baseline, in ink: how much went out. Failures are
 * deliberately *not* stacked on top in red — a red-over-green stack is the one
 * pair colorblind readers cannot separate, and the reliability it would encode is
 * said far more plainly as a rate in the section below. A day's failures ride
 * along in that column's tooltip and in the table, so nothing is lost.
 *
 * Every day in the window is present, zeros included, so a quiet week reads as a
 * flat run rather than as missing data.
 */
export function Columns({
  points,
  label,
  formatDate,
}: {
  points: ColumnPoint[];
  /** What one unit is, for the tooltip ("2 published"). */
  label: (value: number) => string;
  formatDate: (date: string) => string;
}) {
  const [ref, width] = useChartWidth();
  const [hovered, setHovered] = useState<number | null>(null);

  // The scale has a floor. Without one, a window in which the busiest day saw a
  // single delivery would draw that day at full height — a bar chart claiming a
  // record where the truth is one post. Four is low enough that a genuinely busy
  // window still fills the plot.
  const max = Math.max(...points.map((point) => point.value), MIN_COLUMN_SCALE);
  const band = points.length > 0 ? width / points.length : 0;
  const barWidth = Math.max(Math.min(band - 2, MAX_COLUMN_WIDTH), 2);

  // The tallest a column can be, leaving the axis labels their own band below —
  // the plot is sized to include them rather than cropping them out.
  const plotHeight = COLUMN_HEIGHT;

  const heightOf = (value: number) => (value === 0 ? 0 : (value / max) * plotHeight);
  const centerOf = (index: number) => index * band + band / 2;

  const hoveredPoint = hovered === null ? null : points[hovered];
  const firstDay = points[0];
  const lastDay = points[points.length - 1];

  return (
    <div>
      <div ref={ref} className="relative" style={{ height: plotHeight }}>
        {width > 0 && (
          <svg width={width} height={plotHeight} className="overflow-visible">
            {/* The baseline: a solid hairline one step off the surface, never dashed. */}
            <line
              x1={0}
              y1={plotHeight}
              x2={width}
              y2={plotHeight}
              stroke="var(--color-hairline)"
              strokeWidth={1}
            />

            {points.map((point, index) => {
              const barHeight = heightOf(point.value);
              const x = centerOf(index) - barWidth / 2;
              return (
                <g key={point.date}>
                  {barHeight > 0 && (
                    <path
                      d={columnPath(x, plotHeight - barHeight, barWidth, barHeight)}
                      fill="var(--color-ink-strong)"
                      opacity={hovered === null || hovered === index ? 1 : 0.45}
                    />
                  )}
                  {/* The hit target is the whole band, floor to ceiling — a 2px
                      column on a quiet day is not something anyone can point at. */}
                  <rect
                    x={index * band}
                    y={0}
                    width={Math.max(band, 1)}
                    height={plotHeight}
                    fill="transparent"
                    tabIndex={0}
                    role="button"
                    aria-label={`${formatDate(point.date)}: ${label(point.value)}`}
                    className="cursor-default"
                    onPointerEnter={() => setHovered(index)}
                    onPointerLeave={() => setHovered(null)}
                    onFocus={() => setHovered(index)}
                    onBlur={() => setHovered(null)}
                  />
                </g>
              );
            })}
          </svg>
        )}

        {hoveredPoint && (
          <ChartTip
            anchor={{ x: centerOf(hovered!), y: plotHeight - heightOf(hoveredPoint.value) }}
            width={width}
            title={`${formatDate(hoveredPoint.date)}${
              hoveredPoint.detail ? ` · ${hoveredPoint.detail}` : ""
            }`}
          >
            {label(hoveredPoint.value)}
          </ChartTip>
        )}
      </div>

      {/* The axis band, sized as part of the chart rather than cropped out of it.
          Two labels, not thirty: the ends anchor the window and the tooltip
          carries every day in between. */}
      {firstDay && lastDay && (
        <div className="mt-2 flex justify-between text-note tabular-nums text-faint">
          <span>{formatDate(firstDay.date)}</span>
          <span>{formatDate(lastDay.date)}</span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- Meter */

/**
 * One ratio against its limit — a delivery success rate, not a series.
 *
 * The fill carries severity and the track is the same ramp a few steps lighter,
 * so the state reads across the whole bar rather than only where it stops. The
 * percentage is always written out beside it: color alone never has to carry
 * "this platform is failing".
 */
export function Meter({ ratio, tone }: { ratio: number; tone: "good" | "warning" | "bad" }) {
  const fill = {
    good: "var(--color-success)",
    warning: "var(--color-warning)",
    bad: "var(--color-error)",
  }[tone];

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: `color-mix(in oklab, ${fill} 18%, var(--color-surface-strong))` }}
      aria-hidden="true"
    >
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.round(ratio * 100)}%`, background: fill }}
      />
    </div>
  );
}

/* ----------------------------------------------------------------- Numbers */

/**
 * A count at headline size: grouped below ten thousand, compacted above it, so a
 * viral account reads as `12.9K` rather than running past the tile it sits in.
 * Proportional figures deliberately — `tabular-nums` is for columns that must
 * align, and it makes a standalone number look loose at this size.
 */
export function compactNumber(value: number): string {
  return value < 10_000
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });
}

/** A change across the window, written with its direction. Zero is "no change". */
export function signedNumber(value: number): string {
  if (value === 0) return "No change";
  return `${value > 0 ? "+" : "−"}${compactNumber(Math.abs(value))}`;
}

