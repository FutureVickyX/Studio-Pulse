/**
 * Interval hygiene: parsing, de-duplication, overlap resolution, clipping and day splitting.
 *
 * Totals are always re-derived from timestamps and `kind`, never trusted from the stored
 * `activeSeconds` / `idleSeconds`, so every figure in a report adds up exactly.
 */

import type { IntervalKind, TrackingEvent, TrackingSource } from '@studio-pulse/shared-types';

import { addDays, localDayContaining, startOfLocalDay } from './days';
import type { NormalizedInterval } from './types';

// ---------------------------------------------------------------------------------------------
// ISO-8601 parsing
// ---------------------------------------------------------------------------------------------

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parse an ISO-8601 instant with an explicit offset (`Z` or `±HH:MM`) to epoch ms.
 * Rejects impossible calendar dates (Feb 30), out-of-range clock fields and timestamps without
 * an offset (those would be read in the runtime's ambient zone). Returns NaN when invalid.
 */
export function parseIsoInstant(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const match = ISO_INSTANT.exec(value);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s, fraction, zulu, sign, oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  const millis = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return Number.NaN;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return Number.NaN;
  }
  date.setUTCHours(hour, minute, second, millis);

  let offsetMinutes = 0;
  if (zulu === undefined) {
    const offsetHours = Number(oh);
    const offsetMins = Number(om);
    if (offsetHours > 23 || offsetMins > 59) return Number.NaN;
    offsetMinutes = (sign === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  return date.getTime() - offsetMinutes * 60_000;
}

// ---------------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------------

function isKind(value: unknown): value is IntervalKind {
  return value === 'active' || value === 'idle';
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeOne(event: TrackingEvent): NormalizedInterval | null {
  if (typeof event !== 'object' || event === null) return null;
  if (!nonEmptyString(event.id) || !nonEmptyString(event.applicationId)) return null;
  if (typeof event.deviceId !== 'string' || !isKind(event.kind)) return null;

  const startMs = parseIsoInstant(event.startedAt);
  const endMs = parseIsoInstant(event.endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  const duration = endMs - startMs;
  const source: TrackingSource = event.source === 'manual' ? 'manual' : 'automatic';
  return {
    id: event.id,
    deviceId: event.deviceId,
    applicationId: event.applicationId,
    applicationName: nonEmptyString(event.applicationName) ? event.applicationName : event.applicationId,
    kind: event.kind,
    startMs,
    endMs,
    activeMs: event.kind === 'active' ? duration : 0,
    idleMs: event.kind === 'idle' ? duration : 0,
    projectId: nullableString(event.projectId),
    taskId: nullableString(event.taskId),
    source,
    open: event.state === 'open',
  };
}

function compareIntervals(a: NormalizedInterval, b: NormalizedInterval): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || compareStrings(a.id, b.id);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parse ISO timestamps, drop malformed or zero-length records, and de-duplicate by `id` (highest
 * `revision` wins, then the later `endedAt`). Re-derives active/idle ms from the timestamps.
 * The result is sorted by start time (then end, then id).
 */
export function normalizeEvents(events: readonly TrackingEvent[]): NormalizedInterval[] {
  const byId = new Map<string, { interval: NormalizedInterval; revision: number }>();
  for (const event of events) {
    const interval = normalizeOne(event);
    if (!interval) continue;
    const revision = Number.isFinite(event.revision) ? event.revision : 0;
    const existing = byId.get(interval.id);
    if (
      !existing ||
      revision > existing.revision ||
      (revision === existing.revision && interval.endMs > existing.interval.endMs)
    ) {
      byId.set(interval.id, { interval, revision });
    }
  }
  return [...byId.values()].map((entry) => entry.interval).sort(compareIntervals);
}

// ---------------------------------------------------------------------------------------------
// Overlaps and clipping
// ---------------------------------------------------------------------------------------------

/**
 * Defence in depth: on each device, an instant may be counted once only. Later-starting intervals
 * are clipped to begin where the previous one ended; fully covered intervals are dropped.
 * Intervals on different devices are never clipped against each other.
 */
export function resolveOverlaps(intervals: readonly NormalizedInterval[]): {
  intervals: NormalizedInterval[];
  clippedMs: number;
} {
  const byDevice = new Map<string, NormalizedInterval[]>();
  for (const interval of intervals) {
    const list = byDevice.get(interval.deviceId);
    if (list) list.push(interval);
    else byDevice.set(interval.deviceId, [interval]);
  }

  const result: NormalizedInterval[] = [];
  let clippedMs = 0;
  for (const list of byDevice.values()) {
    list.sort((a, b) => a.startMs - b.startMs || compareStrings(a.id, b.id));
    let highWater = Number.NEGATIVE_INFINITY;
    for (const interval of list) {
      if (interval.endMs <= highWater) {
        clippedMs += interval.endMs - interval.startMs;
        continue;
      }
      if (interval.startMs < highWater) {
        const clipped = clipInterval(interval, highWater, interval.endMs);
        clippedMs += highWater - interval.startMs;
        if (clipped) result.push(clipped);
      } else {
        result.push(interval);
      }
      highWater = interval.endMs;
    }
  }
  result.sort(compareIntervals);
  return { intervals: result, clippedMs };
}

/**
 * Active ms credited to `interval` between its start and instant `t` (inside the interval),
 * spread evenly. Cumulative, so adjacent pieces cut at the same instants always sum exactly to
 * the interval's own activeMs.
 */
function activeBefore(interval: NormalizedInterval, t: number): number {
  if (t <= interval.startMs) return 0;
  if (t >= interval.endMs) return interval.activeMs;
  if (interval.idleMs <= 0) return t - interval.startMs;
  if (interval.activeMs <= 0) return 0;
  return Math.round((interval.activeMs * (t - interval.startMs)) / (interval.endMs - interval.startMs));
}

/**
 * Clip to [startMs, endMs). Active/idle ms scale proportionally. Returns null if nothing remains.
 * `open` is kept only when the clipped piece still ends where the interval ends (the live edge).
 */
export function clipInterval(
  interval: NormalizedInterval,
  startMs: number,
  endMs: number,
): NormalizedInterval | null {
  const start = Math.max(interval.startMs, startMs);
  const end = Math.min(interval.endMs, endMs);
  if (!(end > start)) return null;
  if (start === interval.startMs && end === interval.endMs) return { ...interval };

  const duration = end - start;
  const activeMs = Math.min(duration, Math.max(0, activeBefore(interval, end) - activeBefore(interval, start)));

  return {
    ...interval,
    startMs: start,
    endMs: end,
    activeMs,
    idleMs: duration - activeMs,
    open: interval.open && end === interval.endMs,
  };
}

// ---------------------------------------------------------------------------------------------
// Local days
// ---------------------------------------------------------------------------------------------

/** Split intervals at local midnight in `timeZone`. Returns one piece per (day, interval). */
export function splitByLocalDay(
  intervals: readonly NormalizedInterval[],
  timeZone: string,
): Array<{ day: string; interval: NormalizedInterval }> {
  const pieces: Array<{ day: string; interval: NormalizedInterval }> = [];
  for (const interval of intervals) {
    let day = localDayContaining(interval.startMs, timeZone);
    let cursor = interval.startMs;
    while (cursor < interval.endMs) {
      const nextDay = addDays(day, 1);
      const boundary = startOfLocalDay(nextDay, timeZone);
      const pieceEnd = Math.min(boundary, interval.endMs);
      const piece = clipInterval(interval, cursor, pieceEnd);
      if (piece) pieces.push({ day, interval: piece });
      cursor = pieceEnd;
      day = nextDay;
    }
  }
  return pieces;
}
