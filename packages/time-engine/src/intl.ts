/**
 * Cached Intl formatters. Creating an Intl.DateTimeFormat is comparatively expensive and report
 * views format hundreds of labels, so instances are memoised by (locale, options).
 */

import { dayKeyToUtcMs } from './days';

const FORMATTER_CACHE_LIMIT = 256;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= FORMATTER_CACHE_LIMIT) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Format a calendar day key (no time zone involved: the date is formatted at UTC noon in UTC).
 */
export function formatCalendarDate(
  day: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
  withYear: boolean,
): string {
  const noonUtc = dayKeyToUtcMs(day) + 12 * 3_600_000;
  const resolved: Intl.DateTimeFormatOptions = withYear
    ? { ...options, year: 'numeric', timeZone: 'UTC' }
    : { ...options, timeZone: 'UTC' };
  return dateTimeFormat(locale, resolved).format(noonUtc);
}
