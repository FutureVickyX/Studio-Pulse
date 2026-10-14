import { describe, expect, it } from 'vitest';

import { validateCustomRange } from '@studio-pulse/validation';

const DATE_MESSAGE = 'must be a real calendar date in the form YYYY-MM-DD';

describe('validateCustomRange', () => {
  it.each([
    ['2026-10-03', '2026-10-09'],
    ['2026-10-13', '2026-10-13'], // a single day
    ['2024-02-29', '2024-03-01'], // leap day
    ['2025-12-28', '2026-01-03'], // across a year boundary
    ['2024-01-01', '2024-12-31'], // a full leap year: 366 days
    ['2025-01-01', '2026-01-01'], // 366 days counted inclusively
  ])('accepts %s … %s', (start, end) => {
    expect(validateCustomRange(start, end)).toEqual({ ok: true, value: { start, end } });
  });

  it.each([
    ['2026-02-29', '2026-03-01', [`start: ${DATE_MESSAGE}`]], // 2026 is not a leap year
    ['2026-04-31', '2026-05-01', [`start: ${DATE_MESSAGE}`]],
    ['2026-13-01', '2026-13-02', [`start: ${DATE_MESSAGE}`, `end: ${DATE_MESSAGE}`]],
    ['2026-10-3', '2026-10-09', [`start: ${DATE_MESSAGE}`]],
    ['2026-10-03', '09/10/2026', [`end: ${DATE_MESSAGE}`]],
    ['2026-10-03T00:00:00Z', '2026-10-09', [`start: ${DATE_MESSAGE}`]],
    ['', '', [`start: ${DATE_MESSAGE}`, `end: ${DATE_MESSAGE}`]],
    ['2026-00-10', '2026-01-10', [`start: ${DATE_MESSAGE}`]],
  ])('rejects malformed %j … %j', (start, end, issues) => {
    expect(validateCustomRange(start, end)).toEqual({ ok: false, issues });
  });

  it('rejects a start after the end', () => {
    expect(validateCustomRange('2026-10-09', '2026-10-03')).toEqual({
      ok: false,
      issues: ['end: must be on or after the start date'],
    });
  });

  it('rejects spans longer than 366 days', () => {
    expect(validateCustomRange('2025-01-01', '2026-01-02')).toEqual({
      ok: false,
      issues: ['end: the range covers 367 days; at most 366 days are allowed'],
    });
    expect(validateCustomRange('2020-01-01', '2026-01-01').ok).toBe(false);
  });

  it('handles untyped callers without throwing', () => {
    expect(validateCustomRange(undefined as unknown as string, 20261003 as unknown as string).ok).toBe(false);
  });
});
