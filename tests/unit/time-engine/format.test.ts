import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  currentTimeZone,
  formatClockTime,
  formatDayLabel,
  formatDuration,
  formatShare,
  localDayKey,
} from '@studio-pulse/time-engine';

import { HOUR, MINUTE, SECOND, at } from './builders';

describe('formatDuration', () => {
  it.each([
    [0, '0m'],
    [-5_000, '0m'],
    [Number.NaN, '0m'],
    [Number.POSITIVE_INFINITY, '0m'],
    [1, '1s'],
    [999, '1s'],
    [SECOND, '1s'],
    [1_999, '1s'],
    [45 * SECOND, '45s'],
    [59_999, '59s'],
    [MINUTE, '1m'],
    [12 * MINUTE + 59 * SECOND, '12m'],
    [59 * MINUTE + 59_999, '59m'],
    [HOUR, '1h 00m'],
    [HOUR + 5 * MINUTE, '1h 05m'],
    [HOUR + 5 * MINUTE + 59 * SECOND, '1h 05m'],
    [10 * HOUR + 30 * MINUTE, '10h 30m'],
    [26 * HOUR + 10 * MINUTE, '26h 10m'],
    [100 * HOUR, '100h 00m'],
  ])('compact %d ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
    expect(formatDuration(ms, 'compact')).toBe(expected);
  });

  it.each([
    [0, '0 minutes'],
    [-1, '0 minutes'],
    [400, '1 second'],
    [SECOND, '1 second'],
    [45 * SECOND, '45 seconds'],
    [MINUTE, '1 minute'],
    [MINUTE + 30 * SECOND, '1 minute'],
    [12 * MINUTE, '12 minutes'],
    [HOUR, '1 hour'],
    [HOUR + 5 * MINUTE, '1 hour 5 minutes'],
    [2 * HOUR + MINUTE, '2 hours 1 minute'],
    [26 * HOUR + 10 * MINUTE, '26 hours 10 minutes'],
  ])('long %d ms → %s', (ms, expected) => {
    expect(formatDuration(ms, 'long')).toBe(expected);
  });

  it.each([
    [0, '0:00:00'],
    [-30 * SECOND, '0:00:00'],
    [999, '0:00:00'],
    [42 * MINUTE + 10 * SECOND, '0:42:10'],
    [HOUR + 5 * MINUTE + 9 * SECOND, '1:05:09'],
    [12 * HOUR, '12:00:00'],
    [26 * HOUR + 59 * MINUTE + 59_999, '26:59:59'],
  ])('clock %d ms → %s', (ms, expected) => {
    expect(formatDuration(ms, 'clock')).toBe(expected);
  });
});

describe('formatShare', () => {
  it.each([
    [0, '0%'],
    [-0.2, '0%'],
    [Number.NaN, '0%'],
    [0.0001, '<1%'],
    [0.004999, '<1%'],
    [0.005, '1%'],
    [0.42, '42%'],
    [0.125, '13%'],
    [0.5, '50%'],
    [0.994, '99%'],
    [0.999, '100%'],
    [1, '100%'],
    [1.3, '100%'],
  ])('%s → %s', (share, expected) => {
    expect(formatShare(share)).toBe(expected);
  });
});

describe('formatClockTime: one UTC instant in several zones', () => {
  const instant = at('2026-10-13T09:15:00Z');

  it.each([
    ['UTC', '09:15'],
    ['Europe/London', '10:15'],
    ['Europe/Berlin', '11:15'],
    ['America/New_York', '05:15'],
    ['America/Los_Angeles', '02:15'],
    ['Asia/Kolkata', '14:45'],
    ['Asia/Kathmandu', '15:00'],
    ['Asia/Tokyo', '18:15'],
    ['Australia/Adelaide', '19:45'],
  ])('%s → %s (en-GB, 24 h)', (timeZone, expected) => {
    expect(formatClockTime(instant, timeZone)).toBe(expected);
  });

  it('follows the locale for 12/24 h', () => {
    expect(formatClockTime(instant, 'America/New_York', 'en-US')).toMatch(/^5:15[\s ]AM$/);
    expect(formatClockTime(at('2026-10-13T21:05:00Z'), 'UTC', 'en-US')).toMatch(/^9:05[\s ]PM$/);
  });

  it('shows the wall clock on both sides of a DST change', () => {
    expect(formatClockTime(at('2026-03-08T06:59:00Z'), 'America/New_York')).toBe('01:59');
    expect(formatClockTime(at('2026-03-08T07:00:00Z'), 'America/New_York')).toBe('03:00');
  });

  it('rejects unknown zones', () => {
    expect(() => formatClockTime(instant, 'Nowhere/Special')).toThrow(RangeError);
  });
});

