/**
 * Calendar-day keys (`YYYY-MM-DD`) and local-day boundaries in an IANA time zone.
 *
 * Day keys are plain calendar dates: arithmetic on them is done in UTC so it never depends on a
 * time zone. Converting between instants and local days goes through `TZDate` from @date-fns/tz,
 * so days that contain a DST transition are 23 or 25 hours long, and a day whose midnight does
 * not exist (DST starting at 00:00) begins at the first instant that does.
 *
 * Internal module: nothing here is part of the package's public API except what `index.ts`
 * re-exports.
 */

import { TZDate } from '@date-fns/tz';

export const DAY_MS = 86_400_000;

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DayParts {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
}

/** Parse a real calendar date `YYYY-MM-DD` (years 1000–9999). Returns null when invalid. */
export function parseDayKey(value: unknown): DayParts | null {
  if (typeof value !== 'string') return null;
  const match = DAY_KEY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

export function isDayKey(value: unknown): value is string {
  return parseDayKey(value) !== null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function formatDayKey(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function requireDayKey(day: string): DayParts {
  const parts = parseDayKey(day);
  if (!parts) throw new RangeError(`Invalid calendar day "${day}" (expected YYYY-MM-DD)`);
  return parts;
}

/** UTC midnight of the calendar date. Only for calendar arithmetic, never for local boundaries. */
export function dayKeyToUtcMs(day: string): number {
  const { year, month, day: date } = requireDayKey(day);
  return Date.UTC(year, month - 1, date);
}

function utcMsToDayKey(ms: number): string {
  const date = new Date(ms);
  return formatDayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Calendar arithmetic: `addDays('2026-02-28', 1) === '2026-03-01'`. */
export function addDays(day: string, amount: number): string {
  return utcMsToDayKey(dayKeyToUtcMs(day) + amount * DAY_MS);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayKeyToUtcMs(to) - dayKeyToUtcMs(from)) / DAY_MS);
}

/** Every calendar day from `first` to `last` inclusive (empty when `first > last`). */
export function enumerateDays(first: string, last: string): string[] {
  const count = daysBetween(first, last) + 1;
  const days: string[] = [];
  for (let index = 0; index < count; index += 1) days.push(addDays(first, index));
  return days;
}

/** The Monday on or before `day` (ISO weeks start on Monday). */
export function isoWeekStart(day: string): string {
  const weekday = new Date(dayKeyToUtcMs(day)).getUTCDay(); // 0 = Sunday
  const sinceMonday = (weekday + 6) % 7;
  return addDays(day, -sinceMonday);
}

// ---------------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------------

const knownTimeZones = new Set<string>();

/** Throws a RangeError for anything that is not a time zone the runtime's Intl understands. */
export function assertTimeZone(timeZone: string): void {
  if (knownTimeZones.has(timeZone)) return;
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new RangeError('A time zone is required');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new RangeError(`Unknown time zone "${timeZone}"`);
  }
  knownTimeZones.add(timeZone);
}

function assertInstant(ms: number): void {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new RangeError(`Invalid timestamp ${String(ms)}`);
  }
}

/** `YYYY-MM-DD` of the local wall-clock date containing `ms` in `timeZone`. */
export function dayKeyAt(ms: number, timeZone: string): string {
  assertInstant(ms);
  assertTimeZone(timeZone);
  const local = new TZDate(ms, timeZone);
  return formatDayKey(local.getFullYear(), local.getMonth() + 1, local.getDate());
}

const DAY_START_CACHE_LIMIT = 4096;
const dayStartCache = new Map<string, number>();

/**
 * UTC ms of the first instant of local `day` in `timeZone`. Days are contiguous:
 * `[startOfLocalDay(d), startOfLocalDay(d + 1))` partitions the time line.
 */
export function startOfLocalDay(day: string, timeZone: string): number {
  const cacheKey = `${timeZone}|${day}`;
  const cached = dayStartCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { year, month, day: date } = requireDayKey(day);
  assertTimeZone(timeZone);
  // TZDate interprets the components in `timeZone`; a non-existent local midnight is moved forward
  // to the first existing instant (e.g. 01:00 where DST starts at 00:00).
  const start = new TZDate(year, month - 1, date, timeZone).getTime();
  if (!Number.isFinite(start)) throw new RangeError(`Cannot resolve ${day} in ${timeZone}`);

  if (dayStartCache.size >= DAY_START_CACHE_LIMIT) dayStartCache.clear();
  dayStartCache.set(cacheKey, start);
  return start;
}

/**
 * The local day (by the boundaries of `startOfLocalDay`) that contains `ms`. Normally equal to
 * `dayKeyAt`; differs only inside a repeated hour that crosses midnight, where the wall clock
 * shows the later date while the instant still belongs to the earlier day.
 */
export function localDayContaining(ms: number, timeZone: string): string {
  let day = dayKeyAt(ms, timeZone);
  while (startOfLocalDay(day, timeZone) > ms) day = addDays(day, -1);
  while (startOfLocalDay(addDays(day, 1), timeZone) <= ms) day = addDays(day, 1);
  return day;
}
