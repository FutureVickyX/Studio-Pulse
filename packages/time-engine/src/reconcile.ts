/**
 * Analytics reconciliation and report summaries: the TypeScript twin of the
 * `public.analytics_time_summary` RPC (see docs/analytics.md).
 *
 * Rule. Within one user, each instant belongs to the first interval in (start, end, id) order
 * among that user's active intervals covering it; if no active interval covers it, to the first
 * such interval among the user's idle intervals. Ordering uses the whole (unclipped) intervals, so
 * attribution never depends on the report range. Different users are never reconciled against each
 * other. Reconciled foreground time is therefore the union of each user's intervals.
 *
 * This is deliberately separate from `resolveOverlaps` (per device, ties broken by (start, id),
 * active and idle alike), which the desktop reports keep using unchanged.
 *
 * `summarizeReport` returns exactly the rows the RPC returns, in the same order, for the same
 * input rows: callers pass only the intervals the viewer may read (it does not authorize).
 * Strings (ids, uuids) are ordered by code point, like PostgreSQL's `collate "C"` and uuid order
 * for lowercase hex, never by locale.
 */

import {
  addDays,
  assertTimeZone,
  dayKeyAt,
  daysBetween,
  isoWeekStart,
  localDayContaining,
  parseDayKey,
  startOfLocalDay,
} from './days';
import type {
  ReconciledPiece,
  ReconcileResult,
  ReportBucket,
  ReportDimension,
  ReportInterval,
  ReportRow,
  SummarizeReportOptions,
} from './types';

// ---------------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------------

/**
 * Code point order (the order of UTF-8 bytes). Plain `<` compares UTF-16 code units, which puts a
 * character above U+FFFF (a surrogate pair) before U+E000–U+FFFF; this corrects that case.
 */
function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.charCodeAt(index);
    const y = b.charCodeAt(index);
    if (x === y) continue;
    const xSurrogate = x >= 0xd800 && x <= 0xdfff;
    const ySurrogate = y >= 0xd800 && y <= 0xdfff;
    if (xSurrogate !== ySurrogate) return xSurrogate ? 1 : -1;
    return x - y;
  }
  return a.length - b.length;
}

/** Ascending, nulls last. */
function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareCodePoints(a, b);
}

/** Ascending (false before true), nulls last. */
function compareNullableBooleans(a: boolean | null, b: boolean | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a ? 1 : -1;
}

interface Span {
  startMs: number;
  endMs: number;
}

interface Row extends Span {
  interval: ReportInterval;
}

/** (start, end, id): the order in which intervals claim time. */
function compareRows(a: Row, b: Row): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || compareCodePoints(a.interval.id, b.interval.id);
}

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------

function requireRange(range: { startMs: number; endMs: number }): void {
  if (
    typeof range !== 'object' ||
    range === null ||
    !Number.isFinite(range.startMs) ||
    !Number.isFinite(range.endMs) ||
    range.endMs < range.startMs
  ) {
    throw new RangeError('reconcileIntervals: the range needs finite startMs <= endMs');
  }
}

/** Interval bounds truncated to whole milliseconds, as the RPC truncates timestamps. */
function toRow(interval: ReportInterval): Row {
  if (interval.kind !== 'active' && interval.kind !== 'idle') {
    throw new RangeError(`reconcileIntervals: interval "${interval.id}" has an unknown kind`);
  }
  if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs)) {
    throw new RangeError(`reconcileIntervals: interval "${interval.id}" has an invalid start or end`);
  }
  return { interval, startMs: Math.floor(interval.startMs), endMs: Math.floor(interval.endMs) };
}

interface SweptPiece extends Span {
  row: Row;
}

/**
 * High-water sweep over one user's intervals of one kind, in (start, end, id) order: each interval
 * keeps the part after every earlier interval's end. Pieces are clipped to the range afterwards,
 * so the result is disjoint and in start order.
 */
function sweep(rows: Row[], range: Span): SweptPiece[] {
  rows.sort(compareRows);
  const pieces: SweptPiece[] = [];
  let highWater = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const startMs = Math.max(row.startMs, highWater, range.startMs);
    const endMs = Math.min(row.endMs, range.endMs);
    if (startMs < endMs) pieces.push({ row, startMs, endMs });
    highWater = Math.max(highWater, row.endMs);
  }
  return pieces;
}

function toPiece(row: Row, startMs: number, endMs: number): ReconciledPiece {
  const { interval } = row;
  return {
    id: interval.id,
    userId: interval.userId,
    deviceId: interval.deviceId,
    applicationId: interval.applicationId,
    applicationName: interval.applicationName,
    kind: interval.kind,
    startMs,
    endMs,
    projectId: interval.projectId,
    taskId: interval.taskId,
    sourceStartMs: row.startMs,
    sourceEndMs: row.endMs,
  };
}

