import { describe, expect, it } from 'vitest';

import {
  durationTicks,
  formatAxisDuration,
  timelineTicks,
  timelineWindow,
} from '../../../apps/desktop/src/lib/chartScales';

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Local midnight of a day, as UTC ms. Offsets other than whole hours are deliberate in places. */
const DAY_START = Date.UTC(2026, 9, 13, 0, 0);
const DAY_END = DAY_START + 24 * HOUR;
const at = (hours: number, minutes = 0) => DAY_START + hours * HOUR + minutes * MINUTE;

describe('timelineWindow', () => {
  it('shows the whole day when nothing is recorded and the day is not today', () => {
    expect(timelineWindow(DAY_START, DAY_END, [], null)).toEqual({ startMs: DAY_START, endMs: DAY_END });
  });

  it('fits the recorded hours, hour-aligned, at least 4 h wide', () => {
    expect(timelineWindow(DAY_START, DAY_END, [{ startMs: at(9, 20), endMs: at(10, 10) }], null)).toEqual({
      startMs: at(9),
      endMs: at(13),
    });
  });

  it('keeps a wider recorded span as-is (floored start, ceiled end)', () => {
    const segments = [
      { startMs: at(8, 45), endMs: at(10) },
      { startMs: at(14, 5), endMs: at(17, 30) },
    ];
    expect(timelineWindow(DAY_START, DAY_END, segments, null)).toEqual({ startMs: at(8), endMs: at(18) });
  });

  it('extends to now on a live day', () => {
    expect(timelineWindow(DAY_START, DAY_END, [{ startMs: at(9), endMs: at(9, 30) }], at(15, 10))).toEqual({
      startMs: at(9),
      endMs: at(16),
    });
  });

  it('shows the hours before now on a live day with nothing recorded yet', () => {
    const view = timelineWindow(DAY_START, DAY_END, [], at(11, 40));
    expect(view).toEqual({ startMs: at(8), endMs: at(12) });
  });

  it('ignores a now that is outside the day', () => {
    const segments = [{ startMs: at(9), endMs: at(10) }];
    expect(timelineWindow(DAY_START, DAY_END, segments, DAY_END + HOUR)).toEqual(
      timelineWindow(DAY_START, DAY_END, segments, null),
    );
  });

  it('clips intervals that cross midnight to the day', () => {
    const view = timelineWindow(DAY_START, DAY_END, [{ startMs: DAY_START - 2 * HOUR, endMs: at(0, 30) }], null);
    expect(view).toEqual({ startMs: DAY_START, endMs: at(4) });
  });

  it('moves the start back instead of running past the end of the day', () => {
    const view = timelineWindow(DAY_START, DAY_END, [{ startMs: at(22, 30), endMs: at(23, 50) }], null);
    expect(view).toEqual({ startMs: at(20), endMs: DAY_END });
  });

  it('stays inside a 23-hour DST day', () => {
    const shortEnd = DAY_START + 23 * HOUR;
    const view = timelineWindow(DAY_START, shortEnd, [{ startMs: at(21, 15), endMs: at(22, 40) }], null);
    expect(view.endMs).toBe(shortEnd);
    expect(view.endMs - view.startMs).toBe(4 * HOUR);
    expect(view.startMs).toBeGreaterThanOrEqual(DAY_START);
  });

  it('aligns to local hours when local midnight is not a UTC hour (e.g. UTC+5:30)', () => {
    const indiaStart = Date.UTC(2026, 9, 12, 18, 30);
    const view = timelineWindow(indiaStart, indiaStart + 24 * HOUR, [{ startMs: indiaStart + 9.5 * HOUR, endMs: indiaStart + 10 * HOUR }], null);
    expect((view.startMs - indiaStart) % HOUR).toBe(0);
    expect((view.endMs - indiaStart) % HOUR).toBe(0);
  });
});

describe('timelineTicks', () => {
  it('ticks every hour across a 4-hour window', () => {
    expect(timelineTicks(at(9), at(13), DAY_START)).toEqual([at(9), at(10), at(11), at(12), at(13)]);
  });

  it('widens the step to stay within maxTicks', () => {
    expect(timelineTicks(DAY_START, DAY_END, DAY_START)).toEqual([0, 4, 8, 12, 16, 20, 24].map((h) => at(h)));
    expect(timelineTicks(at(6), at(18), DAY_START)).toEqual([6, 8, 10, 12, 14, 16, 18].map((h) => at(h)));
  });

  it('never exceeds maxTicks', () => {
    for (let hours = 1; hours <= 24; hours += 1) {
      expect(timelineTicks(DAY_START, at(hours), DAY_START).length).toBeLessThanOrEqual(7);
      expect(timelineTicks(DAY_START, at(hours), DAY_START, 4).length).toBeLessThanOrEqual(4);
    }
  });

  it('places ticks on local hours counted from local midnight', () => {
    const indiaStart = Date.UTC(2026, 9, 12, 18, 30);
    const ticks = timelineTicks(indiaStart + 9 * HOUR, indiaStart + 13 * HOUR, indiaStart);
    expect(ticks).toEqual([9, 10, 11, 12, 13].map((h) => indiaStart + h * HOUR));
  });

  it('starts at the first aligned tick inside the window', () => {
    expect(timelineTicks(at(9, 20), at(13), DAY_START)[0]).toBe(at(10));
  });
});

describe('durationTicks', () => {
  it('shows 0 and 1 h for an empty chart', () => {
    expect(durationTicks(0)).toEqual([0, HOUR]);
    expect(durationTicks(-5)).toEqual([0, HOUR]);
  });

  it.each([
    [50 * MINUTE, [0, 15, 30, 45, 60].map((m) => m * MINUTE)],
    [8 * HOUR, [0, 2, 4, 6, 8].map((h) => h * HOUR)],
    [30 * HOUR, [0, 8, 16, 24, 32].map((h) => h * HOUR)],
    [100 * HOUR, [0, 25, 50, 75, 100].map((h) => h * HOUR)],
  ])('%i ms → clean steps', (max, expected) => {
    expect(durationTicks(max)).toEqual(expected);
  });

  it('always starts at 0, rises evenly, reaches the maximum and uses at most 4 steps', () => {
    for (const max of [1, MINUTE, 7 * MINUTE, 59 * MINUTE, 61 * MINUTE, 3.3 * HOUR, 11 * HOUR, 23.9 * HOUR, 70 * HOUR]) {
      const ticks = durationTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(5);
      const step = ticks[1]! - ticks[0]!;
      ticks.forEach((tick, index) => expect(tick).toBe(index * step));
    }
  });
});

describe('formatAxisDuration', () => {
  it.each([
    [0, '0'],
    [-MINUTE, '0'],
    [30 * MINUTE, '30m'],
    [HOUR, '1h'],
    [2 * HOUR, '2h'],
    [90 * MINUTE, '1h 30m'],
    [25 * HOUR, '25h'],
    [29 * 1000, '0m'],
    [31 * 1000, '1m'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatAxisDuration(ms)).toBe(text);
  });
});
