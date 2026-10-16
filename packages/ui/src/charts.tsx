import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { cx } from './cx';

/*
 * Lightweight charts, hand-rolled (no chart library). Rules (dataviz skill):
 * - colour = identity (one application) or a neutral aggregate; never rank
 * - idle is a 135 deg hatch of the same colour, so active/idle never relies on colour alone
 * - thin marks, 2 px surface gaps, 4 px rounded data ends, hairline solid grid
 * - every mark has a hover AND keyboard-focus tooltip; values are also reachable as text
 * - text uses text tokens only, never the series colour
 */

export type MarkVariant = 'solid' | 'hatched';

// ---------------------------------------------------------------------------------------------
// Swatch & legend
// ---------------------------------------------------------------------------------------------

export function Swatch({
  color,
  variant = 'solid',
  shape = 'rect',
}: {
  color: string;
  variant?: MarkVariant;
  shape?: 'rect' | 'line' | 'dot';
}) {
  return (
    <span
      className={cx(
        'sp-swatch',
        shape === 'line' && 'sp-swatch--line',
        shape === 'dot' && 'sp-swatch--dot',
        variant === 'hatched' ? 'sp-fill--hatched' : 'sp-fill',
      )}
      style={{ '--c': color } as CSSProperties}
      aria-hidden="true"
    />
  );
}

export interface LegendItem {
  id: string;
  label: ReactNode;
  color: string;
  variant?: MarkVariant;
}