describe('localDayKey', () => {
  it.each([
    ['UTC', '2026-10-13'],
    ['America/New_York', '2026-10-13'],
    ['Pacific/Honolulu', '2026-10-13'],
    ['Asia/Kolkata', '2026-10-14'],
    ['Asia/Tokyo', '2026-10-14'],
    ['Pacific/Kiritimati', '2026-10-14'],
  ])('2026-10-13T20:00Z in %s is %s', (timeZone, expected) => {
    expect(localDayKey(at('2026-10-13T20:00:00Z'), timeZone)).toBe(expected);
  });

  it('flips exactly at local midnight in Asia/Kathmandu', () => {
    expect(localDayKey(at('2026-10-13T18:14:59.999Z'), 'Asia/Kathmandu')).toBe('2026-10-13');
    expect(localDayKey(at('2026-10-13T18:15:00Z'), 'Asia/Kathmandu')).toBe('2026-10-14');
  });

  it('handles a repeated midnight hour (America/Havana)', () => {
    // Cuba falls back from 01:00 to 00:00 on 1 Nov 2026; both 00:xx hours belong to 1 Nov.
    expect(localDayKey(at('2026-11-01T03:59:59Z'), 'America/Havana')).toBe('2026-10-31');
    expect(localDayKey(at('2026-11-01T04:30:00Z'), 'America/Havana')).toBe('2026-11-01');
    expect(localDayKey(at('2026-11-01T05:30:00Z'), 'America/Havana')).toBe('2026-11-01');
  });
});

describe('formatDayLabel', () => {
  const now = at('2026-10-14T10:00:00Z'); // Wednesday 14 Oct in UTC

  it('names today and yesterday', () => {
    expect(formatDayLabel('2026-10-14', 'UTC', now)).toBe('Today');
    expect(formatDayLabel('2026-10-13', 'UTC', now)).toBe('Yesterday');
  });

  it('formats other days as weekday, day and month', () => {
    expect(formatDayLabel('2026-10-12', 'UTC', now)).toBe('Mon 12 Oct');
    expect(formatDayLabel('2026-10-15', 'UTC', now)).toBe('Thu 15 Oct');
    expect(formatDayLabel('2026-01-01', 'UTC', now)).toBe('Thu 1 Jan');
  });

  it('adds the year for days outside the current local year', () => {
    // ICU's en-GB pattern with a year inserts a comma after the weekday.
    expect(formatDayLabel('2025-10-12', 'UTC', now)).toMatch(/^Sun,? 12 Oct 2025$/);
    expect(formatDayLabel('2027-01-04', 'UTC', now)).toMatch(/^Mon,? 4 Jan 2027$/);
  });

  it('decides today/yesterday in the given zone', () => {
    const lateEvening = at('2026-10-13T20:00:00Z'); // already 14 Oct in Kolkata
    expect(formatDayLabel('2026-10-14', 'Asia/Kolkata', lateEvening)).toBe('Today');
    expect(formatDayLabel('2026-10-13', 'Asia/Kolkata', lateEvening)).toBe('Yesterday');
    expect(formatDayLabel('2026-10-13', 'America/New_York', lateEvening)).toBe('Today');
    expect(formatDayLabel('2026-12-31', 'Pacific/Kiritimati', at('2026-12-31T12:00:00Z'))).toBe('Yesterday');
  });

  it('is locale-aware', () => {
    expect(formatDayLabel('2026-10-12', 'UTC', now, 'en-US')).toBe('Mon, Oct 12');
  });

  it('rejects malformed day keys', () => {
    expect(() => formatDayLabel('2026-10-32', 'UTC', now)).toThrow(RangeError);
    expect(() => formatDayLabel('12/10/2026', 'UTC', now)).toThrow(RangeError);
  });
});

describe('currentTimeZone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the runtime IANA zone, usable by the other helpers', () => {
    const zone = currentTimeZone();
    expect(zone.length).toBeGreaterThan(0);
    expect(() => localDayKey(at('2026-10-13T12:00:00Z'), zone)).not.toThrow();
  });

  it('falls back to UTC when the runtime reports no zone', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      () => ({ resolvedOptions: () => ({ timeZone: '' }) }) as unknown as Intl.DateTimeFormat,
    );
    expect(currentTimeZone()).toBe('UTC');
  });

  it('falls back to UTC when Intl throws', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no Intl');
    });
    expect(currentTimeZone()).toBe('UTC');
  });
});