/**
 * Reconcile intervals within `range` (`[startMs, endMs)`, UTC epoch ms): per user, active time
 * beats idle time and the first interval in (start, end, id) order wins among intervals of the
 * same kind. Every instant of the range covered by a user's intervals is in exactly one of that
 * user's pieces. Interval ids must be unique (they are the table's primary key).
 */
export function reconcileIntervals(
  intervals: readonly ReportInterval[],
  range: { startMs: number; endMs: number },
): ReconcileResult {
  requireRange(range);
  const seen = new Set<string>();
  const byUser = new Map<string, { active: Row[]; idle: Row[] }>();
  let rawMs = 0;
  for (const interval of intervals) {
    if (seen.has(interval.id)) throw new RangeError(`reconcileIntervals: interval id "${interval.id}" is repeated`);
    seen.add(interval.id);
    const row = toRow(interval);
    const clippedMs = Math.min(row.endMs, range.endMs) - Math.max(row.startMs, range.startMs);
    if (!(clippedMs > 0)) continue;
    rawMs += clippedMs;
    let lists = byUser.get(interval.userId);
    if (!lists) {
      lists = { active: [], idle: [] };
      byUser.set(interval.userId, lists);
    }
    lists[interval.kind].push(row);
  }

  const pieces: ReconciledPiece[] = [];
  const users = [...byUser.keys()].sort(compareCodePoints);
  for (const user of users) {
    const lists = byUser.get(user);
    if (!lists) continue;
    const active = sweep(lists.active, range);
    const idle = sweep(lists.idle, range);
    const userPieces: ReconciledPiece[] = active.map((piece) => toPiece(piece.row, piece.startMs, piece.endMs));

    // Active beats idle: keep the parts of each idle candidate that no active piece covers. Both
    // lists are disjoint and in start order, so one forward pass over the active pieces suffices.
    let first = 0;
    for (const candidate of idle) {
      for (let cover = active[first]; cover && cover.endMs <= candidate.startMs; cover = active[first]) first += 1;
      let cursor = candidate.startMs;
      for (let index = first; index < active.length && cursor < candidate.endMs; index += 1) {
        const cover = active[index];
        if (!cover || cover.startMs >= candidate.endMs) break;
        if (cover.startMs > cursor) userPieces.push(toPiece(candidate.row, cursor, cover.startMs));
        cursor = Math.max(cursor, cover.endMs);
      }
      if (cursor < candidate.endMs) userPieces.push(toPiece(candidate.row, cursor, candidate.endMs));
    }

    userPieces.sort((a, b) => a.startMs - b.startMs);
    pieces.push(...userPieces);
  }
  return { pieces, rawMs };
}

// ---------------------------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------------------------

const BUCKETS: readonly ReportBucket[] = ['day', 'week', 'month'];

function isBucket(value: unknown): value is ReportBucket {
  return typeof value === 'string' && (BUCKETS as readonly string[]).includes(value);
}

/** The 1st of the month containing `day`: `monthStart('2026-11-12') === '2026-11-01'`. */
export function monthStart(day: string): string {
  if (!parseDayKey(day)) throw new RangeError(`Invalid calendar day "${day}" (expected YYYY-MM-DD)`);
  return `${day.slice(0, 8)}01`;
}

/** The first day of the bucket containing local `day`: the day, the ISO week's Monday or the 1st. */
export function bucketKeyFor(day: string, bucket: ReportBucket): string {
  if (!parseDayKey(day)) throw new RangeError(`Invalid calendar day "${day}" (expected YYYY-MM-DD)`);
  switch (bucket) {
    case 'day':
      return day;
    case 'week':
      return isoWeekStart(day);
    case 'month':
      return monthStart(day);
    default:
      throw new RangeError(`Unknown bucket "${String(bucket)}" (expected day, week or month)`);
  }
}

// ---------------------------------------------------------------------------------------------
// Report summary
// ---------------------------------------------------------------------------------------------

/** The same limits the RPC enforces (it answers errcode 22023). */
const FIRST_REPORT_DAY = '2020-01-01';
const END_OF_REPORT_DAYS = '2100-01-01';
const MAX_SPAN_DAYS = 366;
const MAX_PROJECT_SPAN_DAYS: Readonly<Record<ReportBucket, number>> = { day: 366, week: 1100, month: 3660 };
const MAX_USER_IDS = 500;
/** IANA names (or UTC) only: no POSIX strings such as `UTC+3` and no abbreviations such as `CET`. */
const TIME_ZONE_NAME = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+)+)$/;

function requireTimeZone(timeZone: unknown): string {
  if (typeof timeZone !== 'string' || !TIME_ZONE_NAME.test(timeZone)) {
    throw new RangeError('Choose the reporting time zone by its IANA name: unknown time zone.');
  }
  try {
    assertTimeZone(timeZone);
  } catch {
    throw new RangeError('Choose the reporting time zone by its IANA name: unknown time zone.');
  }
  return timeZone;
}

