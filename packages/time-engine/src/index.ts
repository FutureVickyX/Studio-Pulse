/**
 * @studio-pulse/time-engine — pure reporting maths.
 *
 * PUBLIC API CONTRACT. The desktop UI is written against exactly these exports; the code lives in
 * the sibling modules. Every function is pure: no Date.now() and no ambient time zone; callers
 * pass `now` and `timeZone`. The only exception is `currentTimeZone()`, which reads the runtime.
 *
 * - ranges.ts      resolveRange (local-day boundaries via @date-fns/tz, DST-safe)
 * - intervals.ts   normalizeEvents, resolveOverlaps, clipInterval, splitByLocalDay
 * - summarize.ts   summarize (per app / category / day / week / project, timeline)
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
  ResolveRangeOptions,
  SummarizeOptions,
  TimelineSegment,
  UsageSummary,
  UsageTotals,
  WeekUsage,
} from './types';

export { resolveRange } from './ranges';
export { clipInterval, normalizeEvents, resolveOverlaps, splitByLocalDay } from './intervals';
export { summarize } from './summarize';
export {
  currentTimeZone,
  formatClockTime,
  formatDayLabel,
  formatDuration,
  formatShare,
  localDayKey,
} from './format';
