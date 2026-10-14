import { describe, expect, it } from 'vitest';

import { clipInterval, normalizeEvents, resolveOverlaps, splitByLocalDay } from '@studio-pulse/time-engine';

import { HOUR, MINUTE, at, event, interval, sumPieces } from './builders';

const DAY_PLUS_20MS = 24 * HOUR + 20;

describe('normalizeEvents', () => {
  it('parses ISO timestamps (Z or numeric offset) to epoch ms', () => {
    const [utc, offset] = normalizeEvents([
      event({ id: 'a', start: '2026-10-13T09:00:00.000Z', end: '2026-10-13T09:30:00.000Z' }),
      event({ id: 'b', start: '2026-10-13T15:00:00+05:30', end: '2026-10-13T15:30:00.250+05:30' }),
    ]);
    expect(utc).toMatchObject({ id: 'a', startMs: at('2026-10-13T09:00:00Z'), endMs: at('2026-10-13T09:30:00Z') });
    expect(offset).toMatchObject({
      id: 'b',
      startMs: at('2026-10-13T09:30:00Z'),
      endMs: at('2026-10-13T10:00:00.250Z'),
    });
  });

  it('drops malformed, reversed and zero-length records', () => {
    const kept = event({ id: 'ok', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:01:00Z' });
    const result = normalizeEvents([
      kept,
      event({ id: 'nan', start: 'not a date', end: '2026-10-13T09:01:00Z' }),
      event({ id: 'reversed', start: '2026-10-13T10:00:00Z', end: '2026-10-13T09:00:00Z' }),
      event({ id: 'zero', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:00:00Z' }),
      event({ id: 'feb30', start: '2026-02-30T09:00:00Z', end: '2026-03-01T09:00:00Z' }),
      event({ id: 'no-offset', start: '2026-10-13T09:00:00', end: '2026-10-13T10:00:00' }),
      event({ id: 'hour25', start: '2026-10-13T25:00:00Z', end: '2026-10-14T02:00:00Z' }),
      event({ id: 'bad-kind', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:01:00Z', kind: 'busy' as never }),
      event({ id: '', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:01:00Z' }),
    ]);
    expect(result.map((item) => item.id)).toEqual(['ok']);
  });

  it('re-derives active/idle ms from timestamps and kind, ignoring stored seconds', () => {
    const [active, idle] = normalizeEvents([
      event({
        id: 'active',
        kind: 'active',
        start: '2026-10-13T09:00:00Z',
        end: '2026-10-13T09:30:00Z',
        activeSeconds: 5,
        idleSeconds: 999,
        durationSeconds: 1,
      }),
      event({
        id: 'idle',
        kind: 'idle',
        start: '2026-10-13T09:30:00Z',
        end: '2026-10-13T09:50:00Z',
        activeSeconds: 1200,
        idleSeconds: 0,
      }),
    ]);
    expect(active).toMatchObject({ activeMs: 30 * MINUTE, idleMs: 0 });
    expect(idle).toMatchObject({ activeMs: 0, idleMs: 20 * MINUTE });
    for (const item of [active, idle]) {
      expect(item!.activeMs + item!.idleMs).toBe(item!.endMs - item!.startMs);
    }
  });

  it('de-duplicates by id: highest revision wins, then the later endedAt', () => {
    const result = normalizeEvents([
      event({ id: 'x', revision: 2, start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:05:00Z' }),
      event({ id: 'x', revision: 1, start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:10:00Z' }),
      event({ id: 'y', revision: 3, start: '2026-10-13T10:00:00Z', end: '2026-10-13T10:15:00Z', state: 'open' }),
      event({ id: 'y', revision: 3, start: '2026-10-13T10:00:00Z', end: '2026-10-13T10:20:00Z', state: 'closed' }),
      event({ id: 'y', revision: 3, start: '2026-10-13T10:00:00Z', end: '2026-10-13T10:18:00Z', state: 'open' }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'x', endMs: at('2026-10-13T09:05:00Z') });
    expect(result[1]).toMatchObject({ id: 'y', endMs: at('2026-10-13T10:20:00Z'), open: false });
  });

  it('marks open intervals, keeps attribution and sorts chronologically', () => {
    const result = normalizeEvents([
      event({ id: 'late', start: '2026-10-13T11:00:00Z', end: '2026-10-13T11:10:00Z', state: 'open' }),
      event({ id: 'early', start: '2026-10-13T08:00:00Z', end: '2026-10-13T08:10:00Z', projectId: 'p1', taskId: 't1' }),
    ]);
    expect(result.map((item) => item.id)).toEqual(['early', 'late']);
    expect(result[0]).toMatchObject({ projectId: 'p1', taskId: 't1', open: false, source: 'automatic' });
    expect(result[1]!.open).toBe(true);
  });

  it('falls back to the application id when the name snapshot is empty', () => {
    const [item] = normalizeEvents([
      event({ applicationId: 'blender', applicationName: '', start: '2026-10-13T08:00:00Z', end: '2026-10-13T08:10:00Z' }),
    ]);
    expect(item!.applicationName).toBe('blender');
  });
});

describe('resolveOverlaps', () => {
  const nine = at('2026-10-13T09:00:00Z');

  it('clips a later interval on the same device to start at the previous end', () => {
    const { intervals, clippedMs } = resolveOverlaps([
      interval(nine, nine + HOUR, { id: 'a' }),
      interval(nine + 30 * MINUTE, nine + 90 * MINUTE, { id: 'b', applicationId: 'blender' }),
    ]);
    expect(clippedMs).toBe(30 * MINUTE);
    expect(intervals).toHaveLength(2);
    expect(intervals[1]).toMatchObject({ id: 'b', startMs: nine + HOUR, endMs: nine + 90 * MINUTE, activeMs: 30 * MINUTE });
    // Every instant counted once.
    expect(sumPieces(intervals).foregroundMs).toBe(90 * MINUTE);
  });

  it('drops intervals fully covered by an earlier one', () => {
    const { intervals, clippedMs } = resolveOverlaps([
      interval(nine, nine + 2 * HOUR, { id: 'outer' }),
      interval(nine + 15 * MINUTE, nine + 45 * MINUTE, { id: 'inner' }),
      interval(nine + 2 * HOUR, nine + 3 * HOUR, { id: 'after' }),
    ]);
    expect(intervals.map((item) => item.id)).toEqual(['outer', 'after']);
    expect(clippedMs).toBe(30 * MINUTE);
  });

  it('keeps the high-water mark across a covered interval', () => {
    const { intervals, clippedMs } = resolveOverlaps([
      interval(nine, nine + 2 * HOUR, { id: 'a' }),
      interval(nine + 10 * MINUTE, nine + 20 * MINUTE, { id: 'b' }),
      interval(nine + 90 * MINUTE, nine + 150 * MINUTE, { id: 'c' }),
    ]);
    expect(intervals.find((item) => item.id === 'c')).toMatchObject({ startMs: nine + 2 * HOUR });
    expect(clippedMs).toBe(10 * MINUTE + 30 * MINUTE);
  });

  it('orders equal starts by id', () => {
    const { intervals, clippedMs } = resolveOverlaps([
      interval(nine, nine + 20 * MINUTE, { id: 'b' }),
      interval(nine, nine + 10 * MINUTE, { id: 'a' }),
    ]);
    expect(intervals.map((item) => [item.id, item.startMs])).toEqual([
      ['a', nine],
      ['b', nine + 10 * MINUTE],
    ]);
    expect(clippedMs).toBe(10 * MINUTE);
  });

  it('never clips across devices', () => {
    const input = [
      interval(nine, nine + HOUR, { id: 'desk', deviceId: 'desktop' }),
      interval(nine + 30 * MINUTE, nine + 90 * MINUTE, { id: 'lap', deviceId: 'laptop' }),
    ];
    const { intervals, clippedMs } = resolveOverlaps(input);
    expect(clippedMs).toBe(0);
    expect(intervals).toEqual(input);
  });

  it('scales idle intervals and keeps the open flag of a clipped live interval', () => {
    const { intervals } = resolveOverlaps([
      interval(nine, nine + HOUR, { id: 'a' }),
      interval(nine + 40 * MINUTE, nine + 70 * MINUTE, { id: 'b', kind: 'idle', open: true }),
    ]);
    expect(intervals[1]).toMatchObject({ startMs: nine + HOUR, activeMs: 0, idleMs: 10 * MINUTE, open: true });
  });

  it('returns no clipping for clean, contiguous input', () => {
    const input = [interval(nine, nine + HOUR, { id: 'a' }), interval(nine + HOUR, nine + 2 * HOUR, { id: 'b' })];
    expect(resolveOverlaps(input)).toEqual({ intervals: input, clippedMs: 0 });
  });
});

describe('clipInterval', () => {
  const nine = at('2026-10-13T09:00:00Z');

  it('clips an active interval and re-derives its active time', () => {
    const clipped = clipInterval(interval(nine, nine + HOUR), nine + 15 * MINUTE, nine + 2 * HOUR);
    expect(clipped).toMatchObject({ startMs: nine + 15 * MINUTE, endMs: nine + HOUR, activeMs: 45 * MINUTE, idleMs: 0 });
  });

  it('scales a mixed active/idle interval proportionally', () => {
    const mixed = interval(nine, nine + HOUR, { activeMs: 30 * MINUTE, idleMs: 30 * MINUTE });
    expect(clipInterval(mixed, nine, nine + 20 * MINUTE)).toMatchObject({ activeMs: 10 * MINUTE, idleMs: 10 * MINUTE });
  });

  it('returns null when nothing remains', () => {
    const item = interval(nine, nine + HOUR);
    expect(clipInterval(item, nine + HOUR, nine + 2 * HOUR)).toBeNull();
    expect(clipInterval(item, nine - HOUR, nine)).toBeNull();
    expect(clipInterval(item, nine + 30 * MINUTE, nine + 30 * MINUTE)).toBeNull();
    expect(clipInterval(item, nine + 40 * MINUTE, nine + 20 * MINUTE)).toBeNull();
  });

  it('returns an equal copy when the window covers the interval', () => {
    const item = interval(nine, nine + HOUR, { open: true });
    const clipped = clipInterval(item, nine - HOUR, nine + 2 * HOUR);
    expect(clipped).toEqual(item);
    expect(clipped).not.toBe(item);
  });

  it('keeps `open` only while the live edge survives', () => {
    const live = interval(nine, nine + HOUR, { open: true });
    expect(clipInterval(live, nine + 10 * MINUTE, nine + 2 * HOUR)!.open).toBe(true);
    expect(clipInterval(live, nine, nine + 30 * MINUTE)!.open).toBe(false);
  });
});

describe('splitByLocalDay', () => {
  it('splits an interval that spans UTC midnight', () => {
    const pieces = splitByLocalDay([interval(at('2026-10-12T23:30:00Z'), at('2026-10-13T00:45:00Z'))], 'UTC');
    expect(pieces.map(({ day, interval: piece }) => [day, piece.endMs - piece.startMs, piece.activeMs])).toEqual([
      ['2026-10-12', 30 * MINUTE, 30 * MINUTE],
      ['2026-10-13', 45 * MINUTE, 45 * MINUTE],
    ]);
  });

  it('splits at local midnight, not UTC midnight (America/New_York)', () => {
    // 23:30 → 00:30 EDT on the night of 11/12 October 2026.
    const pieces = splitByLocalDay([interval(at('2026-10-12T03:30:00Z'), at('2026-10-12T04:30:00Z'))], 'America/New_York');
    expect(pieces.map(({ day, interval: piece }) => [day, piece.startMs, piece.endMs])).toEqual([
      ['2026-10-11', at('2026-10-12T03:30:00Z'), at('2026-10-12T04:00:00Z')],
      ['2026-10-12', at('2026-10-12T04:00:00Z'), at('2026-10-12T04:30:00Z')],
    ]);
    // The same interval does not cross midnight in UTC.
    expect(splitByLocalDay([interval(at('2026-10-12T03:30:00Z'), at('2026-10-12T04:30:00Z'))], 'UTC')).toHaveLength(1);
  });

  it('splits at 18:15 UTC in Asia/Kathmandu (+05:45)', () => {
    const pieces = splitByLocalDay([interval(at('2026-10-13T18:00:00Z'), at('2026-10-13T18:30:00Z'))], 'Asia/Kathmandu');
    expect(pieces.map(({ day, interval: piece }) => [day, piece.endMs - piece.startMs])).toEqual([
      ['2026-10-13', 15 * MINUTE],
      ['2026-10-14', 15 * MINUTE],
    ]);
  });

  it('gives the New York spring-forward day 23 h and sums exactly to the duration', () => {
    // 22:00 EST on 7 March → 02:00 EDT on 9 March: 27 real hours.
    const item = interval(at('2026-03-08T03:00:00Z'), at('2026-03-09T06:00:00Z'));
    const pieces = splitByLocalDay([item], 'America/New_York');
    expect(pieces.map(({ day, interval: piece }) => [day, (piece.endMs - piece.startMs) / HOUR])).toEqual([
      ['2026-03-07', 2],
      ['2026-03-08', 23],
      ['2026-03-09', 2],
    ]);
    const sum = sumPieces(pieces.map((piece) => piece.interval));
    expect(sum.foregroundMs).toBe(27 * HOUR);
    expect(sum.activeMs).toBe(item.activeMs);
    expect(sum.idleMs).toBe(0);
  });

  it('gives the New York fall-back day 25 h', () => {
    const item = interval(at('2026-10-31T20:00:00Z'), at('2026-11-02T20:00:00Z'), { kind: 'idle' });
    const pieces = splitByLocalDay([item], 'America/New_York');
    const byDay = Object.fromEntries(pieces.map(({ day, interval: piece }) => [day, (piece.endMs - piece.startMs) / HOUR]));
    expect(byDay).toEqual({ '2026-10-31': 8, '2026-11-01': 25, '2026-11-02': 15 });
    const sum = sumPieces(pieces.map((piece) => piece.interval));
    expect(sum).toEqual({ foregroundMs: 48 * HOUR, activeMs: 0, idleMs: 48 * HOUR });
  });

  it('gives the London spring-forward day 23 h', () => {
    const item = interval(at('2026-03-28T12:00:00Z'), at('2026-03-30T12:00:00Z'));
    const pieces = splitByLocalDay([item], 'Europe/London');
    const byDay = Object.fromEntries(pieces.map(({ day, interval: piece }) => [day, (piece.endMs - piece.startMs) / HOUR]));
    expect(byDay).toEqual({ '2026-03-28': 12, '2026-03-29': 23, '2026-03-30': 13 });
    expect(sumPieces(pieces.map((piece) => piece.interval)).foregroundMs).toBe(48 * HOUR);
  });

  it('keeps proportional active/idle of a mixed interval exact across pieces (no rounding drift)', () => {
    // 7 ms of active spread over three uneven pieces would drift if each piece rounded on its own.
    const start = at('2026-10-12T23:59:59.990Z');
    const item = interval(start, start + DAY_PLUS_20MS, { activeMs: 7, idleMs: DAY_PLUS_20MS - 7 });
    const pieces = splitByLocalDay([item], 'UTC');
    expect(pieces).toHaveLength(3);
    const sum = sumPieces(pieces.map((piece) => piece.interval));
    expect(sum).toEqual({ foregroundMs: DAY_PLUS_20MS, activeMs: 7, idleMs: DAY_PLUS_20MS - 7 });
    for (const { interval: piece } of pieces) {
      expect(piece.activeMs + piece.idleMs).toBe(piece.endMs - piece.startMs);
      expect(Number.isInteger(piece.activeMs)).toBe(true);
    }
  });

  it('marks only the last piece of a live interval as open', () => {
    const pieces = splitByLocalDay(
      [interval(at('2026-10-12T23:00:00Z'), at('2026-10-13T01:00:00Z'), { open: true })],
      'UTC',
    );
    expect(pieces.map((piece) => piece.interval.open)).toEqual([false, true]);
  });

  it('returns one piece per (day, interval) for several intervals', () => {
    const pieces = splitByLocalDay(
      [
        interval(at('2026-10-12T10:00:00Z'), at('2026-10-12T11:00:00Z'), { id: 'a' }),
        interval(at('2026-10-12T23:00:00Z'), at('2026-10-13T01:00:00Z'), { id: 'b' }),
      ],
      'UTC',
    );
    expect(pieces.map((piece) => [piece.day, piece.interval.id])).toEqual([
      ['2026-10-12', 'a'],
      ['2026-10-12', 'b'],
      ['2026-10-13', 'b'],
    ]);
  });
});
