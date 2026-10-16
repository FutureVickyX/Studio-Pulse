/**
 * Formatting glue over @studio-pulse/time-engine for the user's locale and time zone.
 */

import { formatClockTime, formatDuration } from '@studio-pulse/time-engine';

/** The UI locale (Windows display language as reported by WebView2). */
export const UI_LOCALE: string | undefined =
  typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language
    ? navigator.language
    : undefined;

export function clockTime(ms: number, timeZone: string): string {
  return formatClockTime(ms, timeZone, UI_LOCALE);
}

export function timeRange(startMs: number, endMs: number, timeZone: string, open = false): string {
  return `${clockTime(startMs, timeZone)} – ${open ? 'now' : clockTime(endMs, timeZone)}`;
}

export function duration(ms: number): string {
  return formatDuration(ms, 'compact');
}

export function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Local date and time for an ISO timestamp, e.g. `13 Oct 2026, 14:05`. */
export function dateTime(value: string | null | undefined, timeZone: string): string {
  const ms = parseIso(value);
  if (ms === null) return '—';
  return new Intl.DateTimeFormat(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(ms);
}

/** Long local date for a page header, e.g. `Tuesday 13 October`. */
export function longDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(UI_LOCALE, { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(ms);
}

const integerFormat = new Intl.NumberFormat(UI_LOCALE);

export function count(value: number): string {
  return integerFormat.format(value);
}

export function plural(value: number, one: string, many: string): string {
  return `${count(value)} ${value === 1 ? one : many}`;
}
