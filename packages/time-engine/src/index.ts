/**
 * @studio-pulse/time-engine — pure reporting maths.
 *
 * PUBLIC API CONTRACT (implementations pending). The desktop UI is written against exactly these
 * exports. Implementers may split the code into modules but must keep these names and signatures.
 * Every function is pure: no Date.now() and no ambient time zone; callers pass `now` and `timeZone`.
 */

import type {
  AppCategory,
  ApplicationDefinition,
  IntervalKind,
  TrackingEvent,
  TrackingSource,
} from '@studio-pulse/shared-types';

// ---------------------------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------------------------

export type RangePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';

export interface DateRange {
  preset: RangePreset;
  /** Inclusive start, UTC epoch ms (start of the first local day). */
  startMs: number;
  /** Exclusive end, UTC epoch ms (start of the local day after the last day). */
  endMs: number;
  timeZone: string;
  /** Local calendar days covered, `YYYY-MM-DD`, oldest first. */
  days: string[];
  /** Human label, e.g. "Today", "Last 7 days", "3 Oct – 9 Oct". */
  label: string;
}

export interface ResolveRangeOptions {
  now: number;
  timeZone: string;
  /** `YYYY-MM-DD`, required for `custom`. */
  customStart?: string;
  /** `YYYY-MM-DD` inclusive, required for `custom`. */
  customEnd?: string;
  locale?: string;
}

/** Resolve a preset to local-day boundaries in `timeZone` (DST-safe: days may be 23 or 25 h). */
export function resolveRange(_preset: RangePreset, _options: ResolveRangeOptions): DateRange {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------------------------

/** A TrackingEvent with parsed millisecond timestamps. Invariant: activeMs + idleMs = endMs - startMs. */
export interface NormalizedInterval {
  id: string;
  deviceId: string;
  applicationId: string;
  applicationName: string;
  kind: IntervalKind;
  startMs: number;
  endMs: number;
  activeMs: number;
  idleMs: number;
  projectId: string | null;
  taskId: string | null;
  source: TrackingSource;
  open: boolean;
}

/**
 * Parse ISO timestamps, drop malformed or zero-length records, and de-duplicate by `id` (highest
 * `revision` wins, then the later `endedAt`). Re-derives active/idle ms from the timestamps.
 */
export function normalizeEvents(_events: readonly TrackingEvent[]): NormalizedInterval[] {
  throw new Error('not implemented');
}

/**
 * Defence in depth: on each device, an instant may be counted once only. Later-starting intervals
 * are clipped to begin where the previous one ended; fully covered intervals are dropped.
 * Intervals on different devices are never clipped against each other.
 */
export function resolveOverlaps(_intervals: readonly NormalizedInterval[]): {
  intervals: NormalizedInterval[];
  clippedMs: number;
} {
  throw new Error('not implemented');
}

/** Clip to [startMs, endMs). Active/idle ms scale proportionally. Returns null if nothing remains. */
export function clipInterval(
  _interval: NormalizedInterval,
  _startMs: number,
  _endMs: number,
): NormalizedInterval | null {
  throw new Error('not implemented');
}

/** Split intervals at local midnight in `timeZone`. Returns one piece per (day, interval). */
export function splitByLocalDay(
  _intervals: readonly NormalizedInterval[],
  _timeZone: string,
): Array<{ day: string; interval: NormalizedInterval }> {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------

export interface UsageTotals {
  foregroundMs: number;
  activeMs: number;
  idleMs: number;
}

export interface ApplicationUsage extends UsageTotals {
  applicationId: string;
  name: string;
  category: AppCategory;
  /** Share of total tracked active time in the range, 0..1. */
  activeShare: number;
}

export interface CategoryUsage extends UsageTotals {
  category: AppCategory;
  activeShare: number;
}

export interface DayUsage extends UsageTotals {
  /** `YYYY-MM-DD` local day. */
  day: string;
  /** Active ms per applicationId on that day. */
  activeByApplication: Record<string, number>;
}

export interface WeekUsage extends UsageTotals {
  /** `YYYY-MM-DD` of the local Monday starting the ISO week. */
  weekStart: string;
}

export interface ProjectUsage extends UsageTotals {
  /** Null = unassigned time. */
  projectId: string | null;
}

export interface TimelineSegment {
  id: string;
  applicationId: string;
  kind: IntervalKind;
  startMs: number;
  endMs: number;
  open: boolean;
}

export interface UsageSummary {
  range: DateRange;
  totals: UsageTotals;
  /** Sorted by activeMs desc, then name. */
  byApplication: ApplicationUsage[];
  byCategory: CategoryUsage[];
  /** One entry per day in `range.days`, including empty days. */
  byDay: DayUsage[];
  byWeek: WeekUsage[];
  byProject: ProjectUsage[];
  /** Clipped to the range, chronological. */
  timeline: TimelineSegment[];
  /** Applications hidden because `includeInReports` is false (and `includeExcluded` was not set). */
  excludedApplicationIds: string[];
  intervalCount: number;
  /** Milliseconds removed by overlap resolution; non-zero indicates corrupt or clock-skewed input. */
  overlapClippedMs: number;
}

export interface SummarizeOptions {
  range: DateRange;
  applications: readonly ApplicationDefinition[];
  /** Include applications whose `includeInReports` is false. Default false. */
  includeExcluded?: boolean;
}

/** normalize → resolveOverlaps → clip to range → split by local day → aggregate. */
export function summarize(_events: readonly TrackingEvent[], _options: SummarizeOptions): UsageSummary {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

export type DurationStyle = 'compact' | 'long' | 'clock';

/**
 * - compact: `0m`, `45s` (under a minute only when > 0 and < 60 s), `12m`, `1h 05m`, `26h 10m`
 * - long:    `1 hour 5 minutes`
 * - clock:   `1:05:09` (live counters)
 */
export function formatDuration(_ms: number, _style?: DurationStyle): string {
  throw new Error('not implemented');
}

/** Local wall-clock time, e.g. `14:05` (locale-aware 12/24 h). */
export function formatClockTime(_ms: number, _timeZone: string, _locale?: string): string {
  throw new Error('not implemented');
}

/** `Today`, `Yesterday`, otherwise e.g. `Mon 12 Oct`. */
export function formatDayLabel(_day: string, _timeZone: string, _now: number, _locale?: string): string {
  throw new Error('not implemented');
}

/** `YYYY-MM-DD` of the local day containing `ms` in `timeZone`. */
export function localDayKey(_ms: number, _timeZone: string): string {
  throw new Error('not implemented');
}

/** The runtime's IANA time zone (falls back to `UTC`). The only impure helper. */
export function currentTimeZone(): string {
  throw new Error('not implemented');
}

/** Percentage string for a 0..1 share, e.g. `42%`, `<1%`, `0%`. */
export function formatShare(_share: number): string {
  throw new Error('not implemented');
}
