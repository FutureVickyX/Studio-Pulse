/**
 * Display formatting for durations, clock times, day labels and shares.
 */

import { addDays, assertTimeZone, localDayContaining, parseDayKey } from './days';
import { dateTimeFormat, formatCalendarDate } from './intl';
import { DEFAULT_LOCALE } from './ranges';
import type { DurationStyle } from './types';

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * - compact: `0m`, `45s` (under a minute only when > 0 and < 60 s), `12m`, `1h 05m`, `26h 10m`
 * - long:    `1 hour 5 minutes`
 * - clock:   `1:05:09` (live counters)
 *
 * Values are truncated (never rounded up). Negative and non-finite input is treated as 0.
 */
export function formatDuration(ms: number, style: DurationStyle = 'compact'): string {
  const value = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  const hours = Math.floor(value / HOUR_MS);
  const minutes = Math.floor((value % HOUR_MS) / MINUTE_MS);

  if (style === 'clock') {
    const seconds = Math.floor((value % MINUTE_MS) / SECOND_MS);
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  }

  if (style === 'long') {
    if (value === 0) return '0 minutes';
    if (value < MINUTE_MS) return plural(Math.max(1, Math.floor(value / SECOND_MS)), 'second');
    const parts: string[] = [];
    if (hours > 0) parts.push(plural(hours, 'hour'));
    if (minutes > 0) parts.push(plural(minutes, 'minute'));
    return parts.join(' ');
  }

  if (value === 0) return '0m';
  if (value < MINUTE_MS) return `${Math.max(1, Math.floor(value / SECOND_MS))}s`;
  return hours > 0 ? `${hours}h ${pad2(minutes)}m` : `${minutes}m`;
}

/** Local wall-clock time, e.g. `14:05` (locale-aware 12/24 h). */
export function formatClockTime(ms: number, timeZone: string, locale: string = DEFAULT_LOCALE): string {
  assertTimeZone(timeZone);
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new RangeError(`Invalid timestamp ${String(ms)}`);
  return dateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(ms);
}

/**
 * `Today`, `Yesterday`, otherwise e.g. `Mon 12 Oct` (the year is added when it differs from the
 * current local year). Throws a RangeError for a malformed day key.
 */
export function formatDayLabel(day: string, timeZone: string, now: number, locale: string = DEFAULT_LOCALE): string {
  if (!parseDayKey(day)) throw new RangeError(`Invalid calendar day "${day}" (expected YYYY-MM-DD)`);
  const today = localDayKey(now, timeZone);
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  const withYear = day.slice(0, 4) !== today.slice(0, 4);
  return formatCalendarDate(day, locale, { weekday: 'short', day: 'numeric', month: 'short' }, withYear);
}

/** `YYYY-MM-DD` of the local day containing `ms` in `timeZone`. */
export function localDayKey(ms: number, timeZone: string): string {
  return localDayContaining(ms, timeZone);
}

/** The runtime's IANA time zone (falls back to `UTC`). The only impure helper. */
export function currentTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.length > 0 ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Percentage string for a 0..1 share, e.g. `42%`, `<1%`, `0%`, `100%`. Rounded to the nearest
 * whole percent, except that a share above 0 that would round to `0%` is shown as `<1%`, so a
 * sliver of recorded time is never displayed as nothing. Non-finite or negative input is `0%`;
 * anything at or above 1 is `100%`.
 */
export function formatShare(share: number): string {
  if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0) return '0%';
  if (share >= 1) return '100%';
  if (share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
}
