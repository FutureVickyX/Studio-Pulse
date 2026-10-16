import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { APP_CATEGORY_LABELS } from '@studio-pulse/shared-types';
import type { ApplicationDefinition } from '@studio-pulse/shared-types';
import type { ApplicationUsage, DateRange, UsageSummary } from '@studio-pulse/time-engine';
import { formatDayLabel, formatDuration, formatShare } from '@studio-pulse/time-engine';
import {
  BarList,
  ColumnChart,
  IconChevronDown,
  IconChevronUp,
  Legend,
  StatGrid,
  StatTile,
  Swatch,
  TimelineStrip,
} from '@studio-pulse/ui';
import type { BarListRow, ColumnDatum, LegendItem, TimelineItem } from '@studio-pulse/ui';
import { useNow } from '../hooks/useLive';
import { durationTicks, formatAxisDuration, timelineTicks, timelineWindow } from '../lib/chartScales';
import { assignApplicationColors, colorFor, TOTAL_COLOR } from '../lib/colors';
import { addDaysToKey, dayAxisLabel } from '../lib/days';
import { clockTime, timeRange, UI_LOCALE } from '../lib/format';

const long = (ms: number) => formatDuration(ms, 'long');
const short = (ms: number) => formatDuration(ms, 'compact');

// ---------------------------------------------------------------------------------------------
// Colour map
// ---------------------------------------------------------------------------------------------

export function useApplicationColors(
  summary: UsageSummary | null,
  applications: readonly ApplicationDefinition[] | undefined,
): Map<string, string> {
  return useMemo(() => {
    const order = new Map<string, number>();
    (applications ?? []).forEach((app, index) => order.set(app.id, app.sortOrder * 10_000 + index));
    return assignApplicationColors(summary?.byApplication ?? [], order);
  }, [summary, applications]);
}

export const ACTIVE_IDLE_LEGEND: LegendItem[] = [
  { id: 'active', label: 'Active', color: TOTAL_COLOR, variant: 'solid' },
  { id: 'idle', label: 'Idle (no input)', color: TOTAL_COLOR, variant: 'hatched' },
];

// ---------------------------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------------------------

export function UsageStats({
  summary,
  loading,
  stale,
  idleMinutes,
  idleDetection,
}: {
  summary: UsageSummary | null;
  loading: boolean;
  stale: boolean;
  idleMinutes: number | null;
  idleDetection: boolean;
}) {
  const totals = summary?.totals;
  const share = totals && totals.foregroundMs > 0 ? totals.activeMs / totals.foregroundMs : null;
  return (
    <StatGrid>
      <StatTile
        label="Active"
        loading={loading}
        stale={stale}
        value={totals ? short(totals.activeMs) : '—'}
        meta={share !== null ? `${formatShare(share)} of foreground` : 'With keyboard or mouse input'}
      />
      <StatTile
        label="Foreground"
        loading={loading}
        stale={stale}
        value={totals ? short(totals.foregroundMs) : '—'}
        meta="Tracked apps in front"
      />
      <StatTile
        label="Idle"
        loading={loading}
        stale={stale}
        value={totals ? short(totals.idleMs) : '—'}
        meta={
          !idleDetection
            ? 'Idle detection is off'
            : idleMinutes !== null
              ? `No input for ${idleMinutes}+ min`
              : 'No keyboard or mouse input'
        }
      />
    </StatGrid>
  );
}

// ---------------------------------------------------------------------------------------------
// Time by application (bar list)
// ---------------------------------------------------------------------------------------------

function applicationTooltip(usage: ApplicationUsage, color: string) {
  return {
    title: usage.name,
    subtitle: APP_CATEGORY_LABELS[usage.category],
    rows: [
      { id: 'active', label: 'Active', value: short(usage.activeMs), color, variant: 'solid' as const },
      { id: 'idle', label: 'Idle', value: short(usage.idleMs), color, variant: 'hatched' as const },
      { id: 'fg', label: 'Foreground', value: short(usage.foregroundMs) },
      { id: 'share', label: 'of all active time', value: formatShare(usage.activeShare) },
    ],
  };
}

