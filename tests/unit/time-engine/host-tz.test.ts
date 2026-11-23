/**
 * Host time-zone independence: the day helpers and report summaries must give the same answer
 * whatever the host's own zone is (a designer in Los Angeles and a CI runner in UTC must agree on
 * when a Havana day starts).
 *
 * Each host zone is switched in-process (Node re-reads `process.env.TZ` when it is assigned) and
 * the engine is re-imported from scratch, so no cache carries a result from one host zone to the
 * next. Every switch is proven by `Date#getTimezoneOffset` before anything is compared, and every
 * result is checked against literal values as well as against the other hosts.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';

import type * as Engine from '@studio-pulse/time-engine';
import type { ReportInterval, ReportRow, SummarizeReportOptions } from '@studio-pulse/time-engine';

import { HOUR, MINUTE, at } from './builders';

/** Host zone and the offset `new Date(2026, 0, 1).getTimezoneOffset()` must report there. */
const HOSTS = [
  ['UTC', 0],
  ['America/Los_Angeles', 480],
  ['Asia/Tokyo', -540],
  ['Pacific/Kiritimati', -840],
] as const;

/** Zone, day, first instant of that local day. */
const DAY_STARTS: ReadonlyArray<readonly [string, string, string]> = [
  ['UTC', '2026-10-13', '2026-10-13T00:00:00.000Z'],
  ['America/New_York', '2026-03-08', '2026-03-08T05:00:00.000Z'], // 23 h day
  ['America/New_York', '2026-03-09', '2026-03-09T04:00:00.000Z'],
  ['America/New_York', '2026-11-01', '2026-11-01T04:00:00.000Z'], // 25 h day
  ['America/New_York', '2026-11-02', '2026-11-02T05:00:00.000Z'],
  ['Europe/London', '2026-03-29', '2026-03-29T00:00:00.000Z'],
  ['Europe/London', '2026-03-30', '2026-03-29T23:00:00.000Z'],
  ['Europe/London', '2026-10-25', '2026-10-24T23:00:00.000Z'],
  ['Europe/London', '2026-10-26', '2026-10-26T00:00:00.000Z'],
  ['America/Santiago', '2026-04-05', '2026-04-05T04:00:00.000Z'], // after a 25 h day
  ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00.000Z'], // midnight skipped: 01:00 -03
  ['America/Santiago', '2026-09-07', '2026-09-07T03:00:00.000Z'],
  ['America/Havana', '2026-03-08', '2026-03-08T05:00:00.000Z'], // midnight skipped: 01:00 CDT
  ['America/Havana', '2026-11-01', '2026-11-01T04:00:00.000Z'], // midnight repeated: the earlier one
  ['America/Havana', '2026-11-02', '2026-11-02T05:00:00.000Z'],
  ['Atlantic/Azores', '2026-03-29', '2026-03-29T01:00:00.000Z'], // midnight skipped: 01:00 +00
  ['Atlantic/Azores', '2026-10-25', '2026-10-25T00:00:00.000Z'], // midnight repeated: the earlier one
  ['Atlantic/Azores', '2026-10-26', '2026-10-26T01:00:00.000Z'],
  ['Asia/Amman', '2021-10-29', '2021-10-28T21:00:00.000Z'], // midnight repeated: the earlier one
  ['Asia/Amman', '2021-10-30', '2021-10-29T22:00:00.000Z'],
  ['Asia/Gaza', '2021-10-29', '2021-10-28T21:00:00.000Z'], // midnight repeated: the earlier one
  ['Asia/Gaza', '2021-10-30', '2021-10-29T22:00:00.000Z'],
  ['Australia/Lord_Howe', '2026-04-05', '2026-04-04T13:00:00.000Z'], // 24.5 h day
  ['Australia/Lord_Howe', '2026-04-06', '2026-04-05T13:30:00.000Z'],
  ['Australia/Lord_Howe', '2026-10-04', '2026-10-03T13:30:00.000Z'], // 23.5 h day
  ['Australia/Lord_Howe', '2026-10-05', '2026-10-04T13:00:00.000Z'],
  ['Asia/Kathmandu', '2026-10-14', '2026-10-13T18:15:00.000Z'],
  ['Pacific/Kiritimati', '2026-01-01', '2025-12-31T10:00:00.000Z'],
];

