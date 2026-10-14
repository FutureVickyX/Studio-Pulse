import { describe, expect, it } from 'vitest';

import { resolveRange } from '@studio-pulse/time-engine';
import type { DateRange } from '@studio-pulse/time-engine';

import { HOUR, at } from './builders';

function hours(range: DateRange): number {
  return (range.endMs - range.startMs) / HOUR;
}

describe('resolveRange: presets in UTC', () => {
  const now = at('2026-10-13T10:00:00Z');
  const opts = { now, timeZone: 'UTC' };

  it('today is [start of today, start of tomorrow)', () => {
    const range = resolveRange('today', opts);
    expect(range).toEqual({
      preset: 'today',
      startMs: at('2026-10-13T00:00:00Z'),
      endMs: at('2026-10-14T00:00:00Z'),
      timeZone: 'UTC',
      days: ['2026-10-13'],
      label: 'Today',
    });
  });

  it('yesterday is the whole previous local day', () => {
    const range = resolveRange('yesterday', opts);
    expect(range.startMs).toBe(at('2026-10-12T00:00:00Z'));
    expect(range.endMs).toBe(at('2026-10-13T00:00:00Z'));
    expect(range.days).toEqual(['2026-10-12']);
    expect(range.label).toBe('Yesterday');
  });

  it('last7 is seven local days ending today, inclusive', () => {
    const range = resolveRange('last7', opts);
    expect(range.days).toEqual([
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
    ]);
    expect(range.startMs).toBe(at('2026-10-07T00:00:00Z'));
    expect(range.endMs).toBe(at('2026-10-14T00:00:00Z'));
    expect(range.label).toBe('Last 7 days');
  });

  it('last30 is thirty local days ending today', () => {
    const range = resolveRange('last30', opts);
    expect(range.days).toHaveLength(30);
    expect(range.days[0]).toBe('2026-09-14');
    expect(range.days[29]).toBe('2026-10-13');
    expect(range.startMs).toBe(at('2026-09-14T00:00:00Z'));
    expect(hours(range)).toBe(30 * 24);
    expect(range.label).toBe('Last 30 days');
  });

  it('day lists cross month and year boundaries', () => {
    const range = resolveRange('last7', { now: at('2027-01-02T12:00:00Z'), timeZone: 'UTC' });
    expect(range.days).toEqual([
      '2026-12-27',
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('now exactly at local midnight belongs to the new day', () => {
    expect(resolveRange('today', { now: at('2026-10-13T00:00:00Z'), timeZone: 'UTC' }).days).toEqual(['2026-10-13']);
    expect(resolveRange('today', { now: at('2026-10-12T23:59:59.999Z'), timeZone: 'UTC' }).days).toEqual(['2026-10-12']);
  });
});

describe('resolveRange: DST transitions', () => {
  it('America/New_York DST start (2026-03-08) is a 23 h day', () => {
    const range = resolveRange('today', { now: at('2026-03-08T15:00:00Z'), timeZone: 'America/New_York' });
    expect(range.days).toEqual(['2026-03-08']);
    expect(range.startMs).toBe(at('2026-03-08T05:00:00Z')); // 00:00 EST (UTC-5)
    expect(range.endMs).toBe(at('2026-03-09T04:00:00Z')); // 00:00 EDT (UTC-4)
    expect(hours(range)).toBe(23);
  });

  it('America/New_York DST end (2026-11-01) is a 25 h day', () => {
    const range = resolveRange('today', { now: at('2026-11-01T16:00:00Z'), timeZone: 'America/New_York' });
    expect(range.startMs).toBe(at('2026-11-01T04:00:00Z'));
    expect(range.endMs).toBe(at('2026-11-02T05:00:00Z'));
    expect(hours(range)).toBe(25);
  });

  it('yesterday resolves to the 23 h day when asked just after midnight', () => {
    const range = resolveRange('yesterday', { now: at('2026-03-09T04:30:00Z'), timeZone: 'America/New_York' });
    expect(range.days).toEqual(['2026-03-08']);
    expect(hours(range)).toBe(23);
  });

  it('last7 spanning the New York DST start is 7 × 24 − 1 hours', () => {
    const range = resolveRange('last7', { now: at('2026-03-10T12:00:00Z'), timeZone: 'America/New_York' });
    expect(range.days[0]).toBe('2026-03-04');
    expect(range.days[6]).toBe('2026-03-10');
    expect(range.startMs).toBe(at('2026-03-04T05:00:00Z'));
    expect(range.endMs).toBe(at('2026-03-11T04:00:00Z'));
    expect(hours(range)).toBe(7 * 24 - 1);
  });

  it('Europe/London DST start (2026-03-29) is a 23 h day', () => {
    const range = resolveRange('today', { now: at('2026-03-29T12:00:00Z'), timeZone: 'Europe/London' });
    expect(range.startMs).toBe(at('2026-03-29T00:00:00Z'));
    expect(range.endMs).toBe(at('2026-03-29T23:00:00Z'));
    expect(hours(range)).toBe(23);
  });

  it('Europe/London DST end (2026-10-25) is a 25 h day', () => {
    const range = resolveRange('today', { now: at('2026-10-25T12:00:00Z'), timeZone: 'Europe/London' });
    expect(range.startMs).toBe(at('2026-10-24T23:00:00Z'));
    expect(range.endMs).toBe(at('2026-10-26T00:00:00Z'));
    expect(hours(range)).toBe(25);
  });

  it('last30 spanning the London DST start is 30 × 24 − 1 hours', () => {
    const range = resolveRange('last30', { now: at('2026-04-10T12:00:00Z'), timeZone: 'Europe/London' });
    expect(range.days[0]).toBe('2026-03-12');
    expect(range.days[29]).toBe('2026-04-10');
    expect(range.startMs).toBe(at('2026-03-12T00:00:00Z'));
    expect(range.endMs).toBe(at('2026-04-10T23:00:00Z'));
    expect(hours(range)).toBe(30 * 24 - 1);
  });

  it('a day whose local midnight does not exist starts at the first existing instant (America/Santiago)', () => {
    // Chile springs forward at 00:00 → 01:00 on 2026-09-06.
    const range = resolveRange('today', { now: at('2026-09-06T15:00:00Z'), timeZone: 'America/Santiago' });
    expect(range.startMs).toBe(at('2026-09-06T04:00:00Z')); // 01:00 -03
    expect(range.endMs).toBe(at('2026-09-07T03:00:00Z'));
    expect(hours(range)).toBe(23);
    const previous = resolveRange('yesterday', { now: at('2026-09-06T15:00:00Z'), timeZone: 'America/Santiago' });
    expect(previous.endMs).toBe(range.startMs); // days stay contiguous
  });
});

describe('resolveRange: fractional offsets and "today" depends on the zone', () => {
  it('Asia/Kolkata (+05:30): 20:00 UTC is already tomorrow', () => {
    const range = resolveRange('today', { now: at('2026-10-13T20:00:00Z'), timeZone: 'Asia/Kolkata' });
    expect(range.days).toEqual(['2026-10-14']);
    expect(range.startMs).toBe(at('2026-10-13T18:30:00Z'));
    expect(range.endMs).toBe(at('2026-10-14T18:30:00Z'));
    expect(hours(range)).toBe(24);
  });

  it('Asia/Kathmandu (+05:45): the day flips at 18:15 UTC', () => {
    const before = resolveRange('today', { now: at('2026-10-13T18:14:59.999Z'), timeZone: 'Asia/Kathmandu' });
    expect(before.days).toEqual(['2026-10-13']);
    expect(before.startMs).toBe(at('2026-10-12T18:15:00Z'));
    expect(before.endMs).toBe(at('2026-10-13T18:15:00Z'));

    const after = resolveRange('today', { now: at('2026-10-13T18:15:00Z'), timeZone: 'Asia/Kathmandu' });
    expect(after.days).toEqual(['2026-10-14']);
    expect(after.startMs).toBe(before.endMs);
  });

  it('the same instant is a different "today" in different zones', () => {
    const now = at('2026-10-13T02:00:00Z');
    expect(resolveRange('today', { now, timeZone: 'UTC' }).days).toEqual(['2026-10-13']);
    expect(resolveRange('today', { now, timeZone: 'America/New_York' }).days).toEqual(['2026-10-12']);
    expect(resolveRange('today', { now, timeZone: 'Asia/Kolkata' }).days).toEqual(['2026-10-13']);
    expect(resolveRange('today', { now, timeZone: 'Pacific/Honolulu' }).days).toEqual(['2026-10-12']);
  });
});

describe('resolveRange: custom', () => {
  const now = at('2026-10-13T10:00:00Z');

  it('is an inclusive YYYY-MM-DD range in the given zone', () => {
    const range = resolveRange('custom', {
      now,
      timeZone: 'Europe/Berlin',
      customStart: '2026-10-03',
      customEnd: '2026-10-09',
    });
    expect(range.preset).toBe('custom');
    expect(range.startMs).toBe(at('2026-10-02T22:00:00Z')); // 00:00 CEST
    expect(range.endMs).toBe(at('2026-10-09T22:00:00Z'));
    expect(range.days).toHaveLength(7);
    expect(range.label).toBe('3 Oct – 9 Oct');
  });

  it('crossing the Berlin DST end gives 3 × 24 + 1 hours', () => {
    const range = resolveRange('custom', {
      now,
      timeZone: 'Europe/Berlin',
      customStart: '2026-10-24',
      customEnd: '2026-10-26',
    });
    expect(hours(range)).toBe(73);
    expect(range.days).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
  });

  it('labels a single day without a dash and shows years outside the current year', () => {
    expect(resolveRange('custom', { now, timeZone: 'UTC', customStart: '2026-10-03', customEnd: '2026-10-03' }).label).toBe(
      '3 Oct',
    );
    expect(resolveRange('custom', { now, timeZone: 'UTC', customStart: '2025-12-28', customEnd: '2026-01-03' }).label).toBe(
      '28 Dec 2025 – 3 Jan 2026',
    );
  });

  it('formats the label with the requested locale', () => {
    const range = resolveRange('custom', {
      now,
      timeZone: 'UTC',
      customStart: '2026-10-03',
      customEnd: '2026-10-09',
      locale: 'en-US',
    });
    expect(range.label).toBe('Oct 3 – Oct 9');
  });

  it('throws a RangeError when bounds are missing, malformed, impossible or reversed', () => {
    const base = { now, timeZone: 'UTC' };
    expect(() => resolveRange('custom', base)).toThrow(RangeError);
    expect(() => resolveRange('custom', { ...base, customStart: '2026-10-03' })).toThrow(RangeError);
    expect(() => resolveRange('custom', { ...base, customEnd: '2026-10-03' })).toThrow(RangeError);
    expect(() => resolveRange('custom', { ...base, customStart: '2026-10-3', customEnd: '2026-10-09' })).toThrow(RangeError);
    expect(() => resolveRange('custom', { ...base, customStart: '2026-02-30', customEnd: '2026-03-02' })).toThrow(RangeError);
    expect(() => resolveRange('custom', { ...base, customStart: '2026-10-09', customEnd: '2026-10-03' })).toThrow(RangeError);
  });
});

describe('resolveRange: invalid environment', () => {
  it('rejects unknown time zones and non-finite now', () => {
    expect(() => resolveRange('today', { now: Date.UTC(2026, 9, 13), timeZone: 'Mars/Olympus_Mons' })).toThrow(RangeError);
    expect(() => resolveRange('today', { now: Date.UTC(2026, 9, 13), timeZone: '' })).toThrow(RangeError);
    expect(() => resolveRange('today', { now: Number.NaN, timeZone: 'UTC' })).toThrow(RangeError);
  });
});
