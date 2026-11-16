/**
 * Calendar-day keys (`YYYY-MM-DD`) and local-day boundaries in an IANA time zone.
 *
 * Day keys are plain calendar dates: arithmetic on them is done in UTC so it never depends on a
 * time zone. Converting between instants and local days reads the zone's wall clock through
 * `Intl.DateTimeFormat` with an explicit `timeZone`, never through local `Date` getters or
 * component constructors, so every result is the same whatever the host's own time zone is.
 * A day with a clock change is shorter or longer by that change (usually 23 or 25 h; 23.5 or 24.5 h
 * at Australia/Lord_Howe). A day starts at the first instant
 * whose wall-clock date is that day or later, so a skipped midnight moves forward and a repeated
 * midnight uses the earlier instant.
 *
 * Internal module: nothing here is part of the package's public API except what `index.ts`
 * re-exports.
 */

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

const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

function wallClockFormat(timeZone: string): Intl.DateTimeFormat {
  let format = wallClockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    wallClockFormats.set(timeZone, format);
  }
  return format;
}

/**
 * The wall clock of `timeZone` at instant `ms`, expressed as the UTC epoch ms that shows the same
 * fields (so `wallClockMs(ms, tz) - ms` is the zone's UTC offset at `ms`). Read through Intl with
 * an explicit zone, never through the host's local time. Callers validate `timeZone` first.
 */
function wallClockMs(ms: number, timeZone: string): number {
  let year = 1970;
  let month = 1;
  let date = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of wallClockFormat(timeZone).formatToParts(ms)) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') date = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value) % 24; // some engines print midnight as 24
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, date);
  wall.setUTCHours(hour, minute, second, 0);
  // Intl reads whole seconds; offsets are whole seconds, so the instant's milliseconds carry over.
  return wall.getTime() + (ms - Math.floor(ms / 1000) * 1000);
}

/** `YYYY-MM-DD` of the local wall-clock date containing `ms` in `timeZone`. */
export function dayKeyAt(ms: number, timeZone: string): string {
  assertInstant(ms);
  assertTimeZone(timeZone);
  return utcMsToDayKey(wallClockMs(ms, timeZone));
}

/** UTC offset of `timeZone` at instant `ms`, in ms (positive east of Greenwich). */
function offsetAt(ms: number, timeZone: string): number {
  return wallClockMs(ms, timeZone) - ms;
}

/**
 * Every UTC offset in use lies well inside ±18 h (the largest in tzdata are about ±15 h 56 min of
 * nineteenth-century local mean time), so the first instant of a local day lies within this
 * distance of its wall-clock midnight read as UTC.
 */
const OFFSET_SEARCH_MS = 18 * 3_600_000;
/** Offsets are sampled this far apart; real zones never change offset twice within it. */
const OFFSET_SAMPLE_MS = 3 * 3_600_000;

/**
 * The stretches of constant UTC offset covering `[fromMs, toMs]`, oldest first. Each transition
 * is located to the millisecond by bisection between two samples whose offsets differ.
 */
function offsetSegments(fromMs: number, toMs: number, timeZone: string): Array<{ startMs: number; offsetMs: number }> {
  const segments: Array<{ startMs: number; offsetMs: number }> = [];
  let sampleMs = fromMs;
  let sampleOffset = offsetAt(sampleMs, timeZone);
  segments.push({ startMs: fromMs, offsetMs: sampleOffset });
  while (sampleMs < toMs) {
    const nextMs = Math.min(sampleMs + OFFSET_SAMPLE_MS, toMs);
    const nextOffset = offsetAt(nextMs, timeZone);
    if (nextOffset !== sampleOffset) {
      // The offset changes in (sampleMs, nextMs]: find the first instant with the new offset.
      let low = sampleMs;
      let high = nextMs;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (offsetAt(middle, timeZone) === sampleOffset) low = middle;
        else high = middle;
      }
      segments.push({ startMs: high, offsetMs: offsetAt(high, timeZone) });
    }
    sampleMs = nextMs;
    sampleOffset = nextOffset;
  }
  return segments;
}

const DAY_START_CACHE_LIMIT = 4096;
const dayStartCache = new Map<string, number>();

/**
 * UTC ms of the first instant of local `day` in `timeZone`: the first instant whose wall-clock
 * date in `timeZone` is `day` or later. A midnight skipped by a DST change moves forward to the
 * first instant that exists (01:00 where DST starts at 00:00); a midnight repeated by a DST change
 * uses the earlier of its two instants. Days are contiguous:
 * `[startOfLocalDay(d), startOfLocalDay(d + 1))` partitions the time line. The result never
 * depends on the host's own time zone.
 */
export function startOfLocalDay(day: string, timeZone: string): number {
  const cacheKey = `${timeZone}|${day}`;
  const cached = dayStartCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const midnightAsUtc = dayKeyToUtcMs(day);
  assertTimeZone(timeZone);
  // Within one stretch of constant offset the wall clock is `t + offset`, so the first instant of
  // the stretch at or past local midnight is `max(stretch start, midnight - offset)`. The answer is
  // that instant in the earliest stretch that has one.
  const fromMs = midnightAsUtc - OFFSET_SEARCH_MS;
  const toMs = midnightAsUtc + OFFSET_SEARCH_MS;
  const segments = offsetSegments(fromMs, toMs, timeZone);
  let start = Number.NaN;
  for (const [index, segment] of segments.entries()) {
    const segmentEnd = segments[index + 1]?.startMs ?? toMs + 1;
    const candidate = Math.max(segment.startMs, midnightAsUtc - segment.offsetMs);
    if (candidate < segmentEnd) {
      start = candidate;
      break;
    }
  }
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