/** Zone, instant, the local day containing it. */
const LOCAL_DAYS: ReadonlyArray<readonly [string, string, string]> = [
  ['America/Havana', '2026-11-01T03:59:59.999Z', '2026-10-31'],
  ['America/Havana', '2026-11-01T04:30:00.000Z', '2026-11-01'], // first 00:30
  ['America/Havana', '2026-11-01T05:30:00.000Z', '2026-11-01'], // repeated 00:30
  ['Atlantic/Azores', '2026-10-24T23:59:59.999Z', '2026-10-24'],
  ['Atlantic/Azores', '2026-10-25T00:30:00.000Z', '2026-10-25'],
  ['America/Santiago', '2026-09-06T03:59:59.999Z', '2026-09-05'],
  ['America/Santiago', '2026-09-06T04:00:00.000Z', '2026-09-06'],
  ['America/Los_Angeles', '2026-11-01T07:30:00.000Z', '2026-11-01'],
  ['Asia/Kathmandu', '2026-10-13T18:14:59.999Z', '2026-10-13'],
  ['Asia/Kathmandu', '2026-10-13T18:15:00.000Z', '2026-10-14'],
  ['Pacific/Kiritimati', '2025-12-31T10:00:00.000Z', '2026-01-01'],
];

function interval(id: string, start: string, end: string, overrides: Partial<ReportInterval> = {}): ReportInterval {
  return {
    id,
    userId: 'u-1',
    deviceId: 'd-1',
    applicationId: 'figma',
    applicationName: 'Figma',
    kind: 'active',
    startMs: at(start),
    endMs: at(end),
    projectId: null,
    taskId: null,
    ...overrides,
  };
}

/** Two users, two devices, a repeated Havana midnight, active over idle, a fully covered session. */
const INTERVALS: readonly ReportInterval[] = [
  interval('e-h1', '2026-11-01T03:30:00Z', '2026-11-01T04:30:00Z'),
  interval('e-h2', '2026-11-01T04:00:00Z', '2026-11-01T06:00:00Z', { kind: 'idle', deviceId: 'd-2' }),
  interval('e-h3', '2026-10-31T12:00:00Z', '2026-11-02T12:00:00Z', {
    userId: 'u-2',
    applicationId: 'blender',
    applicationName: 'Blender',
    projectId: 'p-1',
  }),
  interval('e-h4', '2026-11-01T10:00:00Z', '2026-11-01T11:00:00Z', {
    userId: 'u-2',
    applicationId: 'adobe-photoshop',
    applicationName: 'Photoshop',
  }),
];

const REPORTS: readonly SummarizeReportOptions[] = [
  { fromDay: '2026-10-31', toDay: '2026-11-02', timeZone: 'America/Havana', bucket: 'day' },
  { fromDay: '2026-10-31', toDay: '2026-11-02', timeZone: 'America/Havana', bucket: 'week' },
  { fromDay: '2026-10-31', toDay: '2026-11-02', timeZone: 'America/Havana', bucket: 'month' },
  { fromDay: null, toDay: '2026-11-02', timeZone: 'Australia/Lord_Howe', bucket: 'day', userIds: ['u-2'] },
  { fromDay: '2026-11-01', toDay: '2026-11-01', timeZone: 'Pacific/Kiritimati', projectId: 'p-1' },
  { fromDay: '2026-10-31', toDay: '2026-11-02', timeZone: 'America/Los_Angeles', bucket: 'day', unattributed: true },
];