export function ApplicationBars({
  summary,
  colors,
  limit,
  stale = false,
}: {
  summary: UsageSummary;
  colors: ReadonlyMap<string, string>;
  limit?: number;
  stale?: boolean;
}) {
  const rows = useMemo<BarListRow[]>(() => {
    const list = limit ? summary.byApplication.slice(0, limit) : summary.byApplication;
    return list.map((usage) => {
      const color = colorFor(colors, usage.applicationId);
      return {
        id: usage.applicationId,
        label: usage.name,
        color,
        segments: [
          { value: usage.activeMs, variant: 'solid' },
          { value: usage.idleMs, variant: 'hatched' },
        ],
        primary: short(usage.activeMs),
        secondary: usage.idleMs > 0 ? `${short(usage.idleMs)} idle` : formatShare(usage.activeShare),
        tooltip: applicationTooltip(usage, color),
        ariaLabel: `${usage.name}: ${long(usage.activeMs)} active, ${long(usage.idleMs)} idle, ${formatShare(
          usage.activeShare,
        )} of active time`,
      };
    });
  }, [summary, colors, limit]);
  const max = summary.byApplication.reduce((acc, usage) => Math.max(acc, usage.foregroundMs), 0);
  return <BarList rows={rows} max={max} stale={stale} aria-label="Time by application" />;
}

export function CategoryBars({ summary, stale = false }: { summary: UsageSummary; stale?: boolean }) {
  const rows = useMemo<BarListRow[]>(
    () =>
      summary.byCategory
        .filter((usage) => usage.foregroundMs > 0)
        .map((usage) => {
          const label = APP_CATEGORY_LABELS[usage.category];
          return {
            id: usage.category,
            label,
            color: TOTAL_COLOR,
            segments: [
              { value: usage.activeMs, variant: 'solid' },
              { value: usage.idleMs, variant: 'hatched' },
            ],
            primary: short(usage.activeMs),
            secondary: formatShare(usage.activeShare),
            tooltip: {
              title: label,
              rows: [
                { id: 'active', label: 'Active', value: short(usage.activeMs), color: TOTAL_COLOR },
                { id: 'idle', label: 'Idle', value: short(usage.idleMs), color: TOTAL_COLOR, variant: 'hatched' as const },
                { id: 'share', label: 'of all active time', value: formatShare(usage.activeShare) },
              ],
            },
            ariaLabel: `${label}: ${long(usage.activeMs)} active, ${long(usage.idleMs)} idle, ${formatShare(
              usage.activeShare,
            )} of active time`,
          };
        }),
    [summary],
  );
  const max = summary.byCategory.reduce((acc, usage) => Math.max(acc, usage.foregroundMs), 0);
  return <BarList rows={rows} max={max} stale={stale} aria-label="Time by category" />;
}

// ---------------------------------------------------------------------------------------------
// Timeline (single day)
// ---------------------------------------------------------------------------------------------

export function nameLookup(summary: UsageSummary): Map<string, string> {
  return new Map(summary.byApplication.map((usage) => [usage.applicationId, usage.name]));
}

