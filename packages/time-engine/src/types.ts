/**
 * Public types of @studio-pulse/time-engine. Re-exported unchanged from `index.ts`.
 */

import type { AppCategory, ApplicationDefinition, IntervalKind, TrackingSource } from '@studio-pulse/shared-types';

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
  /**
   * Milliseconds inside the range removed by overlap resolution (an instant on one device is
   * counted once); non-zero indicates corrupt or clock-skewed input.
   */
  overlapClippedMs: number;
}

export interface SummarizeOptions {
  range: DateRange;
  applications: readonly ApplicationDefinition[];
  /** Include applications whose `includeInReports` is false. Default false. */
  includeExcluded?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Analytics reports (reconcile.ts): the TypeScript twin of `public.analytics_time_summary`
// ---------------------------------------------------------------------------------------------

/** One closed foreground interval of one application: a `public.time_entries` row. */
export interface ReportInterval {
  /** Unique per interval (the table's primary key). */
  id: string;
  userId: string;
  deviceId: string;
  applicationId: string;
  applicationName: string;
  /** Each interval is wholly active or wholly idle. */
  kind: IntervalKind;
  /** Inclusive start, UTC epoch ms (`started_at`); fractions of a millisecond are truncated. */
  startMs: number;
  /** Exclusive end, UTC epoch ms (`ended_at`); fractions of a millisecond are truncated. */
  endMs: number;
  projectId: string | null;
  taskId: string | null;
}

/**
 * The part of one interval that a report counts after reconciliation: the interval's own fields,
 * with `startMs`/`endMs` narrowed to the piece. Pieces of one user never overlap.
 */
export interface ReconciledPiece extends Omit<ReportInterval, 'startMs' | 'endMs'> {
  /** Inclusive start of the piece, UTC epoch ms (inside the interval and the range). */
  startMs: number;
  /** Exclusive end of the piece, UTC epoch ms. */
  endMs: number;
  /** The whole interval's start, UTC epoch ms (unclipped). */
  sourceStartMs: number;
  /** The whole interval's end, UTC epoch ms (unclipped). */
  sourceEndMs: number;
}

export interface ReconcileResult {
  /** Ordered by user id (code point order), then start. */
  pieces: ReconciledPiece[];
  /** Sum of every input interval's duration clipped to the range, before reconciliation. */
  rawMs: number;
}

export type ReportBucket = 'day' | 'week' | 'month';

export type ReportDimension = 'total' | 'period' | 'member' | 'project' | 'task' | 'application';

/** One row of a report: the camelCase twin of an `analytics_time_summary` row. */
export interface ReportRow {
  dimension: ReportDimension;
  /** Period rows: the bucket's first day, `YYYY-MM-DD` (the day, the ISO week's Monday or the 1st). */
  bucketStart: string | null;
  /** Member rows. */
  userId: string | null;
  /** Application rows. */
  applicationId: string | null;
  /** Application rows: the name on the contributing interval with the latest (start, id). */
  applicationName: string | null;
  /** Project and task rows; null on a project row means no project. */
  projectId: string | null;
  /** Task rows; null means no task. */
  taskId: string | null;
  /** Project rows: true for the row of time with no project and no task, false otherwise. */
  unattributed: boolean | null;
  activeMs: number;
  idleMs: number;
  /** Distinct intervals contributing to the row ("Sessions"). */
  entryCount: number;
  /** Total row only: duplicated time hidden from the figures shown; 0 on other rows. */
  overlapMs: number;
  /** Total row only: whether the caller can read other members' time; null on other rows. */
  teammatesVisible: boolean | null;
}

export interface SummarizeReportOptions {
  /** First local day, inclusive. Null or omitted: the local day of the first interval in scope. */
  fromDay?: string | null;
  /** Last local day, inclusive. */
  toDay: string;
  /** IANA name, e.g. `Europe/London`, or `UTC`. */
  timeZone: string;
  /** Default `day`. */
  bucket?: ReportBucket;
  /** Only these users' intervals. Null or omitted: every interval given. */
  userIds?: readonly string[] | null;
  /** Only this project's time. */
  projectId?: string | null;
  /** Only time with no project and no task. */
  unattributed?: boolean;
  /** Only this application's time. */
  applicationId?: string | null;
  /** Echoed on the total row. Default false. */
  teammatesVisible?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

export type DurationStyle = 'compact' | 'long' | 'clock';
