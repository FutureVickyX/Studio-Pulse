/**
 * Calendar-day key helpers (`YYYY-MM-DD`). Pure date arithmetic on the key itself, independent
 * of any time zone: a key names a local day, so it is handled as a UTC calendar date.
 */

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDayKeyUtc(key: string): number | null {
  const match = KEY.exec(key);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

export function addDaysToKey(key: string, days: number): string {
  const ms = parseDayKeyUtc(key);
  if (ms === null) return key;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** Short axis label for a day key: weekday for ≤ 7 columns (`Mon`), else day of month (`12`). */
export function dayAxisLabel(key: string, columns: number, locale?: string): string {
  const ms = parseDayKeyUtc(key);
  if (ms === null) return key;
  const options: Intl.DateTimeFormatOptions =
    columns <= 7 ? { weekday: 'short', timeZone: 'UTC' } : { day: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat(locale, options).format(ms);
}