function requireDay(value: unknown, what: string): string {
  if (!parseDayKey(value)) throw new RangeError(`The ${what} must be a calendar date (YYYY-MM-DD).`);
  return value as string;
}

const DIMENSION_RANK: Readonly<Record<ReportDimension, number>> = {
  total: 0,
  period: 1,
  member: 2,
  project: 3,
  task: 4,
  application: 5,
};

/** Dimension rank, then bucket, user, project, unattributed, task, application; nulls last. */
function compareReportRows(a: ReportRow, b: ReportRow): number {
  return (
    DIMENSION_RANK[a.dimension] - DIMENSION_RANK[b.dimension] ||
    compareNullableStrings(a.bucketStart, b.bucketStart) ||
    compareNullableStrings(a.userId, b.userId) ||
    compareNullableStrings(a.projectId, b.projectId) ||
    compareNullableBooleans(a.unattributed, b.unattributed) ||
    compareNullableStrings(a.taskId, b.taskId) ||
    compareNullableStrings(a.applicationId, b.applicationId)
  );
}

interface Accumulator {
  row: ReportRow;
  entries: Set<string>;
  /** Application rows: the contributing interval with the latest (start, id) names the row. */
  latest: { startMs: number; id: string } | null;
}

function emptyRow(dimension: ReportDimension): ReportRow {
  return {
    dimension,
    bucketStart: null,
    userId: null,
    applicationId: null,
    applicationName: null,
    projectId: null,
    taskId: null,
    unattributed: null,
    activeMs: 0,
    idleMs: 0,
    entryCount: 0,
    overlapMs: 0,
    teammatesVisible: null,
  };
}

/**
 * The analytics report for local days `fromDay..toDay` in `timeZone`: exactly the rows of
 * `public.analytics_time_summary` (camelCase), in the same order. Rows: one `total` (always first,
 * even with no time), then `period` rows (buckets with time), `member`, `project` (grouped by
 * project and the unattributed flag), `task` (by project and task) and `application` rows, each
 * only where active + idle > 0.
 *
 * - Reconciliation (see the module comment) runs over every given interval of the selected users;
 *   the project, unattributed and application filters apply afterwards, so a filtered figure is
 *   always part of the unfiltered one. Unattributed means no project and no task.
 * - Pieces are split at local midnight; weeks (ISO, Monday) and months roll up days.
 * - `overlapMs` = the clipped durations of the intervals that pass the filters minus their
 *   reconciled time.
 * - `fromDay` null: from the local date of the earliest interval that passes the user and the
 *   filters and starts before the end of `toDay`; just `toDay` when there is none.
 *
 * Throws a RangeError (a plain sentence; a zone error mentions "time zone") for input the RPC
 * rejects with errcode 22023. It does not authorize: pass only the intervals the viewer may read.
 */
