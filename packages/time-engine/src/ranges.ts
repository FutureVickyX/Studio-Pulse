/**
 * Report ranges: presets resolved to local-day boundaries in a given time zone.
 */

import {
  addDays,
  assertTimeZone,
  enumerateDays,
  localDayContaining,
  parseDayKey,
  startOfLocalDay,
} from './days';
import { formatCalendarDate } from './intl';
import type { DateRange, RangePreset, ResolveRangeOptions } from './types';

export const DEFAULT_LOCALE = 'en-GB';

const PRESET_SPANS: Readonly<Record<Exclude<RangePreset, 'custom'>, { back: number; days: number; label: string }>> = {
  today: { back: 0, days: 1, label: 'Today' },
  yesterday: { back: 1, days: 1, label: 'Yesterday' },
  last7: { back: 0, days: 7, label: 'Last 7 days' },
  last30: { back: 0, days: 30, label: 'Last 30 days' },
};

/** Resolve a preset to local-day boundaries in `timeZone` (DST-safe: days may be 23 or 25 h). */
export function resolveRange(preset: RangePreset, options: ResolveRangeOptions): DateRange {
  const { now, timeZone } = options;
  const locale = options.locale ?? DEFAULT_LOCALE;
  assertTimeZone(timeZone);
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new RangeError(`resolveRange: "now" must be a finite epoch-ms number`);
  }

  const today = localDayContaining(now, timeZone);
  let first: string;
  let last: string;
  let label: string;

  if (preset === 'custom') {
    const start = options.customStart;
    const end = options.customEnd;
    if (start === undefined || end === undefined) {
      throw new RangeError('resolveRange: a custom range needs customStart and customEnd');
    }
    if (!parseDayKey(start)) throw new RangeError(`resolveRange: invalid customStart "${start}"`);
    if (!parseDayKey(end)) throw new RangeError(`resolveRange: invalid customEnd "${end}"`);
    if (start > end) throw new RangeError(`resolveRange: customStart ${start} is after customEnd ${end}`);
    first = start;
    last = end;
    label = customRangeLabel(first, last, today, locale);
  } else {
    const span = PRESET_SPANS[preset];
    if (!span) throw new RangeError(`resolveRange: unknown preset "${String(preset)}"`);
    last = addDays(today, -span.back);
    first = addDays(last, -(span.days - 1));
    label = span.label;
  }

  return {
    preset,
    startMs: startOfLocalDay(first, timeZone),
    endMs: startOfLocalDay(addDays(last, 1), timeZone),
    timeZone,
    days: enumerateDays(first, last),
    label,
  };
}

/** "3 Oct – 9 Oct"; years are shown when the range is not entirely in the current local year. */
function customRangeLabel(first: string, last: string, today: string, locale: string): string {
  const currentYear = today.slice(0, 4);
  const withYear = first.slice(0, 4) !== currentYear || last.slice(0, 4) !== currentYear;
  const from = formatCalendarDate(first, locale, { day: 'numeric', month: 'short' }, withYear);
  if (first === last) return from;
  const to = formatCalendarDate(last, locale, { day: 'numeric', month: 'short' }, withYear);
  return `${from} – ${to}`;
}