export function Legend({ items, className }: { items: ReadonlyArray<LegendItem>; className?: string }) {
  return (
    <ul className={cx('sp-legend', className)} aria-label="Legend">
      {items.map((item) => (
        <li key={item.id} className="sp-legend__item">
          <Swatch color={item.color} variant={item.variant} />
          <span className="sp-truncate">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------------------------

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  /** Data is being refreshed: keep the frame, dim the value. */
  stale?: boolean;
  loading?: boolean;
}

export function StatTile({ label, value, meta, icon, stale = false, loading = false }: StatTileProps) {
  return (
    <div className="sp-stat" data-stale={stale || undefined} aria-busy={loading || undefined}>
      <span className="sp-stat__label">
        {icon}
        {label}
      </span>
      {loading ? (
        <span className="sp-skeleton sp-stat__skeleton" aria-hidden="true" />
      ) : (
        <span className="sp-stat__value">{value}</span>
      )}
      <span className="sp-stat__meta">{meta}</span>
    </div>
  );
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('sp-stats', className)}>{children}</div>;
}

// ---------------------------------------------------------------------------------------------
// Chart tooltip
// ---------------------------------------------------------------------------------------------

export interface ChartTooltipRow {
  id: string;
  label: ReactNode;
  value: ReactNode;
  color?: string;
  variant?: MarkVariant;
}

export interface ChartTooltipContent {
  title: ReactNode;
  subtitle?: ReactNode;
  rows?: ReadonlyArray<ChartTooltipRow>;
}

export interface TooltipAnchor {
  x: number;
  y: number;
}

/** A floating readout near the pointer (or the focused mark), clamped to the viewport. */
export function ChartTooltip({ content, anchor }: { content: ChartTooltipContent | null; anchor: TooltipAnchor | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !anchor) {
      setPosition(null);
      return;
    }
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const margin = 8;
    let left = anchor.x + 14;
    let top = anchor.y + 14;
    if (left + width > window.innerWidth - margin) left = anchor.x - 14 - width;
    if (top + height > window.innerHeight - margin) top = anchor.y - 14 - height;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - width));
    top = Math.max(margin, Math.min(top, window.innerHeight - margin - height));
    setPosition({ top, left });
  }, [anchor, content]);

  if (!content || !anchor) return null;
  return (
    <div
      ref={ref}
      className="sp-chart-tip"
      aria-hidden="true"
      style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      <div className="sp-chart-tip__title">{content.title}</div>
      {content.subtitle ? <div className="sp-chart-tip__subtitle">{content.subtitle}</div> : null}
      {content.rows && content.rows.length > 0 ? (
        <div className="sp-chart-tip__rows">
          {content.rows.map((row) => (
            <div key={row.id} className="sp-chart-tip__row">
              <span className="sp-chart-tip__value">
                {row.color ? (
                  <Swatch color={row.color} variant={row.variant} shape={row.variant === 'hatched' ? 'rect' : 'line'} />
                ) : null}
                {row.value}
              </span>
              <span className="sp-chart-tip__label">{row.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Tooltip state shared by the charts: pointer-driven or focus-driven. */
function useChartTooltip<K>() {
  const [active, setActive] = useState<{ key: K; anchor: TooltipAnchor } | null>(null);
  return {
    active,
    showAtPointer(key: K, event: ReactPointerEvent) {
      setActive({ key, anchor: { x: event.clientX, y: event.clientY } });
    },
    showAtElement(key: K, element: Element | null) {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      setActive({ key, anchor: { x: rect.left + rect.width / 2, y: rect.bottom } });
    },
    clear() {
      setActive(null);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Bar list: one row per entity, horizontal bar split into stacked segments
// ---------------------------------------------------------------------------------------------

export interface BarListSegment {
  value: number;
  variant: MarkVariant;
}

export interface BarListRow {
  id: string;
  label: ReactNode;
  color: string;
  /** Drawn left to right; a 2 px surface gap separates them. */
  segments: ReadonlyArray<BarListSegment>;
  primary: ReactNode;
  secondary?: ReactNode;
  tooltip?: ChartTooltipContent;
  /** Spoken summary of the row (values are also visible as text). */
  ariaLabel: string;
}

export interface BarListProps {
  rows: ReadonlyArray<BarListRow>;
  /** Scale maximum. Defaults to the largest row total. */
  max?: number;
  'aria-label': string;
  stale?: boolean;
  className?: string;
}

export function BarList({ rows, max, stale = false, className, 'aria-label': ariaLabel }: BarListProps) {
  const tip = useChartTooltip<string>();
  const scale = useMemo(() => {
    const largest = rows.reduce(
      (acc, row) => Math.max(acc, row.segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0)),
      0,
    );
    return Math.max(max ?? largest, 1);
  }, [rows, max]);

  const activeRow = tip.active ? rows.find((row) => row.id === tip.active?.key) : undefined;

  return (
    <>
      <ul className={cx('sp-barlist', className)} aria-label={ariaLabel} data-stale={stale || undefined}>
        {rows.map((row) => (
          <li
            key={row.id}
            className="sp-barlist__row"
            tabIndex={row.tooltip ? 0 : undefined}
            aria-label={row.ariaLabel}
            onPointerMove={row.tooltip ? (event) => tip.showAtPointer(row.id, event) : undefined}
            onPointerLeave={row.tooltip ? tip.clear : undefined}
            onFocus={row.tooltip ? (event) => tip.showAtElement(row.id, event.currentTarget) : undefined}
            onBlur={row.tooltip ? tip.clear : undefined}
          >
            <span className="sp-barlist__name" aria-hidden="true">
              <Swatch color={row.color} shape="dot" />
              <span className="sp-barlist__label">{row.label}</span>
            </span>
            <span className="sp-barlist__track" aria-hidden="true">
              {row.segments.map((segment, index) => {
                const pct = (Math.max(0, segment.value) / scale) * 100;
                if (pct <= 0) return null;
                const width = index === 0 ? `${pct}%` : `max(0px, calc(${pct}% - 2px))`;
                return (
                  <span
                    key={index}
                    className={cx('sp-barlist__seg', segment.variant === 'hatched' ? 'sp-fill--hatched' : 'sp-fill')}
                    style={{ width, '--c': row.color } as CSSProperties}
                  />
                );
              })}
            </span>
            <span className="sp-barlist__value" aria-hidden="true">
              <span className="sp-barlist__primary">{row.primary}</span>
              {row.secondary ? <span className="sp-barlist__secondary">{row.secondary}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <ChartTooltip content={activeRow?.tooltip ?? null} anchor={tip.active?.anchor ?? null} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Timeline strip: intervals on a time axis
// ---------------------------------------------------------------------------------------------

export interface TimelineItem {
  id: string;
  startMs: number;
  endMs: number;
  color: string;
  variant: MarkVariant;
  /** Still being recorded: square right edge. */
  open?: boolean;
  tooltip: ChartTooltipContent;
}

export interface TimelineTick {
  ms: number;
  label: string;
}

export interface TimelineStripProps {
  startMs: number;
  endMs: number;
  items: ReadonlyArray<TimelineItem>;
  ticks: ReadonlyArray<TimelineTick>;
  /** Draw a "now" marker. */
  nowMs?: number | null;
  'aria-label': string;
  stale?: boolean;
}

/** Pointer tolerance (px) for picking a hairline-thin interval. */
const PICK_TOLERANCE_PX = 4;

export function TimelineStrip({
  startMs,
  endMs,
  items,
  ticks,
  nowMs,
  stale = false,
  'aria-label': ariaLabel,
}: TimelineStripProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef(new Map<string, HTMLSpanElement>());
  const tip = useChartTooltip<string>();
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const span = Math.max(1, endMs - startMs);

  const visible = useMemo(
    () =>
      items
        .filter((item) => item.endMs > startMs && item.startMs < endMs)
        .slice()
        .sort((a, b) => a.startMs - b.startMs),
    [items, startMs, endMs],
  );

  useEffect(() => {
    if (focusIndex !== null && focusIndex >= visible.length) setFocusIndex(visible.length ? visible.length - 1 : null);
  }, [visible.length, focusIndex]);

  function pct(ms: number) {
    return ((Math.min(Math.max(ms, startMs), endMs) - startMs) / span) * 100;
  }

  function pick(event: ReactPointerEvent<HTMLDivElement>): TimelineItem | undefined {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return undefined;
    const x = event.clientX - rect.left;
    const ms = startMs + (x / rect.width) * span;
    const tolerance = (PICK_TOLERANCE_PX / rect.width) * span;
    let best: TimelineItem | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const item of visible) {
      const distance = ms < item.startMs ? item.startMs - ms : ms > item.endMs ? ms - item.endMs : 0;
      if (distance <= tolerance && distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }
    return best;
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (visible.length === 0) return;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = focusIndex === null ? 0 : Math.min(visible.length - 1, focusIndex + 1);
    else if (event.key === 'ArrowLeft') next = focusIndex === null ? visible.length - 1 : Math.max(0, focusIndex - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visible.length - 1;
    else if (event.key === 'Escape') {
      setFocusIndex(null);
      tip.clear();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    const item = visible[next];
    if (item) tip.showAtElement(item.id, segmentRefs.current.get(item.id) ?? null);
  }

  const activeId = tip.active?.key ?? null;
  const activeItem = activeId ? visible.find((item) => item.id === activeId) : undefined;
  const nowPct = nowMs != null && nowMs > startMs && nowMs < endMs ? pct(nowMs) : null;

  return (
    <div className="sp-timeline" data-hovering={activeId ? true : undefined} data-stale={stale || undefined}>
      <div
        ref={trackRef}
        className="sp-timeline__track"
        role="group"
        aria-label={`${ariaLabel}. Use the arrow keys to step through intervals.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setFocusIndex(null);
          tip.clear();
        }}
        onPointerMove={(event) => {
          const item = pick(event);
          if (item) tip.showAtPointer(item.id, event);
          else tip.clear();
        }}
        onPointerLeave={tip.clear}
      >
        {ticks.map((tick) => (
          <span key={`g${tick.ms}`} className="sp-timeline__grid" style={{ left: `${pct(tick.ms)}%` }} aria-hidden="true" />
        ))}
        {visible.map((item) => {
          const left = pct(item.startMs);
          const width = Math.max(0, pct(item.endMs) - left);
          return (
            <span
              key={item.id}
              ref={(node) => {
                if (node) segmentRefs.current.set(item.id, node);
                else segmentRefs.current.delete(item.id);
              }}
              className={cx('sp-timeline__seg', item.variant === 'hatched' ? 'sp-fill--hatched' : 'sp-fill')}
              data-open={item.open || undefined}
              data-active={item.id === activeId || undefined}
              aria-hidden="true"
              style={
                {
                  '--c': item.color,
                  left: `calc(${left}% + 1px)`,
                  width: `max(2px, calc(${width}% - 2px))`,
                } as CSSProperties
              }
            />
          );
        })}
        {nowPct !== null ? <span className="sp-timeline__now" style={{ left: `${nowPct}%` }} aria-hidden="true" /> : null}
      </div>
      <div className="sp-timeline__ticks" aria-hidden="true">
        {ticks.map((tick, index) => (
          <span
            key={`t${tick.ms}`}
            className="sp-timeline__tick"
            data-edge={index === 0 && pct(tick.ms) < 4 ? 'start' : index === ticks.length - 1 && pct(tick.ms) > 96 ? 'end' : undefined}
            style={{ left: `${pct(tick.ms)}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <ChartTooltip content={activeItem?.tooltip ?? null} anchor={tip.active?.anchor ?? null} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Column chart: stacked columns (bottom to top), one per category on the x axis
// ---------------------------------------------------------------------------------------------

export interface ColumnSegment {
  value: number;
  variant: MarkVariant;
}

export interface ColumnDatum {
  key: string;
  label: string;
  /** Bottom to top. */
  segments: ReadonlyArray<ColumnSegment>;
  tooltip: ChartTooltipContent;
}

export interface ColumnChartProps {
  data: ReadonlyArray<ColumnDatum>;
  /** Y gridline values, ascending; the last one is the scale maximum. */
  yTicks: ReadonlyArray<number>;
  formatTick: (value: number) => string;
  /** Plot height in px (the x-axis band is added below it). */
  height?: number;
  /** Fill colour token for the stack (an aggregate: neutral). */
  color?: string;
  'aria-label': string;
  stale?: boolean;
}

const AXIS_LEFT = 44;
const AXIS_BOTTOM = 22;
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

/** Rectangle with rounded top corners only (data end), square at the baseline. */
function roundedTopRect(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  return [
    `M${x},${y + height}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + width - r}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `V${y + height}`,
    'Z',
  ].join(' ');
}

export function ColumnChart({
  data,
  yTicks,
  formatTick,
  height = 168,
  color = 'var(--sp-viz-total)',
  stale = false,
  'aria-label': ariaLabel,
}: ColumnChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [focusAnchor, setFocusAnchor] = useState<TooltipAnchor | null>(null);
  const tip = useChartTooltip<number>();
  const patternId = `sp-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const max = Math.max(1, yTicks[yTicks.length - 1] ?? 1);
  const plotWidth = Math.max(0, width - AXIS_LEFT);
  const band = data.length > 0 ? plotWidth / data.length : 0;
  const barWidth = Math.max(2, Math.min(MAX_BAR, band * 0.62));
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotWidth / 46))));
  const totalHeight = height + AXIS_BOTTOM;
  const y = (value: number) => height - (Math.max(0, value) / max) * height;

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (data.length === 0) return;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = focusIndex === null ? 0 : Math.min(data.length - 1, focusIndex + 1);
    else if (event.key === 'ArrowLeft') next = focusIndex === null ? data.length - 1 : Math.max(0, focusIndex - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = data.length - 1;
    else if (event.key === 'Escape') {
      setFocusIndex(null);
      setFocusAnchor(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    tip.clear();
    setFocusIndex(next);
    const rect = containerRef.current?.getBoundingClientRect();
    // Anchor the keyboard readout at the top of the focused column's band.
    if (rect) setFocusAnchor({ x: rect.left + AXIS_LEFT + band * next + band / 2, y: rect.top });
  }

  const pointerIndex = tip.active?.key ?? null;
  const activeIndex = pointerIndex ?? focusIndex;
  const anchor = tip.active?.anchor ?? (focusIndex !== null ? focusAnchor : null);
  const activeDatum = activeIndex !== null ? data[activeIndex] : undefined;

  return (
    <div
      ref={containerRef}
      className="sp-columns"
      data-hovering={activeIndex !== null ? true : undefined}
      data-stale={stale || undefined}
      role="group"
      aria-label={`${ariaLabel}. Use the arrow keys to step through columns.`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={() => {
        setFocusIndex(null);
        setFocusAnchor(null);
        tip.clear();
      }}
      style={{ height: totalHeight }}
    >
      {width > 0 ? (
        <svg width={width} height={totalHeight} aria-hidden="true">
          <defs>
            <pattern id={patternId} patternUnits="userSpaceOnUse" width="4.5" height="4.5" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="4.5" className="sp-columns__hatch-line" />
            </pattern>
          </defs>
          {yTicks.map((tick) => (
            <g key={tick}>
              {tick > 0 ? (
                <line className="sp-columns__grid" x1={AXIS_LEFT} x2={width} y1={y(tick) + 0.5} y2={y(tick) + 0.5} />
              ) : null}
              <text className="sp-columns__ylabel" x={AXIS_LEFT - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {formatTick(tick)}
              </text>
            </g>
          ))}
          <line className="sp-columns__baseline" x1={AXIS_LEFT} x2={width} y1={height + 0.5} y2={height + 0.5} />
          {data.map((datum, index) => {
            const cx0 = AXIS_LEFT + band * index + band / 2;
            const x = cx0 - barWidth / 2;
            let cursor = 0;
            const drawn = datum.segments.filter((segment) => segment.value > 0);
            return (
              <g
                key={datum.key}
                className="sp-columns__col"
                data-active={index === activeIndex || undefined}
              >
                {drawn.map((segment, segmentIndex) => {
                  const bottom = cursor;
                  cursor += segment.value;
                  const y0 = y(bottom) - (segmentIndex > 0 ? GAP : 0);
                  const y1 = y(cursor);
                  const h = Math.max(0, y0 - y1);
                  if (h <= 0) return null;
                  const isTop = segmentIndex === drawn.length - 1;
                  const d = isTop ? roundedTopRect(x, y1, barWidth, h, RADIUS) : `M${x},${y1}h${barWidth}v${h}h${-barWidth}Z`;
                  if (segment.variant === 'hatched') {
                    return (
                      <g key={segmentIndex}>
                        <path d={d} className="sp-columns__secondary-bg" />
                        <path d={d} fill={`url(#${patternId})`} />
                      </g>
                    );
                  }
                  return <path key={segmentIndex} d={d} style={{ fill: color }} />;
                })}
                {index === focusIndex ? (
                  <rect
                    className="sp-columns__focus"
                    x={cx0 - band / 2 + 1}
                    y={1}
                    width={Math.max(0, band - 2)}
                    height={height - 2}
                    rx={4}
                  />
                ) : null}
                {index % labelEvery === 0 ? (
                  <text className="sp-columns__xlabel" x={cx0} y={height + 15} textAnchor="middle">
                    {datum.label}
                  </text>
                ) : null}
                <rect
                  className="sp-columns__hit"
                  x={cx0 - band / 2}
                  y={0}
                  width={band}
                  height={height}
                  onPointerMove={(event) => tip.showAtPointer(index, event)}
                  onPointerLeave={tip.clear}
                />
              </g>
            );
          })}
        </svg>
      ) : null}
      <ChartTooltip content={activeDatum?.tooltip ?? null} anchor={anchor ?? null} />
    </div>
  );
}