function fixture(engine: typeof Engine) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const range = engine.resolveRange('today', { now: at('2026-11-01T16:00:00Z'), timeZone: 'America/Havana' });
  return {
    dayStarts: DAY_STARTS.map(([zone, day]) => iso(engine.startOfLocalDay(day, zone))),
    localDays: LOCAL_DAYS.map(([zone, instant]) => engine.localDayKey(at(instant), zone)),
    range: [range.days, iso(range.startMs), iso(range.endMs)],
    label: engine.formatDayLabel('2026-11-01', 'America/Havana', at('2026-11-01T04:30:00Z')),
    calendar: [
      engine.addDays('2026-02-28', 1),
      engine.daysBetween('2026-10-25', '2026-11-02'),
      engine.enumerateDays('2026-10-30', '2026-11-02'),
      engine.isoWeekStart('2026-11-01'),
      engine.bucketKeyFor('2026-11-01', 'week'),
      engine.monthStart('2026-11-12'),
    ],
    reports: REPORTS.map((options) => engine.summarizeReport(INTERVALS, options)),
  };
}

const originalTz = process.env.TZ;

afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('time-engine results do not depend on the host time zone', () => {
  it('gives identical, correct results under UTC, Los Angeles, Tokyo and Kiritimati hosts', async () => {
    const results: Array<ReturnType<typeof fixture>> = [];
    let previousEngine: typeof Engine | null = null;

    for (const [hostZone, offsetMinutes] of HOSTS) {
      process.env.TZ = hostZone;
      // Prove the switch took effect before trusting anything computed under it.
      expect(new Date(2026, 0, 1).getTimezoneOffset(), `host ${hostZone}`).toBe(offsetMinutes);
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone, `host ${hostZone}`).toBe(hostZone);

      vi.resetModules();
      const engine: typeof Engine = await import('@studio-pulse/time-engine');
      expect(engine, `host ${hostZone}: a fresh engine module (no cache carried over)`).not.toBe(previousEngine);
      previousEngine = engine;

      const result = fixture(engine);
      expect(result.dayStarts, `host ${hostZone}`).toEqual(DAY_STARTS.map(([, , expected]) => expected));
      expect(result.localDays, `host ${hostZone}`).toEqual(LOCAL_DAYS.map(([, , expected]) => expected));
      expect(result.range, `host ${hostZone}`).toEqual([['2026-11-01'], '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']);
      expect(result.label, `host ${hostZone}`).toBe('Today');
      expect(result.calendar, `host ${hostZone}`).toEqual([
        '2026-03-01',
        8,
        ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'],
        '2026-10-26',
        '2026-10-26',
        '2026-11-01',
      ]);

      // Havana by day, literally: the 25 h day starts at the earlier midnight (04:00Z).
      const havanaByDay = result.reports[0] ?? [];
      const period = (rows: readonly ReportRow[]) =>
        rows.filter((row) => row.dimension === 'period').map((row) => [row.bucketStart, row.activeMs, row.idleMs, row.entryCount]);
      expect(havanaByDay[0], `host ${hostZone}`).toMatchObject({
        dimension: 'total',
        activeMs: 49 * HOUR,
        idleMs: 90 * MINUTE,
        entryCount: 3,
        overlapMs: 90 * MINUTE,
      });
      expect(period(havanaByDay), `host ${hostZone}`).toEqual([
        ['2026-10-31', 16 * HOUR + 30 * MINUTE, 0, 2],
        ['2026-11-01', 25 * HOUR + 30 * MINUTE, 90 * MINUTE, 3],
        ['2026-11-02', 7 * HOUR, 0, 1],
      ]);

      results.push(result);
    }

    const [first, ...others] = results;
    for (const [index, other] of others.entries()) {
      expect(other, `host ${HOSTS[index + 1]?.[0]} vs ${HOSTS[0][0]}`).toEqual(first);
    }
  });
});