export function DayTimeline({
  summary,
  range,
  colors,
  timeZone,
  live,
  stale = false,
}: {
  summary: UsageSummary;
  range: DateRange;
  colors: ReadonlyMap<string, string>;
  timeZone: string;
  /** The range contains the present: draw a now marker and keep the window current. */
  live: boolean;
  stale?: boolean;
}) {
  const now = useNow(live ? 60_000 : 3_600_000);
  const nowMs = live ? now : null;
  const names = useMemo(() => nameLookup(summary), [summary]);
  const view = useMemo(
    () => timelineWindow(range.startMs, range.endMs, summary.timeline, nowMs),
    [range.startMs, range.endMs, summary.timeline, nowMs],
  );
  const ticks = useMemo(
    () =>
      timelineTicks(view.startMs, view.endMs, range.startMs).map((ms) => ({
        ms,
        label: clockTime(ms, timeZone),
      })),
    [view, range.startMs, timeZone],
  );
  const items = useMemo<TimelineItem[]>(
    () =>
      summary.timeline.map((segment) => {
        const name = names.get(segment.applicationId) ?? segment.applicationId;
        const color = colorFor(colors, segment.applicationId);
        return {
          id: segment.id,
          startMs: segment.startMs,
          endMs: segment.endMs,
          color,
          variant: segment.kind === 'idle' ? 'hatched' : 'solid',
          open: segment.open,
          tooltip: {
            title: name,
            subtitle: timeRange(segment.startMs, segment.endMs, timeZone, segment.open),
            rows: [
              {
                id: 'duration',
                label: segment.kind === 'idle' ? 'Idle' : 'Active',
                value: short(segment.endMs - segment.startMs),
                color,
                variant: segment.kind === 'idle' ? 'hatched' : 'solid',
              },
            ],
          },
        };
      }),
    [summary.timeline, names, colors, timeZone],
  );
  const legend = useMemo<LegendItem[]>(() => {
    const seen = new Set(summary.timeline.map((segment) => segment.applicationId));
    const entries = summary.byApplication
      .filter((usage) => seen.has(usage.applicationId))
      .map((usage) => ({ id: usage.applicationId, label: usage.name, color: colorFor(colors, usage.applicationId) }));
    // One "Other" entry for folded applications.
    const folded = entries.filter((entry) => entry.color === 'var(--sp-series-other)');
    const named = entries.filter((entry) => entry.color !== 'var(--sp-series-other)');
    return [
      ...named,
      ...(folded.length > 0 ? [{ id: 'other', label: `Other (${folded.length})`, color: 'var(--sp-series-other)' }] : []),
      { id: 'idle', label: 'Idle', color: TOTAL_COLOR, variant: 'hatched' as const },
    ];
  }, [summary, colors]);

  return (
    <div className="app-timeline">
      <TimelineStrip
        startMs={view.startMs}
        endMs={view.endMs}
        items={items}
        ticks={ticks}
        nowMs={nowMs}
        stale={stale}
        aria-label={`Timeline from ${clockTime(view.startMs, timeZone)} to ${clockTime(view.endMs, timeZone)}, ${
          items.length
        } intervals`}
      />
      {items.length > 0 ? <Legend items={legend} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Recent intervals (also the table twin of the timeline)
// ---------------------------------------------------------------------------------------------

function OpenElapsed({ startMs, fallbackMs }: { startMs: number; fallbackMs: number }) {
  const now = useNow(10_000, startMs);
  return <>{short(Math.max(fallbackMs, now - startMs))}</>;
}

export function IntervalList({
  summary,
  colors,
  timeZone,
  limit = 8,
  label = 'Recent intervals',
}: {
  summary: UsageSummary;
  colors: ReadonlyMap<string, string>;
  timeZone: string;
  limit?: number;
  label?: string;
}) {
  const names = useMemo(() => nameLookup(summary), [summary]);
  const recent = useMemo(
    () =>
      summary.timeline
        .slice()
        .sort((a, b) => b.startMs - a.startMs)
        .slice(0, limit),
    [summary.timeline, limit],
  );
  return (
    <ul className="app-intervals" aria-label={label}>
      {recent.map((segment) => {
        const name = names.get(segment.applicationId) ?? segment.applicationId;
        const idle = segment.kind === 'idle';
        return (
          <li key={segment.id} className="app-intervals__row">
            <Swatch color={colorFor(colors, segment.applicationId)} variant={idle ? 'hatched' : 'solid'} />
            <span className="app-intervals__name sp-truncate">{name}</span>
            <span className={idle ? 'app-kind app-kind--idle' : 'app-kind'}>{idle ? 'Idle' : 'Active'}</span>
            <span className="app-intervals__time sp-num">
              {clockTime(segment.startMs, timeZone)} – {segment.open ? <strong>now</strong> : clockTime(segment.endMs, timeZone)}
            </span>
            <span className="app-intervals__duration sp-num">
              {segment.open ? (
                <OpenElapsed startMs={segment.startMs} fallbackMs={segment.endMs - segment.startMs} />
              ) : (
                short(segment.endMs - segment.startMs)
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Application usage table (sortable)
// ---------------------------------------------------------------------------------------------

type SortKey = 'name' | 'foregroundMs' | 'activeMs' | 'idleMs' | 'activeShare';
type SortDirection = 'asc' | 'desc';

/** Names sort A→Z first; durations and shares largest first. */
function firstDirection(key: SortKey): SortDirection {
  return key === 'name' ? 'asc' : 'desc';
}

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: 'name', label: 'Application', numeric: false },
  { key: 'foregroundMs', label: 'Foreground', numeric: true },
  { key: 'activeMs', label: 'Active', numeric: true },
  { key: 'idleMs', label: 'Idle', numeric: true },
  { key: 'activeShare', label: '% of active', numeric: true },
];

export function UsageTable({
  summary,
  colors,
  excludedIds,
}: {
  summary: UsageSummary;
  colors: ReadonlyMap<string, string>;
  /** Applications marked "not in reports" (shown with a tag when they are included). */
  excludedIds?: ReadonlySet<string>;
}) {
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'activeMs', direction: 'desc' });
  const rows = useMemo(() => {
    const list = summary.byApplication.slice();
    list.sort((a, b) => {
      const order =
        sort.key === 'name' ? a.name.localeCompare(b.name, UI_LOCALE) : (a[sort.key] as number) - (b[sort.key] as number);
      return sort.direction === 'asc' ? order : -order;
    });
    return list;
  }, [summary.byApplication, sort]);

  function toggle(key: SortKey) {
    setSort((previous) =>
      previous.key === key
        ? { key, direction: previous.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: firstDirection(key) },
    );
  }

  return (
    <div className="app-table-wrap">
      <table className="app-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              // The active column shows its direction; the others show (on hover/focus only) the
              // direction a click would apply. The slot is always reserved so labels never shift.
              const direction = active ? sort.direction : firstDirection(column.key);
              return (
                <th
                  key={column.key}
                  scope="col"
                  className={column.numeric ? 'app-table__num' : undefined}
                  aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button type="button" className="app-table__sort" onClick={() => toggle(column.key)}>
                    <span className="app-table__sort-label">{column.label}</span>
                    <span
                      className={active ? 'app-table__sort-icon' : 'app-table__sort-icon app-table__sort-icon--hint'}
                      aria-hidden="true"
                    >
                      {direction === 'asc' ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((usage) => (
            <tr key={usage.applicationId}>
              <th scope="row">
                <span className="app-table__app">
                  <Swatch color={colorFor(colors, usage.applicationId)} shape="dot" />
                  <span className="sp-truncate">{usage.name}</span>
                  {excludedIds?.has(usage.applicationId) ? <span className="app-table__tag">Hidden in reports</span> : null}
                </span>
              </th>
              <td className="app-table__num">{short(usage.foregroundMs)}</td>
              <td className="app-table__num app-table__strong">{short(usage.activeMs)}</td>
              <td className="app-table__num">{short(usage.idleMs)}</td>
              <td className="app-table__num">{formatShare(usage.activeShare)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="app-table__num">{short(summary.totals.foregroundMs)}</td>
            <td className="app-table__num app-table__strong">{short(summary.totals.activeMs)}</td>
            <td className="app-table__num">{short(summary.totals.idleMs)}</td>
            <td className="app-table__num">{summary.totals.activeMs > 0 ? '100%' : '—'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Daily trend & weekly totals (multi-day ranges)
// ---------------------------------------------------------------------------------------------

export function DailyTrend({
  summary,
  timeZone,
  anchorMs,
  stale = false,
}: {
  summary: UsageSummary;
  timeZone: string;
  anchorMs: number;
  stale?: boolean;
}) {
  const data = useMemo<ColumnDatum[]>(
    () =>
      summary.byDay.map((day) => ({
        key: day.day,
        label: dayAxisLabel(day.day, summary.byDay.length, UI_LOCALE),
        segments: [
          { value: day.activeMs, variant: 'solid' },
          { value: day.idleMs, variant: 'hatched' },
        ],
        tooltip: {
          title: formatDayLabel(day.day, timeZone, anchorMs, UI_LOCALE),
          rows: [
            { id: 'active', label: 'Active', value: short(day.activeMs), color: TOTAL_COLOR },
            { id: 'idle', label: 'Idle', value: short(day.idleMs), color: TOTAL_COLOR, variant: 'hatched' as const },
            { id: 'fg', label: 'Foreground', value: short(day.foregroundMs) },
          ],
        },
      })),
    [summary.byDay, timeZone, anchorMs],
  );
  const ticks = useMemo(
    () => durationTicks(summary.byDay.reduce((acc, day) => Math.max(acc, day.foregroundMs), 0)),
    [summary.byDay],
  );
  return (
    <div className="app-trend">
      <ColumnChart
        data={data}
        yTicks={ticks}
        formatTick={formatAxisDuration}
        stale={stale}
        aria-label={`Active and idle time per day, ${summary.byDay.length} days`}
      />
      <Legend items={ACTIVE_IDLE_LEGEND} />
    </div>
  );
}

/** Table twin of the daily trend: every value of the chart, readable without hovering. */
export function DailyTable({
  summary,
  timeZone,
  anchorMs,
}: {
  summary: UsageSummary;
  timeZone: string;
  anchorMs: number;
}) {
  const days = useMemo(() => summary.byDay.slice().reverse(), [summary.byDay]);
  return (
    <div className="app-table-wrap">
      <table className="app-table app-table--compact">
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col" className="app-table__num">
              Foreground
            </th>
            <th scope="col" className="app-table__num">
              Active
            </th>
            <th scope="col" className="app-table__num">
              Idle
            </th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day}>
              <th scope="row">{formatDayLabel(day.day, timeZone, anchorMs, UI_LOCALE)}</th>
              <td className="app-table__num">{short(day.foregroundMs)}</td>
              <td className="app-table__num app-table__strong">{short(day.activeMs)}</td>
              <td className="app-table__num">{short(day.idleMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WeeklyTotals({
  summary,
  timeZone,
  anchorMs,
}: {
  summary: UsageSummary;
  timeZone: string;
  anchorMs: number;
}) {
  const firstDay = summary.range.days[0] ?? '';
  const lastDay = summary.range.days[summary.range.days.length - 1] ?? '';
  return (
    <div className="app-table-wrap">
      <table className="app-table">
        <thead>
          <tr>
            <th scope="col">Week starting</th>
            <th scope="col" className="app-table__num">
              Foreground
            </th>
            <th scope="col" className="app-table__num">
              Active
            </th>
            <th scope="col" className="app-table__num">
              Idle
            </th>
          </tr>
        </thead>
        <tbody>
          {summary.byWeek.map((week) => {
            const partial = week.weekStart < firstDay || addDaysToKey(week.weekStart, 6) > lastDay;
            return (
              <tr key={week.weekStart}>
                <th scope="row">
                  {formatDayLabel(week.weekStart, timeZone, anchorMs, UI_LOCALE)}
                  {partial ? <span className="app-table__tag">Partial week</span> : null}
                </th>
                <td className="app-table__num">{short(week.foregroundMs)}</td>
                <td className="app-table__num app-table__strong">{short(week.activeMs)}</td>
                <td className="app-table__num">{short(week.idleMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Footnote
// ---------------------------------------------------------------------------------------------

export function MeasurementNote({
  idleMinutes,
  idleDetection,
  children,
}: {
  idleMinutes: number | null;
  idleDetection: boolean;
  children?: ReactNode;
}) {
  return (
    <p className="app-footnote">
      Automatically measured foreground time.{' '}
      {idleDetection
        ? `Idle = no keyboard or mouse input for ${idleMinutes !== null ? `${idleMinutes} min` : 'the idle timeout'}.`
        : 'Idle detection is off, so time without input counts as active.'}{' '}
      Not billable time.{children ? <> {children}</> : null}
    </p>
  );
}
