import { describe, expect, it } from 'vitest';

import {
  assignApplicationColors,
  colorFor,
  OTHER_COLOR,
  SERIES_COLORS,
  SERIES_SLOT_COUNT,
} from '../../../apps/desktop/src/lib/colors';
import type { ColorCandidate } from '../../../apps/desktop/src/lib/colors';
import { addDaysToKey, dayAxisLabel, parseDayKeyUtc } from '../../../apps/desktop/src/lib/days';

const candidate = (applicationId: string, activeMs: number): ColorCandidate => ({
  applicationId,
  activeMs,
  foregroundMs: activeMs,
});

describe('assignApplicationColors', () => {
  it('colours by registry order, not by rank, so a re-ranking never repaints an app', () => {
    const order = new Map([
      ['figma', 0],
      ['photoshop', 1],
      ['blender', 2],
    ]);
    const morning = assignApplicationColors([candidate('blender', 10), candidate('figma', 5), candidate('photoshop', 1)], order);
    const evening = assignApplicationColors([candidate('photoshop', 99), candidate('blender', 1), candidate('figma', 50)], order);
    expect(morning).toEqual(evening);
    expect(morning.get('figma')).toBe(SERIES_COLORS[0]);
    expect(morning.get('photoshop')).toBe(SERIES_COLORS[1]);
    expect(morning.get('blender')).toBe(SERIES_COLORS[2]);
  });

  it('folds everything past seven applications into Other, keeping the most active', () => {
    const present = Array.from({ length: 10 }, (_, index) => candidate(`app-${index}`, (index + 1) * 1000));
    const order = new Map(present.map((item, index) => [item.applicationId, index]));
    const colors = assignApplicationColors(present, order);
    const coloured = [...colors.entries()].filter(([, color]) => color !== OTHER_COLOR).map(([id]) => id);
    expect(coloured.sort()).toEqual(['app-3', 'app-4', 'app-5', 'app-6', 'app-7', 'app-8', 'app-9']);
    expect(colors.get('app-0')).toBe(OTHER_COLOR);
    expect(new Set(coloured.map((id) => colors.get(id))).size).toBe(SERIES_SLOT_COUNT - 1);
  });

  it('uses all eight slots when exactly eight applications are shown', () => {
    const present = Array.from({ length: 8 }, (_, index) => candidate(`app-${index}`, 1));
    const colors = assignApplicationColors(present, new Map());
    expect([...colors.values()].sort()).toEqual([...SERIES_COLORS].sort());
  });

  it('sorts unknown (e.g. deleted) applications after known ones, by id', () => {
    const colors = assignApplicationColors([candidate('zeta', 1), candidate('alpha', 1), candidate('known', 1)], new Map([['known', 5]]));
    expect(colors.get('known')).toBe(SERIES_COLORS[0]);
    expect(colors.get('alpha')).toBe(SERIES_COLORS[1]);
    expect(colors.get('zeta')).toBe(SERIES_COLORS[2]);
  });

  it('falls back to Other for an application without a colour', () => {
    expect(colorFor(new Map(), 'missing')).toBe(OTHER_COLOR);
  });
});

describe('day keys', () => {
  it('parses real YYYY-MM-DD keys only', () => {
    expect(parseDayKeyUtc('2026-10-13')).toBe(Date.UTC(2026, 9, 13));
    expect(parseDayKeyUtc('2026-1-13')).toBeNull();
    expect(parseDayKeyUtc('13/10/2026')).toBeNull();
  });

  it('adds calendar days across month, year and leap-day boundaries', () => {
    expect(addDaysToKey('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToKey('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDaysToKey('2026-10-13', -6)).toBe('2026-10-07');
  });

  it('is independent of DST (a key is a calendar day, not an instant)', () => {
    expect(addDaysToKey('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDaysToKey('2026-10-25', 1)).toBe('2026-10-26');
  });

  it('labels columns with weekdays up to a week, day numbers beyond', () => {
    expect(dayAxisLabel('2026-10-13', 7, 'en-GB')).toBe('Tue');
    expect(dayAxisLabel('2026-10-13', 30, 'en-GB')).toBe('13');
    expect(dayAxisLabel('not-a-day', 7, 'en-GB')).toBe('not-a-day');
  });
});
