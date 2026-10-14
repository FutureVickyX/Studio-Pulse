/**
 * Custom report range (the date-range picker): two `YYYY-MM-DD` calendar dates.
 *
 * Calendar arithmetic is done on UTC midnights, so the result never depends on the runtime's
 * time zone or on DST. Converting the days to instants is time-engine's job (`resolveRange`).
 */

import type { ValidationResult } from './issues';

/** Longest custom range, in calendar days counted inclusively (a full leap year fits). */
export const MAX_CUSTOM_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;
const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC midnight of a real calendar date `YYYY-MM-DD` (years 1000–9999), or null. */
function calendarDayToUtcMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = DAY_KEY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1) return null;
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  // Rejects 2026-02-30, 2025-02-29, 2026-04-31 … (Date.UTC would roll them over).
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

const DATE_MESSAGE = 'must be a real calendar date in the form YYYY-MM-DD';

/** `YYYY-MM-DD` pair for the custom range picker; start ≤ end; span ≤ 366 days. */
export function validateCustomRange(start: string, end: string): ValidationResult<{ start: string; end: string }> {
  const startMs = calendarDayToUtcMs(start);
  const endMs = calendarDayToUtcMs(end);
  const issues: string[] = [];
  if (startMs === null) issues.push(`start: ${DATE_MESSAGE}`);
  if (endMs === null) issues.push(`end: ${DATE_MESSAGE}`);
  if (startMs === null || endMs === null) return { ok: false, issues };

  if (startMs > endMs) return { ok: false, issues: ['end: must be on or after the start date'] };
  const days = Math.round((endMs - startMs) / DAY_MS) + 1;
  if (days > MAX_CUSTOM_RANGE_DAYS) {
    return {
      ok: false,
      issues: [`end: the range covers ${days} days; at most ${MAX_CUSTOM_RANGE_DAYS} days are allowed`],
    };
  }
  return { ok: true, value: { start, end } };
}
