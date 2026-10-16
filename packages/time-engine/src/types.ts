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
// Formatting
// ---------------------------------------------------------------------------------------------

export type DurationStyle = 'compact' | 'long' | 'clock';
