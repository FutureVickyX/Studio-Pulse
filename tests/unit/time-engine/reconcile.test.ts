/**
 * Analytics reconciliation (`reconcileIntervals`) and report summaries (`summarizeReport`, the
 * TypeScript twin of the `analytics_time_summary` RPC).
 *
 * Hand-written cases assert literal values. The seeded randomized cases compare against a
 * brute-force reference written independently below: it walks the time line in 15-minute cells
 * (every interval bound and every local midnight in the chosen zones lies on that grid), picks
 * the winning interval of each cell straight from the rule, and finds local days by reading the
 * wall clock through Intl. The case index and seed are part of each assertion message.
 */

import { describe, expect, it } from 'vitest';

import {
  bucketKeyFor,
  monthStart,
  reconcileIntervals,
  summarizeReport,
} from '@studio-pulse/time-engine';
import type {
  ReportBucket,
  ReportDimension,
  ReportInterval,
  ReportRow,
  SummarizeReportOptions,
} from '@studio-pulse/time-engine';

import { DAY, HOUR, MINUTE, at, iso } from './builders';

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

let sequence = 0;

/** A report interval; `start`/`end` are ISO instants with an explicit offset. */
function entry(start: string, end: string, overrides: Partial<ReportInterval> = {}): ReportInterval {
  sequence += 1;
  return {
    id: `e-${String(sequence).padStart(4, '0')}`,
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

function row(dimension: ReportDimension, fields: Partial<ReportRow> = {}): ReportRow {
  return {
    dimension,
    bucketStart: null,
    userId: null,
    applicationId: null,
    applicationName: null,
    projectId: null,
    taskId: null,
    unattributed: null,
    activeMs: 0,
    idleMs: 0,
    entryCount: 0,
    overlapMs: 0,
    teammatesVisible: dimension === 'total' ? false : null,
    ...fields,
  };
}

/** Pieces as `[id, start, end]` with ISO instants, for readable literal expectations. */
function spans(intervals: readonly ReportInterval[], startIso: string, endIso: string): Array<[string, string, string]> {
  return reconcileIntervals(intervals, { startMs: at(startIso), endMs: at(endIso) }).pieces.map((piece) => [
    piece.id,
    iso(piece.startMs),
    iso(piece.endMs),
  ]);
}

function only(rows: readonly ReportRow[], dimension: ReportDimension): ReportRow[] {
  return rows.filter((candidate) => candidate.dimension === dimension);
}

function totalOf(rows: readonly ReportRow[]): ReportRow {
  const [total] = rows;
  if (!total || total.dimension !== 'total') throw new Error('the first row must be the total');
  return total;
}

/** Small, fast, seedable PRNG (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function int(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('empty list');
  return item;
}

function shuffled<T>(random: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const swap = copy[index] as T;
    copy[index] = copy[other] as T;
    copy[other] = swap;
  }
  return copy;
}

// ---------------------------------------------------------------------------------------------
// reconcileIntervals
// ---------------------------------------------------------------------------------------------

describe('reconcileIntervals', () => {
  const DAY_START = '2026-10-13T00:00:00Z';
  const DAY_END = '2026-10-14T00:00:00Z';

  it('active beats idle across devices; the idle interval keeps what is left', () => {
    const idle = entry('2026-10-13T09:00:00Z', '2026-10-13T11:00:00Z', { id: 'e-idle', kind: 'idle', deviceId: 'd-1' });
    const active = entry('2026-10-13T09:30:00Z', '2026-10-13T10:00:00Z', { id: 'e-active', deviceId: 'd-2' });
    const result = reconcileIntervals([idle, active], { startMs: at(DAY_START), endMs: at(DAY_END) });
    expect(result.rawMs).toBe(2 * HOUR + 30 * MINUTE);
    expect(result.pieces.map((piece) => [piece.id, piece.kind, iso(piece.startMs), iso(piece.endMs)])).toEqual([
      ['e-idle', 'idle', '2026-10-13T09:00:00.000Z', '2026-10-13T09:30:00.000Z'],
      ['e-active', 'active', '2026-10-13T09:30:00.000Z', '2026-10-13T10:00:00.000Z'],
      ['e-idle', 'idle', '2026-10-13T10:00:00.000Z', '2026-10-13T11:00:00.000Z'],
    ]);
  });

  it('an idle interval loses even when it starts first (kind beats order)', () => {
    const idle = entry('2026-10-13T08:00:00Z', '2026-10-13T09:00:00Z', { id: 'e-a', kind: 'idle' });
    const active = entry('2026-10-13T08:30:00Z', '2026-10-13T10:00:00Z', { id: 'e-b' });
    expect(spans([idle, active], DAY_START, DAY_END)).toEqual([
      ['e-a', '2026-10-13T08:00:00.000Z', '2026-10-13T08:30:00.000Z'],
      ['e-b', '2026-10-13T08:30:00.000Z', '2026-10-13T10:00:00.000Z'],
    ]);
  });

  it('contained, identical, contiguous and zero-length intervals', () => {
    const intervals = [
      entry('2026-10-13T09:00:00Z', '2026-10-13T12:00:00Z', { id: 'e-outer' }),
      entry('2026-10-13T10:00:00Z', '2026-10-13T11:00:00Z', { id: 'e-inner' }), // contained: nothing left
      entry('2026-10-13T13:00:00Z', '2026-10-13T14:00:00Z', { id: 'e-twin-b' }),
      entry('2026-10-13T13:00:00Z', '2026-10-13T14:00:00Z', { id: 'e-twin-a' }), // identical: lower id wins
      entry('2026-10-13T15:00:00Z', '2026-10-13T16:00:00Z', { id: 'e-first' }),
      entry('2026-10-13T16:00:00Z', '2026-10-13T17:00:00Z', { id: 'e-next' }), // contiguous: both whole
      entry('2026-10-13T18:00:00Z', '2026-10-13T18:00:00Z', { id: 'e-empty' }), // zero length: nothing
      entry('2026-10-13T19:00:00Z', '2026-10-13T21:00:00Z', { id: 'e-long' }),
      entry('2026-10-13T19:00:00Z', '2026-10-13T20:00:00Z', { id: 'e-short' }), // same start: earlier end first
    ];
    expect(spans(intervals, DAY_START, DAY_END)).toEqual([
      ['e-outer', '2026-10-13T09:00:00.000Z', '2026-10-13T12:00:00.000Z'],
      ['e-twin-a', '2026-10-13T13:00:00.000Z', '2026-10-13T14:00:00.000Z'],
      ['e-first', '2026-10-13T15:00:00.000Z', '2026-10-13T16:00:00.000Z'],
      ['e-next', '2026-10-13T16:00:00.000Z', '2026-10-13T17:00:00.000Z'],
      ['e-short', '2026-10-13T19:00:00.000Z', '2026-10-13T20:00:00.000Z'],
      ['e-long', '2026-10-13T20:00:00.000Z', '2026-10-13T21:00:00.000Z'],
    ]);
    // Raw time counts every interval: 3 + 1 + 1 + 1 + 1 + 1 + 0 + 2 + 1 hours.
    expect(reconcileIntervals(intervals, { startMs: at(DAY_START), endMs: at(DAY_END) }).rawMs).toBe(11 * HOUR);
  });

  it('several active pieces inside one idle interval split it into fragments', () => {
    const intervals = [
      entry('2026-10-13T09:00:00Z', '2026-10-13T12:00:00Z', { id: 'e-idle', kind: 'idle' }),
      entry('2026-10-13T09:30:00Z', '2026-10-13T10:00:00Z', { id: 'e-a1', deviceId: 'd-2' }),
      entry('2026-10-13T10:30:00Z', '2026-10-13T11:00:00Z', { id: 'e-a2', deviceId: 'd-2' }),
      entry('2026-10-13T11:30:00Z', '2026-10-13T11:45:00Z', { id: 'e-a3', deviceId: 'd-3' }),
    ];
    expect(spans(intervals, DAY_START, DAY_END)).toEqual([
      ['e-idle', '2026-10-13T09:00:00.000Z', '2026-10-13T09:30:00.000Z'],
      ['e-a1', '2026-10-13T09:30:00.000Z', '2026-10-13T10:00:00.000Z'],
      ['e-idle', '2026-10-13T10:00:00.000Z', '2026-10-13T10:30:00.000Z'],
      ['e-a2', '2026-10-13T10:30:00.000Z', '2026-10-13T11:00:00.000Z'],
      ['e-idle', '2026-10-13T11:00:00.000Z', '2026-10-13T11:30:00.000Z'],
      ['e-a3', '2026-10-13T11:30:00.000Z', '2026-10-13T11:45:00.000Z'],
      ['e-idle', '2026-10-13T11:45:00.000Z', '2026-10-13T12:00:00.000Z'],
    ]);
  });

  it('overlapping idle intervals: the first one keeps the shared time', () => {
    const intervals = [
      entry('2026-10-13T09:30:00Z', '2026-10-13T10:30:00Z', { id: 'e-b', kind: 'idle' }),
      entry('2026-10-13T09:00:00Z', '2026-10-13T10:00:00Z', { id: 'e-a', kind: 'idle' }),
    ];
    expect(spans(intervals, DAY_START, DAY_END)).toEqual([
      ['e-a', '2026-10-13T09:00:00.000Z', '2026-10-13T10:00:00.000Z'],
      ['e-b', '2026-10-13T10:00:00.000Z', '2026-10-13T10:30:00.000Z'],
    ]);
  });

  it('never reconciles different users against each other', () => {
    const intervals = [
      entry('2026-10-13T09:00:00Z', '2026-10-13T10:00:00Z', { id: 'e-2', userId: 'u-2' }),
      entry('2026-10-13T09:00:00Z', '2026-10-13T10:00:00Z', { id: 'e-1', userId: 'u-1' }),
    ];
    const { pieces } = reconcileIntervals(intervals, { startMs: at(DAY_START), endMs: at(DAY_END) });
    expect(pieces.map((piece) => [piece.userId, piece.id, piece.endMs - piece.startMs])).toEqual([
      ['u-1', 'e-1', HOUR],
      ['u-2', 'e-2', HOUR],
    ]);
  });

  it('clips to the range only after ordering by the whole intervals', () => {
    // A: 22:00 → 03:00 and B: 23:00 → 01:00. A starts first, so it owns all of B's time in every
    // range. Ordering by the clipped bounds would hand 00:00–01:00 to B in a one-day range.
    const a = entry('2026-10-12T22:00:00Z', '2026-10-13T03:00:00Z', { id: 'e-b-later-id' });
    const b = entry('2026-10-12T23:00:00Z', '2026-10-13T01:00:00Z', { id: 'e-a-earlier-id' });
    expect(spans([a, b], DAY_START, DAY_END)).toEqual([
      ['e-b-later-id', '2026-10-13T00:00:00.000Z', '2026-10-13T03:00:00.000Z'],
    ]);
    expect(spans([a, b], '2026-10-12T00:00:00Z', DAY_END)).toEqual([
      ['e-b-later-id', '2026-10-12T22:00:00.000Z', '2026-10-13T03:00:00.000Z'],
    ]);
  });

  it('carries the source fields and the whole interval bounds on every piece', () => {
    const source = entry('2026-10-12T23:00:00Z', '2026-10-13T02:00:00Z', {
      id: 'e-src',
      userId: 'u-7',
      deviceId: 'd-9',
      applicationId: 'blender',
      applicationName: 'Blender',
      kind: 'idle',
      projectId: 'p-1',
      taskId: 't-1',
    });
    const { pieces, rawMs } = reconcileIntervals([source], { startMs: at(DAY_START), endMs: at(DAY_END) });
    expect(rawMs).toBe(2 * HOUR);
    expect(pieces).toEqual([
      {
        id: 'e-src',
        userId: 'u-7',
        deviceId: 'd-9',
        applicationId: 'blender',
        applicationName: 'Blender',
        kind: 'idle',
        startMs: at(DAY_START),
        endMs: at('2026-10-13T02:00:00Z'),
        projectId: 'p-1',
        taskId: 't-1',
        sourceStartMs: at('2026-10-12T23:00:00Z'),
        sourceEndMs: at('2026-10-13T02:00:00Z'),
      },
    ]);
  });

  it('truncates fractions of a millisecond like the database does', () => {
    const fractional = { ...entry(DAY_START, DAY_START), startMs: at('2026-10-13T09:00:00Z') + 0.7, endMs: at('2026-10-13T09:00:00Z') + 5.9 };
    const { pieces, rawMs } = reconcileIntervals([fractional], { startMs: at(DAY_START), endMs: at(DAY_END) });
    expect(rawMs).toBe(5);
    expect(pieces.map((piece) => [piece.startMs - at(DAY_START), piece.endMs - at(DAY_START)])).toEqual([
      [9 * HOUR, 9 * HOUR + 5],
    ]);
  });

  it('rejects repeated ids, unknown kinds and an inverted range', () => {
    const one = entry('2026-10-13T09:00:00Z', '2026-10-13T10:00:00Z', { id: 'e-same' });
    const two = entry('2026-10-13T11:00:00Z', '2026-10-13T12:00:00Z', { id: 'e-same' });
    const range = { startMs: at(DAY_START), endMs: at(DAY_END) };
    expect(() => reconcileIntervals([one, two], range)).toThrow(RangeError);
    expect(() => reconcileIntervals([{ ...one, kind: 'busy' as never }], range)).toThrow(RangeError);
    expect(() => reconcileIntervals([{ ...one, endMs: Number.NaN }], range)).toThrow(RangeError);
    expect(() => reconcileIntervals([one], { startMs: at(DAY_END), endMs: at(DAY_START) })).toThrow(RangeError);
  });

  it('does not depend on input order', () => {
    const intervals = [
      entry('2026-10-13T09:00:00Z', '2026-10-13T12:00:00Z', { kind: 'idle' }),
      entry('2026-10-13T09:00:00Z', '2026-10-13T10:00:00Z'),
      entry('2026-10-13T09:00:00Z', '2026-10-13T10:00:00Z'),
      entry('2026-10-13T09:30:00Z', '2026-10-13T11:00:00Z', { deviceId: 'd-2' }),
      entry('2026-10-13T11:30:00Z', '2026-10-13T13:00:00Z', { kind: 'idle', userId: 'u-2' }),
    ];
    const expected = reconcileIntervals(intervals, { startMs: at(DAY_START), endMs: at(DAY_END) });
    const random = rng(7);
    for (let round = 0; round < 20; round += 1) {
      expect(reconcileIntervals(shuffled(random, intervals), { startMs: at(DAY_START), endMs: at(DAY_END) })).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------------------------

describe('bucketKeyFor and monthStart', () => {
  it.each<[string, ReportBucket, string]>([
    ['2026-11-12', 'day', '2026-11-12'],
    ['2026-11-12', 'week', '2026-11-09'], // Thursday → Monday
    ['2026-11-09', 'week', '2026-11-09'],
    ['2026-11-08', 'week', '2026-11-02'], // Sunday belongs to the week that began on Monday
    ['2027-01-01', 'week', '2026-12-28'], // ISO weeks cross the year
    ['2026-11-12', 'month', '2026-11-01'],
    ['2024-02-29', 'month', '2024-02-01'],
  ])('%s by %s → %s', (day, bucket, expected) => {
    expect(bucketKeyFor(day, bucket)).toBe(expected);
  });

  it('monthStart is the 1st of the month', () => {
    expect(monthStart('2026-12-31')).toBe('2026-12-01');
    expect(monthStart('2026-01-01')).toBe('2026-01-01');
  });

  it('rejects malformed days and buckets', () => {
    expect(() => monthStart('2026-02-30')).toThrow(RangeError);
    expect(() => bucketKeyFor('2026-13-01', 'day')).toThrow(RangeError);
    expect(() => bucketKeyFor('2026-11-12', 'quarter' as ReportBucket)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// summarizeReport: literal cases
// ---------------------------------------------------------------------------------------------

const UTC_DAY: SummarizeReportOptions = { fromDay: '2026-10-13', toDay: '2026-10-13', timeZone: 'UTC', bucket: 'day' };

describe('summarizeReport', () => {
  it('reconciles active over idle across devices, with every dimension and overlapMs', () => {
    const intervals = [
      entry('2026-10-13T09:00:00Z', '2026-10-13T11:00:00Z', { id: 'e-idle', kind: 'idle', deviceId: 'd-1' }),
      entry('2026-10-13T09:30:00Z', '2026-10-13T10:00:00Z', {
        id: 'e-active',
        deviceId: 'd-2',
        applicationId: 'blender',
        applicationName: 'Blender',
      }),
    ];
    expect(summarizeReport(intervals, UTC_DAY)).toEqual([
      row('total', { activeMs: 30 * MINUTE, idleMs: 90 * MINUTE, entryCount: 2, overlapMs: 30 * MINUTE }),
      row('period', { bucketStart: '2026-10-13', activeMs: 30 * MINUTE, idleMs: 90 * MINUTE, entryCount: 2 }),
      row('member', { userId: 'u-1', activeMs: 30 * MINUTE, idleMs: 90 * MINUTE, entryCount: 2 }),
      row('project', { unattributed: true, activeMs: 30 * MINUTE, idleMs: 90 * MINUTE, entryCount: 2 }),
      row('task', { activeMs: 30 * MINUTE, idleMs: 90 * MINUTE, entryCount: 2 }),
      row('application', { applicationId: 'blender', applicationName: 'Blender', activeMs: 30 * MINUTE, entryCount: 1 }),
      row('application', { applicationId: 'figma', applicationName: 'Figma', idleMs: 90 * MINUTE, entryCount: 1 }),
    ]);
  });

  it('returns exactly one total row (zeros) when nothing is recorded', () => {
    expect(summarizeReport([], UTC_DAY)).toEqual([row('total')]);
    expect(summarizeReport([], { ...UTC_DAY, teammatesVisible: true })).toEqual([row('total', { teammatesVisible: true })]);
  });

  it('splits a session at local midnight and keeps the unclipped-order rule across ranges', () => {
    // A (Figma, project p-a) 22:00 → 03:00 owns everything; B (Blender, p-b) 23:00 → 01:00 gets nothing.
    const a = entry('2026-10-12T22:00:00Z', '2026-10-13T03:00:00Z', { id: 'e-b', projectId: 'p-a' });
    const b = entry('2026-10-12T23:00:00Z', '2026-10-13T01:00:00Z', {
      id: 'e-a',
      applicationId: 'blender',
      applicationName: 'Blender',
      projectId: 'p-b',
    });

    const oneDay = summarizeReport([a, b], UTC_DAY);
    expect(oneDay).toEqual([
      row('total', { activeMs: 3 * HOUR, entryCount: 1, overlapMs: HOUR }),
      row('period', { bucketStart: '2026-10-13', activeMs: 3 * HOUR, entryCount: 1 }),
      row('member', { userId: 'u-1', activeMs: 3 * HOUR, entryCount: 1 }),
      row('project', { projectId: 'p-a', unattributed: false, activeMs: 3 * HOUR, entryCount: 1 }),
      row('task', { projectId: 'p-a', activeMs: 3 * HOUR, entryCount: 1 }),
      row('application', { applicationId: 'figma', applicationName: 'Figma', activeMs: 3 * HOUR, entryCount: 1 }),
    ]);

    const twoDays = summarizeReport([a, b], { ...UTC_DAY, fromDay: '2026-10-12' });
    expect(only(twoDays, 'period')).toEqual([
      row('period', { bucketStart: '2026-10-12', activeMs: 2 * HOUR, entryCount: 1 }),
      row('period', { bucketStart: '2026-10-13', activeMs: 3 * HOUR, entryCount: 1 }),
    ]);
    expect(totalOf(twoDays)).toEqual(row('total', { activeMs: 5 * HOUR, entryCount: 1, overlapMs: 2 * HOUR }));
    expect(only(twoDays, 'application').map((candidate) => candidate.applicationId)).toEqual(['figma']);
  });

  it('applies filters after reconciliation, and overlapMs follows the filters', () => {
    const intervals = [
      entry('2026-10-13T09:00:00Z', '2026-10-13T11:00:00Z', { id: 'e-1', projectId: 'p-1' }),
      entry('2026-10-13T10:00:00Z', '2026-10-13T12:00:00Z', {
        id: 'e-2',
        deviceId: 'd-2',
        applicationId: 'blender',
        applicationName: 'Blender',
        projectId: 'p-2',
      }),
    ];
    expect(totalOf(summarizeReport(intervals, UTC_DAY))).toEqual(
      row('total', { activeMs: 3 * HOUR, entryCount: 2, overlapMs: HOUR }),
    );
    // e-2 lost 10:00–11:00 to e-1 before the filter, so only 11:00–12:00 is p-2's.
    expect(summarizeReport(intervals, { ...UTC_DAY, projectId: 'p-2' })).toEqual([
      row('total', { activeMs: HOUR, entryCount: 1, overlapMs: HOUR }),
      row('period', { bucketStart: '2026-10-13', activeMs: HOUR, entryCount: 1 }),
      row('member', { userId: 'u-1', activeMs: HOUR, entryCount: 1 }),
      row('project', { projectId: 'p-2', unattributed: false, activeMs: HOUR, entryCount: 1 }),
      row('task', { projectId: 'p-2', activeMs: HOUR, entryCount: 1 }),
      row('application', { applicationId: 'blender', applicationName: 'Blender', activeMs: HOUR, entryCount: 1 }),
    ]);
    expect(totalOf(summarizeReport(intervals, { ...UTC_DAY, projectId: 'p-1' }))).toEqual(
      row('total', { activeMs: 2 * HOUR, entryCount: 1, overlapMs: 0 }),
    );
    expect(totalOf(summarizeReport(intervals, { ...UTC_DAY, applicationId: 'blender' }))).toEqual(
      row('total', { activeMs: HOUR, entryCount: 1, overlapMs: HOUR }),
    );
    expect(summarizeReport(intervals, { ...UTC_DAY, projectId: 'p-other' })).toEqual([row('total')]);
  });

  it('separates unattributed time (no project, no task) from task time without a project', () => {
    const intervals = [
      entry('2026-10-13T08:00:00Z', '2026-10-13T09:00:00Z', { id: 'e-none' }),
      entry('2026-10-13T09:00:00Z', '2026-10-13T09:30:00Z', { id: 'e-task-only', taskId: 't-9' }),
      entry('2026-10-13T10:00:00Z', '2026-10-13T12:00:00Z', { id: 'e-both', projectId: 'p-1', taskId: 't-1' }),
    ];
    const report = summarizeReport(intervals, UTC_DAY);
    expect(only(report, 'project')).toEqual([
      row('project', { projectId: 'p-1', unattributed: false, activeMs: 2 * HOUR, entryCount: 1 }),
      row('project', { projectId: null, unattributed: false, activeMs: 30 * MINUTE, entryCount: 1 }),
      row('project', { projectId: null, unattributed: true, activeMs: HOUR, entryCount: 1 }),
    ]);
    expect(only(report, 'task')).toEqual([
      row('task', { projectId: 'p-1', taskId: 't-1', activeMs: 2 * HOUR, entryCount: 1 }),
      row('task', { projectId: null, taskId: 't-9', activeMs: 30 * MINUTE, entryCount: 1 }),
      row('task', { projectId: null, taskId: null, activeMs: HOUR, entryCount: 1 }),
    ]);

    const unattributed = summarizeReport(intervals, { ...UTC_DAY, unattributed: true });
    expect(totalOf(unattributed)).toEqual(row('total', { activeMs: HOUR, entryCount: 1 }));
    expect(only(unattributed, 'project')).toEqual([
      row('project', { projectId: null, unattributed: true, activeMs: HOUR, entryCount: 1 }),
    ]);
    expect(only(unattributed, 'task')).toEqual([row('task', { activeMs: HOUR, entryCount: 1 })]);
  });

  it('rolls days up into ISO weeks and months; partial edge buckets keep their first day', () => {
    const intervals = [
      entry('2026-10-30T10:00:00Z', '2026-10-30T12:00:00Z', { id: 'e-a' }), // Fri
      entry('2026-10-31T23:00:00Z', '2026-11-01T01:00:00Z', { id: 'e-b' }), // crosses the month
      entry('2026-11-01T23:30:00Z', '2026-11-02T00:30:00Z', { id: 'e-c' }), // crosses the week (Sun → Mon)
      entry('2026-11-03T08:00:00Z', '2026-11-03T09:00:00Z', { id: 'e-d', kind: 'idle' }),
    ];
    const range: SummarizeReportOptions = { fromDay: '2026-10-28', toDay: '2026-11-04', timeZone: 'UTC' };

    expect(only(summarizeReport(intervals, { ...range, bucket: 'day' }), 'period')).toEqual([
      row('period', { bucketStart: '2026-10-30', activeMs: 2 * HOUR, entryCount: 1 }),
      row('period', { bucketStart: '2026-10-31', activeMs: HOUR, entryCount: 1 }),
      row('period', { bucketStart: '2026-11-01', activeMs: 90 * MINUTE, entryCount: 2 }),
      row('period', { bucketStart: '2026-11-02', activeMs: 30 * MINUTE, entryCount: 1 }),
      row('period', { bucketStart: '2026-11-03', idleMs: HOUR, entryCount: 1 }),
    ]);
    expect(only(summarizeReport(intervals, { ...range, bucket: 'week' }), 'period')).toEqual([
      row('period', { bucketStart: '2026-10-26', activeMs: 4 * HOUR + 30 * MINUTE, entryCount: 3 }),
      row('period', { bucketStart: '2026-11-02', activeMs: 30 * MINUTE, idleMs: HOUR, entryCount: 2 }),
    ]);
    const byMonth = summarizeReport(intervals, { ...range, bucket: 'month' });
    expect(only(byMonth, 'period')).toEqual([
      row('period', { bucketStart: '2026-10-01', activeMs: 3 * HOUR, entryCount: 2 }),
      row('period', { bucketStart: '2026-11-01', activeMs: 2 * HOUR, idleMs: HOUR, entryCount: 3 }),
    ]);
    // A session in two buckets counts once in each, so period sessions exceed the total's.
    expect(totalOf(byMonth)).toEqual(row('total', { activeMs: 5 * HOUR, idleMs: HOUR, entryCount: 4 }));
  });

  it('names an application after its contributing interval with the latest (start, id)', () => {
    const intervals = [
      entry('2026-10-12T23:00:00Z', '2026-10-13T01:00:00Z', { id: 'e-1', applicationName: 'Figma (old name)' }),
      entry('2026-10-13T07:00:00Z', '2026-10-13T08:00:00Z', { id: 'e-a', applicationName: 'Figma A' }),
      entry('2026-10-13T07:00:00Z', '2026-10-13T09:00:00Z', { id: 'e-b', applicationName: 'Figma B' }),
      // Starts last but is wholly covered by e-a, so it contributes nothing and names nothing.
      entry('2026-10-13T07:30:00Z', '2026-10-13T07:45:00Z', { id: 'e-c', applicationName: 'Ghost' }),
    ];
    expect(only(summarizeReport(intervals, UTC_DAY), 'application')).toEqual([
      row('application', { applicationId: 'figma', applicationName: 'Figma B', activeMs: 3 * HOUR, entryCount: 3 }),
    ]);
  });

  it('orders rows by dimension, then by code point with nulls last (never by locale)', () => {
    const app = (applicationId: string, start: string, end: string, userId = 'u-1') =>
      entry(start, end, { applicationId, applicationName: applicationId, userId, deviceId: applicationId });
    const intervals = [
      app('app-\u{1F600}', '2026-10-13T01:00:00Z', '2026-10-13T02:00:00Z', 'u-b'),
      app('app-！', '2026-10-13T03:00:00Z', '2026-10-13T04:00:00Z', 'u-B'),
      app('alpha', '2026-10-13T05:00:00Z', '2026-10-13T06:00:00Z', 'u-a'),
      app('Zeta', '2026-10-13T07:00:00Z', '2026-10-13T08:00:00Z'),
    ];
    const report = summarizeReport(intervals, UTC_DAY);
    expect(report.map((candidate) => candidate.dimension)).toEqual([
      'total',
      'period',
      'member',
      'member',
      'member',
      'member',
      'project',
      'task',
      'application',
      'application',
      'application',
      'application',
    ]);
    expect(only(report, 'member').map((candidate) => candidate.userId)).toEqual(['u-1', 'u-B', 'u-a', 'u-b']);
    expect(only(report, 'application').map((candidate) => candidate.applicationId)).toEqual([
      'Zeta',
      'alpha',
      'app-！',
      'app-\u{1F600}',
    ]);
  });

  it('selects users: null means everyone given, an empty list or a stranger means a zero total', () => {
    const intervals = [
      entry('2026-10-13T09:00:00Z', '2026-10-13T10:00:00Z', { userId: 'u-2' }),
      entry('2026-10-13T09:00:00Z', '2026-10-13T11:00:00Z', { userId: 'u-1' }),
    ];
    expect(only(summarizeReport(intervals, UTC_DAY), 'member')).toEqual([
      row('member', { userId: 'u-1', activeMs: 2 * HOUR, entryCount: 1 }),
      row('member', { userId: 'u-2', activeMs: HOUR, entryCount: 1 }),
    ]);
    expect(totalOf(summarizeReport(intervals, { ...UTC_DAY, userIds: ['u-2'] }))).toEqual(
      row('total', { activeMs: HOUR, entryCount: 1 }),
    );
    expect(summarizeReport(intervals, { ...UTC_DAY, userIds: [] })).toEqual([row('total')]);
    expect(summarizeReport(intervals, { ...UTC_DAY, userIds: ['u-9'], teammatesVisible: false })).toEqual([row('total')]);
  });

  it('includes sessions at the range edges only for their in-range part', () => {
    const intervals = [
      entry('2026-10-12T23:30:00Z', '2026-10-13T00:30:00Z', { id: 'e-start' }),
      entry('2026-10-13T23:45:00Z', '2026-10-14T00:15:00Z', { id: 'e-end' }),
      entry('2026-10-12T22:00:00Z', '2026-10-13T00:00:00Z', { id: 'e-before' }), // ends exactly at the start
      entry('2026-10-14T00:00:00Z', '2026-10-14T01:00:00Z', { id: 'e-after' }), // starts exactly at the end
    ];
    expect(totalOf(summarizeReport(intervals, UTC_DAY))).toEqual(row('total', { activeMs: 45 * MINUTE, entryCount: 2 }));
  });

  describe('fromDay null: from the local day of the first interval in scope', () => {
    const intervals = [
      entry('2026-10-10T02:00:00Z', '2026-10-10T03:00:00Z', { id: 'e-early' }), // 9 Oct in New York
      entry('2026-10-12T15:00:00Z', '2026-10-12T16:00:00Z', {
        id: 'e-blender',
        applicationId: 'blender',
        applicationName: 'Blender',
      }),
      entry('2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z', { id: 'e-later' }), // after toDay: not in scope
    ];

    it('starts at the first interval, read in the report zone', () => {
      const report = summarizeReport(intervals, { fromDay: null, toDay: '2026-10-13', timeZone: 'America/New_York' });
      expect(only(report, 'period').map((candidate) => candidate.bucketStart)).toEqual(['2026-10-09', '2026-10-12']);
      expect(totalOf(report)).toEqual(row('total', { activeMs: 2 * HOUR, entryCount: 2 }));
    });

    it('applies the user and the filters before choosing the first interval', () => {
      const old = entry('2025-06-01T10:00:00Z', '2025-06-01T11:00:00Z', { id: 'e-old' });
      // With the old interval in scope the span exceeds 366 days; filtered out, it does not count.
      expect(() => summarizeReport([old, ...intervals], { toDay: '2026-10-13', timeZone: 'UTC' })).toThrow(RangeError);
      expect(
        totalOf(summarizeReport([old, ...intervals], { toDay: '2026-10-13', timeZone: 'UTC', applicationId: 'blender' })),
      ).toEqual(row('total', { activeMs: HOUR, entryCount: 1 }));
      expect(
        totalOf(summarizeReport([{ ...old, userId: 'u-2' }, ...intervals], { toDay: '2026-10-13', timeZone: 'UTC', userIds: ['u-1'] })),
      ).toEqual(row('total', { activeMs: 2 * HOUR, entryCount: 2 }));
    });

    it('is just toDay when nothing is in scope', () => {
      expect(summarizeReport([], { toDay: '2026-10-13', timeZone: 'UTC' })).toEqual([row('total')]);
      expect(summarizeReport(intervals, { toDay: '2026-10-01', timeZone: 'UTC' })).toEqual([row('total')]);
    });
  });

  describe('local days across DST and odd offsets', () => {
    it.each<[string, string, string, string, string, Array<[string, number]>]>([
      // zone, interval start, interval end, fromDay, toDay, expected [day, active ms]
      ['America/New_York', '2026-10-31T12:00:00Z', '2026-11-02T12:00:00Z', '2026-10-31', '2026-11-02', [
        ['2026-10-31', 16 * HOUR], ['2026-11-01', 25 * HOUR], ['2026-11-02', 7 * HOUR],
      ]],
      ['America/New_York', '2026-03-07T12:00:00Z', '2026-03-09T12:00:00Z', '2026-03-07', '2026-03-09', [
        ['2026-03-07', 17 * HOUR], ['2026-03-08', 23 * HOUR], ['2026-03-09', 8 * HOUR],
      ]],
      ['Europe/London', '2026-03-28T12:00:00Z', '2026-03-30T12:00:00Z', '2026-03-28', '2026-03-30', [
        ['2026-03-28', 12 * HOUR], ['2026-03-29', 23 * HOUR], ['2026-03-30', 13 * HOUR],
      ]],
      ['Europe/London', '2026-10-24T12:00:00Z', '2026-10-26T12:00:00Z', '2026-10-24', '2026-10-26', [
        ['2026-10-24', 11 * HOUR], ['2026-10-25', 25 * HOUR], ['2026-10-26', 12 * HOUR],
      ]],
      // Santiago skips 6 Sep 00:00 (→ 01:00 -03): the day starts at 04:00Z and lasts 23 h.
      ['America/Santiago', '2026-09-05T12:00:00Z', '2026-09-07T12:00:00Z', '2026-09-05', '2026-09-07', [
        ['2026-09-05', 16 * HOUR], ['2026-09-06', 23 * HOUR], ['2026-09-07', 9 * HOUR],
      ]],
      // Havana skips 8 Mar 00:00 (→ 01:00 CDT) and repeats 1 Nov 00:00: that day starts at the earlier 00:00.
      ['America/Havana', '2026-03-08T04:30:00Z', '2026-03-08T05:30:00Z', '2026-03-07', '2026-03-08', [
        ['2026-03-07', 30 * MINUTE], ['2026-03-08', 30 * MINUTE],
      ]],
      ['America/Havana', '2026-11-01T03:30:00Z', '2026-11-01T04:30:00Z', '2026-10-31', '2026-11-01', [
        ['2026-10-31', 30 * MINUTE], ['2026-11-01', 30 * MINUTE],
      ]],
      ['America/Havana', '2026-10-31T12:00:00Z', '2026-11-02T12:00:00Z', '2026-10-31', '2026-11-02', [
        ['2026-10-31', 16 * HOUR], ['2026-11-01', 25 * HOUR], ['2026-11-02', 7 * HOUR],
      ]],
      // Azores skips 29 Mar 00:00 (→ 01:00 +00) and repeats 25 Oct 00:00.
      ['Atlantic/Azores', '2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z', '2026-03-28', '2026-03-29', [
        ['2026-03-28', 30 * MINUTE], ['2026-03-29', 30 * MINUTE],
      ]],
      ['Atlantic/Azores', '2026-10-24T23:30:00Z', '2026-10-25T00:30:00Z', '2026-10-24', '2026-10-25', [
        ['2026-10-24', 30 * MINUTE], ['2026-10-25', 30 * MINUTE],
      ]],
      // Amman and Gaza repeated midnight on 29 Oct 2021 (01:00 EEST → 00:00 EET).
      ['Asia/Amman', '2021-10-28T20:30:00Z', '2021-10-28T21:30:00Z', '2021-10-28', '2021-10-29', [
        ['2021-10-28', 30 * MINUTE], ['2021-10-29', 30 * MINUTE],
      ]],
      ['Asia/Gaza', '2021-10-28T20:30:00Z', '2021-10-28T21:30:00Z', '2021-10-28', '2021-10-29', [
        ['2021-10-28', 30 * MINUTE], ['2021-10-29', 30 * MINUTE],
      ]],
      ['Asia/Gaza', '2021-10-28T12:00:00Z', '2021-10-30T12:00:00Z', '2021-10-28', '2021-10-30', [
        ['2021-10-28', 9 * HOUR], ['2021-10-29', 25 * HOUR], ['2021-10-30', 14 * HOUR],
      ]],
      // Lord Howe moves by 30 minutes: a 23.5 h day.
      ['Australia/Lord_Howe', '2026-10-03T13:00:00Z', '2026-10-04T14:00:00Z', '2026-10-03', '2026-10-05', [
        ['2026-10-03', 30 * MINUTE], ['2026-10-04', 23 * HOUR + 30 * MINUTE], ['2026-10-05', HOUR],
      ]],
      ['Asia/Kathmandu', '2026-10-13T18:00:00Z', '2026-10-13T18:30:00Z', '2026-10-13', '2026-10-14', [
        ['2026-10-13', 15 * MINUTE], ['2026-10-14', 15 * MINUTE],
      ]],
    ])('%s: %s → %s', (timeZone, start, end, fromDay, toDay, expected) => {
      const report = summarizeReport([entry(start, end)], { fromDay, toDay, timeZone });
      expect(only(report, 'period').map((candidate) => [candidate.bucketStart, candidate.activeMs])).toEqual(expected);
      expect(totalOf(report).activeMs).toBe(at(end) - at(start));
    });
  });

  describe('rejects what the RPC rejects (errcode 22023)', () => {
    const base: SummarizeReportOptions = { fromDay: '2026-10-01', toDay: '2026-10-13', timeZone: 'UTC' };

    it.each<[string, SummarizeReportOptions]>([
      ['a missing last day', { ...base, toDay: null as never }],
      ['a malformed last day', { ...base, toDay: '2026-10-32' }],
      ['an unknown bucket', { ...base, bucket: 'quarter' as never }],
      ['a POSIX zone', { ...base, timeZone: 'UTC+3' }],
      ['an abbreviation', { ...base, timeZone: 'CET' }],
      ['an unknown zone', { ...base, timeZone: 'Not/AZone' }],
      ['a missing zone', { ...base, timeZone: null as never }],
      ['an inverted range', { ...base, fromDay: '2026-10-14' }],
      ['a range before 2020', { ...base, fromDay: '2019-12-31' }],
      ['a range reaching 2100', { ...base, fromDay: '2099-12-01', toDay: '2100-01-01' }],
      ['367 days', { ...base, fromDay: '2025-10-12', toDay: '2026-10-13' }],
      ['367 days by month', { ...base, fromDay: '2025-10-12', toDay: '2026-10-13', bucket: 'month' }],
      ['a project by day over 366 days', { ...base, fromDay: '2025-10-12', projectId: 'p-1' }],
      ['a project by week over 1100 days', { ...base, fromDay: '2023-10-09', projectId: 'p-1', bucket: 'week' }],
      ['a project by month over 3660 days', { ...base, fromDay: '2020-01-01', toDay: '2030-01-08', projectId: 'p-1', bucket: 'month' }],
      ['501 users', { ...base, userIds: Array.from({ length: 501 }, (_, index) => `u-${index}`) }],
      ['a project and unattributed together', { ...base, projectId: 'p-1', unattributed: true }],
    ])('%s', (_name, options) => {
      expect(() => summarizeReport([], options)).toThrow(RangeError);
    });

    it('accepts the limits themselves', () => {
      expect(() => summarizeReport([], { ...base, fromDay: '2025-10-13' })).not.toThrow(); // 366 days
      expect(() => summarizeReport([], { ...base, fromDay: '2023-10-10', projectId: 'p-1', bucket: 'week' })).not.toThrow(); // 1100
      expect(() =>
        summarizeReport([], { ...base, fromDay: '2020-01-01', toDay: '2030-01-07', projectId: 'p-1', bucket: 'month' }),
      ).not.toThrow(); // 3660
      expect(() => summarizeReport([], { ...base, fromDay: '2020-01-01', toDay: '2020-01-01' })).not.toThrow();
      expect(() => summarizeReport([], { ...base, timeZone: 'Etc/GMT+3' })).not.toThrow();
      expect(() => summarizeReport([], { ...base, userIds: Array.from({ length: 500 }, (_, index) => `u-${index}`) })).not.toThrow();
    });

    it('names the time zone in the zone error, as the client expects', () => {
      expect(() => summarizeReport([], { ...base, timeZone: 'Not/AZone' })).toThrow(/time zone/);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// summarizeReport: seeded randomized cases against a brute-force reference
// ---------------------------------------------------------------------------------------------

/** Every bound below and every local midnight in these zones and years lies on this grid. */
const CELL = 15 * MINUTE;

const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ['UTC', '2026-10-13'],
  ['America/New_York', '2026-03-08'],
  ['America/New_York', '2026-11-01'],
  ['Europe/London', '2026-03-29'],
  ['Europe/London', '2026-10-25'],
  ['America/Santiago', '2026-04-05'],
  ['America/Santiago', '2026-09-06'],
  ['America/Havana', '2026-03-08'],
  ['America/Havana', '2026-11-01'],
  ['Atlantic/Azores', '2026-03-29'],
  ['Atlantic/Azores', '2026-10-25'],
  ['Asia/Amman', '2021-10-29'],
  ['Asia/Gaza', '2021-10-29'],
  ['Asia/Gaza', '2026-10-24'],
  ['Australia/Lord_Howe', '2026-04-05'],
  ['Australia/Lord_Howe', '2026-10-04'],
  ['Asia/Kathmandu', '2026-10-14'],
];

const wallDateFormats = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` on the wall clock of `timeZone` at `ms`, straight from Intl. */
function wallDate(ms: number, timeZone: string): string {
  let format = wallDateFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    wallDateFormats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nextDayKey(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}

/** First grid instant whose wall-clock date is `day` or later (scanning from well before it). */
function referenceDayStart(day: string, timeZone: string): number {
  let ms = Date.parse(`${day}T00:00:00Z`) - 16 * HOUR;
  while (wallDate(ms, timeZone) < day) ms += CELL;
  return ms;
}

function referenceBucket(day: string, bucket: ReportBucket): string {
  if (bucket === 'day') return day;
  if (bucket === 'month') return `${day.slice(0, 7)}-01`;
  const ms = Date.parse(`${day}T00:00:00Z`);
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  return new Date(ms - sinceMonday * DAY).toISOString().slice(0, 10);
}

function referenceCompare(a: ReportRow, b: ReportRow): number {
  const rank: Record<ReportDimension, number> = { total: 0, period: 1, member: 2, project: 3, task: 4, application: 5 };
  const text = (x: string | null, y: string | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1);
  const flag = (x: boolean | null, y: boolean | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x ? 1 : -1);
  return (
    rank[a.dimension] - rank[b.dimension] ||
    text(a.bucketStart, b.bucketStart) ||
    text(a.userId, b.userId) ||
    text(a.projectId, b.projectId) ||
    flag(a.unattributed, b.unattributed) ||
    text(a.taskId, b.taskId) ||
    text(a.applicationId, b.applicationId)
  );
}

/**
 * The report from first principles, one 15-minute cell at a time: in each cell, per user, the
 * covering active interval first in (start, end, id) order wins, else the covering idle one.
 */
function referenceReport(intervals: readonly ReportInterval[], options: SummarizeReportOptions): ReportRow[] {
  const bucket = options.bucket ?? 'day';
  const selected = intervals.filter((item) => !options.userIds || options.userIds.includes(item.userId));
  const passes = (item: ReportInterval) =>
    (!options.projectId || item.projectId === options.projectId) &&
    (!options.unattributed || (item.projectId === null && item.taskId === null)) &&
    (!options.applicationId || item.applicationId === options.applicationId);

  const endMs = referenceDayStart(nextDayKey(options.toDay), options.timeZone);
  let fromDay = options.fromDay ?? null;
  if (fromDay === null) {
    const starts = selected.filter((item) => passes(item) && item.startMs < endMs).map((item) => item.startMs);
    fromDay = starts.length > 0 ? wallDate(Math.min(...starts), options.timeZone) : options.toDay;
  }
  const startMs = referenceDayStart(fromDay, options.timeZone);

  const groups = new Map<string, { row: ReportRow; ids: Set<string>; namedBy?: ReportInterval }>();
  const bump = (key: string, base: ReportRow, winner: ReportInterval) => {
    let group = groups.get(key);
    if (!group) {
      group = { row: base, ids: new Set() };
      groups.set(key, group);
    }
    if (winner.kind === 'active') group.row.activeMs += CELL;
    else group.row.idleMs += CELL;
    group.ids.add(winner.id);
    return group;
  };
  const before = (a: ReportInterval, b: ReportInterval) =>
    a.startMs < b.startMs || (a.startMs === b.startMs && (a.endMs < b.endMs || (a.endMs === b.endMs && a.id < b.id)));

  let reconciledMs = 0;
  let day = fromDay;
  const users = [...new Set(selected.map((item) => item.userId))];
  for (let cell = startMs; cell < endMs; cell += CELL) {
    const wall = wallDate(cell, options.timeZone);
    if (wall > day) day = wall;
    for (const user of users) {
      const covering = selected.filter((item) => item.userId === user && item.startMs <= cell && item.endMs >= cell + CELL);
      const pool = covering.some((item) => item.kind === 'active') ? covering.filter((item) => item.kind === 'active') : covering;
      let winner: ReportInterval | null = null;
      for (const candidate of pool) if (winner === null || before(candidate, winner)) winner = candidate;
      if (winner === null || !passes(winner)) continue;
      reconciledMs += CELL;
      const unattributed = winner.projectId === null && winner.taskId === null;
      const period = referenceBucket(day, bucket);
      bump('total', row('total'), winner);
      bump(`period ${period}`, row('period', { bucketStart: period }), winner);
      bump(`member ${winner.userId}`, row('member', { userId: winner.userId }), winner);
      bump(`project ${winner.projectId} ${unattributed}`, row('project', { projectId: winner.projectId, unattributed }), winner);
      bump(`task ${winner.projectId} ${winner.taskId}`, row('task', { projectId: winner.projectId, taskId: winner.taskId }), winner);
      const app = bump(`application ${winner.applicationId}`, row('application', { applicationId: winner.applicationId }), winner);
      const namer = app.namedBy;
      if (!namer || winner.startMs > namer.startMs || (winner.startMs === namer.startMs && winner.id > namer.id)) {
        app.namedBy = winner;
        app.row.applicationName = winner.applicationName;
      }
    }
  }

  let rawMs = 0;
  for (const item of selected) {
    if (passes(item)) rawMs += Math.max(0, Math.min(item.endMs, endMs) - Math.max(item.startMs, startMs));
  }

  const total = groups.get('total')?.row ?? row('total');
  total.entryCount = groups.get('total')?.ids.size ?? 0;
  total.overlapMs = rawMs - reconciledMs;
  total.teammatesVisible = options.teammatesVisible ?? false;
  const rest = [...groups.entries()]
    .filter(([key]) => key !== 'total')
    .map(([, group]) => ({ ...group.row, entryCount: group.ids.size }))
    .sort(referenceCompare);
  return [total, ...rest];
}

/** Total length of the union of each user's intervals inside [startMs, endMs). */
function unionMs(intervals: readonly ReportInterval[], startMs: number, endMs: number): number {
  let sum = 0;
  for (const user of new Set(intervals.map((item) => item.userId))) {
    const spansOfUser = intervals
      .filter((item) => item.userId === user)
      .map((item) => [Math.max(item.startMs, startMs), Math.min(item.endMs, endMs)] as const)
      .filter(([start, end]) => end > start)
      .sort((a, b) => a[0] - b[0]);
    let reach = Number.NEGATIVE_INFINITY;
    for (const [start, end] of spansOfUser) {
      if (end <= reach) continue;
      sum += end - Math.max(start, reach);
      reach = end;
    }
  }
  return sum;
}

interface GeneratedCase {
  intervals: ReportInterval[];
  options: SummarizeReportOptions;
}

function generateCase(random: () => number, caseIndex: number): GeneratedCase {
  const [timeZone, around] = pick(random, WINDOWS);
  const aroundMs = Date.parse(`${around}T00:00:00Z`);
  const fromDay = new Date(aroundMs - int(random, 0, 3) * DAY).toISOString().slice(0, 10);
  const toDay = new Date(Date.parse(`${fromDay}T00:00:00Z`) + int(random, 0, 5) * DAY).toISOString().slice(0, 10);

  const users = ['u-1', 'u-2', 'u-3'].slice(0, int(random, 1, 3));
  const projects = [null, null, 'p-1', 'p-2'];
  const tasks: Record<string, Array<string | null>> = { none: [null, null, 't-loose'], 'p-1': [null, 't-11', 't-12'], 'p-2': ['t-21'] };
  const apps = [
    ['figma', ['Figma', 'Figma (beta)']],
    ['blender', ['Blender']],
    ['adobe-photoshop', ['Photoshop', 'Adobe Photoshop']],
  ] as const;

  const windowStart = Date.parse(`${fromDay}T00:00:00Z`) - 30 * HOUR;
  const windowCells = Math.round((Date.parse(`${toDay}T00:00:00Z`) + 54 * HOUR - windowStart) / CELL);
  const count = int(random, 0, 18);
  const intervals: ReportInterval[] = [];
  for (let index = 0; index < count; index += 1) {
    const startMs = windowStart + int(random, 0, windowCells) * CELL;
    const length = random() < 0.08 ? 0 : random() < 0.15 ? int(random, 40, 160) : int(random, 1, 24);
    const projectId = pick(random, projects);
    const [applicationId, names] = pick(random, apps);
    intervals.push({
      id: `c${String(caseIndex).padStart(3, '0')}-${String(index).padStart(2, '0')}-${Math.floor(random() * 1e6).toString(16)}`,
      userId: pick(random, users),
      deviceId: pick(random, ['d-1', 'd-2']),
      applicationId,
      applicationName: pick(random, names),
      kind: random() < 0.6 ? 'active' : 'idle',
      startMs,
      endMs: startMs + length * CELL,
      projectId,
      taskId: pick(random, tasks[projectId ?? 'none'] ?? [null]),
    });
  }
  // A few exact duplicates in time (different ids) exercise the (start, end, id) tie-break.
  if (intervals.length > 0 && random() < 0.5) {
    const twin = pick(random, intervals);
    intervals.push({ ...twin, id: `${twin.id}-twin`, projectId: null, taskId: null });
  }

  const filter = int(random, 0, 5);
  const options: SummarizeReportOptions = {
    fromDay: random() < 0.2 ? null : fromDay,
    toDay,
    timeZone,
    bucket: pick<ReportBucket>(random, ['day', 'day', 'week', 'month']),
    teammatesVisible: random() < 0.5,
    userIds: random() < 0.3 ? users.slice(0, 1) : null,
    projectId: filter === 1 ? pick(random, ['p-1', 'p-2']) : null,
    unattributed: filter === 2,
    applicationId: filter === 3 ? pick(random, ['figma', 'blender']) : null,
  };
  return { intervals, options };
}

describe('summarizeReport: seeded randomized cases', () => {
  const CASES = 160;

  it(`matches the brute-force reference, conserves time and ignores input order (${CASES} cases)`, () => {
    // How often the generator produced the situations worth testing (checked at the end).
    const seen = { overlap: 0, idleAndActive: 0, filteredWithTime: 0, fromDayNullWithTime: 0, severalBuckets: 0, severalMembers: 0 };
    for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
      const seed = 9001 + caseIndex;
      const random = rng(seed);
      const { intervals, options } = generateCase(random, caseIndex);
      const label = `case ${caseIndex} (seed ${seed}, ${options.timeZone}, ${options.fromDay ?? 'null'}..${options.toDay}, ${options.bucket})`;

      const report = summarizeReport(intervals, options);
      expect(report, label).toEqual(referenceReport(intervals, options));
      expect(summarizeReport(shuffled(random, intervals), options), `${label}: shuffled`).toEqual(report);

      // Conservation, in ms: every dimension sums to the total.
      const total = totalOf(report);
      for (const dimension of ['period', 'member', 'project', 'task', 'application'] as const) {
        const rows = only(report, dimension);
        expect(rows.reduce((sum, item) => sum + item.activeMs, 0), `${label}: ${dimension} active`).toBe(total.activeMs);
        expect(rows.reduce((sum, item) => sum + item.idleMs, 0), `${label}: ${dimension} idle`).toBe(total.idleMs);
      }
      expect(total.overlapMs, `${label}: overlap`).toBeGreaterThanOrEqual(0);

      // Unfiltered, foreground is the union of each user's intervals inside the range.
      const unfilteredTotal = totalOf(
        summarizeReport(intervals, { ...options, projectId: null, unattributed: false, applicationId: null }),
      );
      if (options.fromDay) {
        const selected = intervals.filter((item) => !options.userIds || options.userIds.includes(item.userId));
        const startMs = referenceDayStart(options.fromDay, options.timeZone);
        const endMs = referenceDayStart(nextDayKey(options.toDay), options.timeZone);
        expect(unfilteredTotal.activeMs + unfilteredTotal.idleMs, `${label}: union`).toBe(unionMs(selected, startMs, endMs));
      }
      // A filtered figure is always part of the unfiltered one.
      expect(total.activeMs + total.idleMs, `${label}: filtered ⊆ unfiltered`).toBeLessThanOrEqual(
        unfilteredTotal.activeMs + unfilteredTotal.idleMs,
      );

      const filtered = Boolean(options.projectId || options.unattributed || options.applicationId);
      if (total.overlapMs > 0) seen.overlap += 1;
      if (total.activeMs > 0 && total.idleMs > 0) seen.idleAndActive += 1;
      if (filtered && total.activeMs + total.idleMs > 0) seen.filteredWithTime += 1;
      if (!options.fromDay && total.activeMs + total.idleMs > 0) seen.fromDayNullWithTime += 1;
      if (only(report, 'period').length > 1) seen.severalBuckets += 1;
      if (only(report, 'member').length > 1) seen.severalMembers += 1;
    }
    for (const [situation, count] of Object.entries(seen)) expect(count, situation).toBeGreaterThanOrEqual(10);
  }, 30_000); // ~2.5 s alone; slower when the full suite runs files in parallel

  it('reconciled pieces are disjoint per user and add up to the union, in every generated case', () => {
    for (let caseIndex = 0; caseIndex < 120; caseIndex += 1) {
      const seed = 4242 + caseIndex;
      const random = rng(seed);
      const { intervals } = generateCase(random, caseIndex);
      const earliest = intervals.length > 0 ? Math.min(...intervals.map((item) => item.startMs)) : at('2026-10-13T00:00:00Z');
      const rangeStart = earliest + int(random, 0, 48) * CELL;
      const range = { startMs: rangeStart, endMs: rangeStart + int(random, 1, 400) * CELL };
      const { pieces, rawMs } = reconcileIntervals(intervals, range);
      const label = `case ${caseIndex} (seed ${seed})`;
      let previous: { userId: string; endMs: number } | null = null;
      for (const piece of pieces) {
        expect(piece.startMs, label).toBeLessThan(piece.endMs);
        expect(piece.startMs, label).toBeGreaterThanOrEqual(Math.max(piece.sourceStartMs, range.startMs));
        expect(piece.endMs, label).toBeLessThanOrEqual(Math.min(piece.sourceEndMs, range.endMs));
        if (previous && previous.userId === piece.userId) expect(piece.startMs, label).toBeGreaterThanOrEqual(previous.endMs);
        previous = piece;
      }
      const piecesMs = pieces.reduce((sum, piece) => sum + piece.endMs - piece.startMs, 0);
      expect(piecesMs, label).toBe(unionMs(intervals, range.startMs, range.endMs));
      expect(rawMs, label).toBe(
        intervals.reduce((sum, item) => sum + Math.max(0, Math.min(item.endMs, range.endMs) - Math.max(item.startMs, range.startMs)), 0),
      );
    }
  });
});