export function summarizeReport(intervals: readonly ReportInterval[], options: SummarizeReportOptions): ReportRow[] {
  const bucket = options.bucket ?? 'day';
  const projectId = options.projectId ?? null;
  const unattributed = options.unattributed ?? false;
  const applicationId = options.applicationId ?? null;
  const userIds = options.userIds ?? null;

  const toDay = requireDay(options.toDay, 'last day');
  if (!isBucket(bucket)) throw new RangeError('The bucket must be day, week or month.');
  const timeZone = requireTimeZone(options.timeZone);
  const requestedFrom = options.fromDay ?? null;
  if (requestedFrom !== null) {
    requireDay(requestedFrom, 'first day');
    if (toDay < requestedFrom) throw new RangeError('The last day must not be before the first day.');
    if (requestedFrom < FIRST_REPORT_DAY) throw new RangeError('Reports start on 1 January 2020 or later.');
  }
  // The RPC refuses a last day before 2020 even without a first day (an earlier first day is then
  // only possible from the data: a row on 1 January 2020 UTC is still 31 December 2019 further west).
  if (toDay < FIRST_REPORT_DAY) throw new RangeError('Reports start on 1 January 2020 or later.');
  if (toDay >= END_OF_REPORT_DAYS) throw new RangeError('Reports must end before 1 January 2100.');

  const users = userIds === null ? null : new Set(userIds);
  const selected = users === null ? intervals : intervals.filter((interval) => users.has(interval.userId));
  const passes = (item: { projectId: string | null; taskId: string | null; applicationId: string }) =>
    (projectId === null || item.projectId === projectId) &&
    (!unattributed || (item.projectId === null && item.taskId === null)) &&
    (applicationId === null || item.applicationId === applicationId);

  const endMs = startOfLocalDay(addDays(toDay, 1), timeZone);
  let fromDay = requestedFrom;
  if (fromDay === null) {
    let firstMs = Number.POSITIVE_INFINITY;
    for (const interval of selected) {
      const startMs = Math.floor(interval.startMs);
      if (startMs < endMs && startMs < firstMs && passes(interval)) firstMs = startMs;
    }
    fromDay = Number.isFinite(firstMs) ? dayKeyAt(firstMs, timeZone) : toDay;
    if (fromDay > toDay) fromDay = toDay;
  }

  const spanDays = daysBetween(fromDay, toDay) + 1;
  const maxSpan = projectId === null ? MAX_SPAN_DAYS : MAX_PROJECT_SPAN_DAYS[bucket];
  if (spanDays > maxSpan) {
    throw new RangeError(
      projectId === null
        ? `A report can cover at most ${MAX_SPAN_DAYS} days.`
        : `A project report by ${bucket} can cover at most ${maxSpan} days.`,
    );
  }
  if (userIds !== null && userIds.length > MAX_USER_IDS) {
    throw new RangeError(`A report can include at most ${MAX_USER_IDS} people.`);
  }
  if (projectId !== null && unattributed) {
    throw new RangeError('Choose a project or unattributed time, not both.');
  }

  const startMs = startOfLocalDay(fromDay, timeZone);
  const { pieces } = reconcileIntervals(selected, { startMs, endMs });

  // Overlap after filters: raw in-range time of the intervals that pass, minus their pieces.
  let overlapMs = 0;
  for (const interval of selected) {
    if (!passes(interval)) continue;
    const clippedMs = Math.min(Math.floor(interval.endMs), endMs) - Math.max(Math.floor(interval.startMs), startMs);
    if (clippedMs > 0) overlapMs += clippedMs;
  }

  const total: Accumulator = { row: emptyRow('total'), entries: new Set(), latest: null };
  const groups = new Map<string, Accumulator>();
  const accumulator = (key: string, make: () => ReportRow): Accumulator => {
    let entry = groups.get(key);
    if (!entry) {
      entry = { row: make(), entries: new Set(), latest: null };
      groups.set(key, entry);
    }
    return entry;
  };
  const add = (entry: Accumulator, piece: ReconciledPiece, ms: number) => {
    if (piece.kind === 'active') entry.row.activeMs += ms;
    else entry.row.idleMs += ms;
    entry.entries.add(piece.id);
  };

  for (const piece of pieces) {
    if (!passes(piece)) continue;
    overlapMs -= piece.endMs - piece.startMs;

    const isUnattributed = piece.projectId === null && piece.taskId === null;
    const member = accumulator(JSON.stringify(['member', piece.userId]), () => ({ ...emptyRow('member'), userId: piece.userId }));
    const project = accumulator(JSON.stringify(['project', piece.projectId, isUnattributed]), () => ({
      ...emptyRow('project'),
      projectId: piece.projectId,
      unattributed: isUnattributed,
    }));
    const task = accumulator(JSON.stringify(['task', piece.projectId, piece.taskId]), () => ({
      ...emptyRow('task'),
      projectId: piece.projectId,
      taskId: piece.taskId,
    }));
    const application = accumulator(JSON.stringify(['application', piece.applicationId]), () => ({
      ...emptyRow('application'),
      applicationId: piece.applicationId,
    }));
    const latest = application.latest;
    if (
      latest === null ||
      piece.sourceStartMs > latest.startMs ||
      (piece.sourceStartMs === latest.startMs && compareCodePoints(piece.id, latest.id) > 0)
    ) {
      application.latest = { startMs: piece.sourceStartMs, id: piece.id };
      application.row.applicationName = piece.applicationName;
    }

    // Split at local midnight; each day's part goes to its period bucket.
    let day = localDayContaining(piece.startMs, timeZone);
    let cursor = piece.startMs;
    while (cursor < piece.endMs) {
      const nextDay = addDays(day, 1);
      const partEnd = Math.min(startOfLocalDay(nextDay, timeZone), piece.endMs);
      const ms = partEnd - cursor;
      if (ms > 0) {
        const bucketStart = bucketKeyFor(day, bucket);
        const period = accumulator(JSON.stringify(['period', bucketStart]), () => ({ ...emptyRow('period'), bucketStart }));
        for (const entry of [total, period, member, project, task, application]) add(entry, piece, ms);
      }
      cursor = Math.max(cursor, partEnd);
      day = nextDay;
    }
  }

  total.row.entryCount = total.entries.size;
  total.row.overlapMs = overlapMs;
  total.row.teammatesVisible = options.teammatesVisible ?? false;

  const rows: ReportRow[] = [];
  for (const entry of groups.values()) {
    if (entry.row.activeMs + entry.row.idleMs <= 0) continue;
    entry.row.entryCount = entry.entries.size;
    rows.push(entry.row);
  }
  rows.sort(compareReportRows);
  return [total.row, ...rows];
}
