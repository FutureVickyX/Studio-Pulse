/** Display formatting for the workspace (dates in the viewer's time zone). */

import { currentTimeZone, formatDuration, localDayKey } from '@studio-pulse/time-engine';

export const TIME_ZONE = currentTimeZone();

export function todayKey(now = Date.now()): string {
  return localDayKey(now, TIME_ZONE);
}

/** 'YYYY-MM-DD' → "Mon 3 Nov" (year added when it is not this year). */
export function formatDay(day: string, now = Date.now()): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  const value = new Date(Date.UTC(year, month - 1, date, 12));
  const sameYear = todayKey(now).slice(0, 4) === day.slice(0, 4);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(value);
}

/** An instant → "14:05" today, "Mon 14:05" this week, "3 Nov" otherwise. */
export function formatWhen(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const day = localDayKey(ms, TIME_ZONE);
  const today = todayKey(now);
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE }).format(ms);
  if (day === today) return time;
  if (now - ms < 6 * 86_400_000 && ms <= now) {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: TIME_ZONE }).format(ms);
    return `${weekday} ${time}`;
  }
  return formatDay(day, now);
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function formatRelative(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatWhen(iso, now);
}

export function formatClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE }).format(ms);
}

export { formatDuration };
