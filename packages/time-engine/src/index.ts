/**
 * @studio-pulse/time-engine — pure reporting maths.
 *
 * PUBLIC API CONTRACT. The desktop UI is written against exactly these exports; the code lives in
 * the sibling modules. Every function is pure: no Date.now() and no ambient time zone; callers
 * pass `now` and `timeZone`. The only exception is `currentTimeZone()`, which reads the runtime.
 * No result depends on the host's own time zone.
 *
 * - ranges.ts      resolveRange (local-day boundaries, DST-safe)
 * - intervals.ts   normalizeEvents, resolveOverlaps, clipInterval, splitByLocalDay
 * - summarize.ts   summarize (per app / category / day / week / project, timeline)
 * - reconcile.ts   reconcileIntervals, summarizeReport (the analytics RPC's twin), bucketKeyFor, monthStart
 * - days.ts        startOfLocalDay, addDays, daysBetween, enumerateDays, isoWeekStart (calendar days)
 * - format.ts      formatDuration, formatClockTime, formatDayLabel, localDayKey, currentTimeZone, formatShare
 */

export type {
  ApplicationUsage,
  CategoryUsage,
  DateRange,
  DayUsage,
  DurationStyle,
  NormalizedInterval,
  ProjectUsage,
  RangePreset,
  ReconciledPiece,
  ReconcileResult,
  ReportBucket,
  ReportDimension,
  ReportInterval,
  ReportRow,
  ResolveRangeOptions,
  SummarizeOptions,
  SummarizeReportOptions,
  TimelineSegment,
  UsageSummary,
  UsageTotals,
  WeekUsage,
} from './types';

export { resolveRange } from './ranges';
export { clipInterval, normalizeEvents, resolveOverlaps, splitByLocalDay } from './intervals';
export { summarize } from './summarize';
export { bucketKeyFor, monthStart, reconcileIntervals, summarizeReport } from './reconcile';
export { addDays, daysBetween, enumerateDays, isoWeekStart, startOfLocalDay } from './days';
export {
  currentTimeZone,
  formatClockTime,
  formatDayLabel,
  formatDuration,
  formatShare,
  localDayKey,
} from './format';
