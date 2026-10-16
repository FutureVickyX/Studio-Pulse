import { describe, expect, it } from 'vitest';

import { resolveRange, summarize } from '@studio-pulse/time-engine';
import type { UsageSummary } from '@studio-pulse/time-engine';

import { HOUR, MINUTE, at, application, event, sumTotals } from './builders';

const APPS = [
  application('figma', 'Figma', 'design'),
  application('adobe-photoshop', 'Adobe Photoshop', 'design'),
  application('adobe-after-effects', 'Adobe After Effects', 'motion'),
  application('blender', 'Blender', '3d'),
  application('vscode', 'Visual Studio Code', 'code', { includeInReports: false, enabled: true }),
];

const NOW = at('2026-10-13T18:00:00Z');
const TODAY_UTC = resolveRange('today', { now: NOW, timeZone: 'UTC' });

/** Every breakdown must add up to the totals. */
function expectReconciled(summary: UsageSummary): void {
  const { totals } = summary;
  expect(totals.foregroundMs).toBe(totals.activeMs + totals.idleMs);
  expect(sumTotals(summary.byApplication)).toEqual(totals);
  expect(sumTotals(summary.byCategory)).toEqual(totals);
  expect(sumTotals(summary.byDay)).toEqual(totals);
  expect(sumTotals(summary.byWeek)).toEqual(totals);
  expect(sumTotals(summary.byProject)).toEqual(totals);
  expect(summary.timeline.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0)).toBe(totals.foregroundMs);
  for (const day of summary.byDay) {
    const perApp = Object.values(day.activeByApplication).reduce((sum, ms) => sum + ms, 0);
    expect(perApp).toBe(day.activeMs);
  }
}

describe('summarize: the spec example', () => {
  it('Photoshop in the foreground for 60 min with a 20 min idle stretch → 60 / 40 / 20', () => {
    const events = [
      event({ applicationId: 'adobe-photoshop', applicationName: 'Adobe Photoshop', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:25:00Z', endReason: 'becameIdle' }),
      event({ applicationId: 'adobe-photoshop', applicationName: 'Adobe Photoshop', kind: 'idle', start: '2026-10-13T09:25:00Z', end: '2026-10-13T09:45:00Z', endReason: 'inputResumed' }),
      event({ applicationId: 'adobe-photoshop', applicationName: 'Adobe Photoshop', start: '2026-10-13T09:45:00Z', end: '2026-10-13T10:00:00Z' }),
    ];
    const summary = summarize(events, { range: TODAY_UTC, applications: APPS });
    expect(summary.totals).toEqual({ foregroundMs: 60 * MINUTE, activeMs: 40 * MINUTE, idleMs: 20 * MINUTE });
    expect(summary.byApplication).toEqual([
      {
        applicationId: 'adobe-photoshop',
        name: 'Adobe Photoshop',
        category: 'design',
        foregroundMs: 60 * MINUTE,
        activeMs: 40 * MINUTE,
        idleMs: 20 * MINUTE,
        activeShare: 1,
      },
    ]);
    expect(summary.intervalCount).toBe(3);
    expect(summary.overlapClippedMs).toBe(0);
    expectReconciled(summary);
  });
});

describe('summarize: application switching', () => {
  const events = [
    event({ applicationId: 'figma', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:30:00Z' }),
    event({ applicationId: 'adobe-photoshop', start: '2026-10-13T09:30:00Z', end: '2026-10-13T10:15:00Z' }),
    event({ applicationId: 'figma', start: '2026-10-13T10:15:00Z', end: '2026-10-13T10:45:00Z' }),
    event({ applicationId: 'adobe-photoshop', kind: 'idle', start: '2026-10-13T10:45:00Z', end: '2026-10-13T10:50:00Z' }),
    event({ applicationId: 'blender', start: '2026-10-13T11:00:00Z', end: '2026-10-13T11:20:00Z' }),
    event({ applicationId: 'adobe-after-effects', kind: 'idle', start: '2026-10-13T11:20:00Z', end: '2026-10-13T11:30:00Z' }),
  ];
  const summary = summarize(events, { range: TODAY_UTC, applications: APPS });

  it('totals each application separately and sorts by active time, then name', () => {
    expect(
      summary.byApplication.map(({ applicationId, foregroundMs, activeMs, idleMs }) => [
        applicationId,
        foregroundMs / MINUTE,
        activeMs / MINUTE,
        idleMs / MINUTE,
      ]),
    ).toEqual([
      ['figma', 60, 60, 0],
      ['adobe-photoshop', 50, 45, 5],
      ['blender', 20, 20, 0],
      ['adobe-after-effects', 10, 0, 10],
    ]);
    expect(summary.totals).toEqual({ foregroundMs: 140 * MINUTE, activeMs: 125 * MINUTE, idleMs: 15 * MINUTE });
  });

  it('uses the registry names and categories', () => {
    expect(summary.byApplication.map((row) => [row.name, row.category])).toEqual([
      ['Figma', 'design'],
      ['Adobe Photoshop', 'design'],
      ['Blender', '3d'],
      ['Adobe After Effects', 'motion'],
    ]);
  });

  it('activeShare is each app’s fraction of total active time and sums to 1', () => {
    const shares = summary.byApplication.map((row) => row.activeShare);
    expect(shares[0]).toBeCloseTo(60 / 125, 12);
    expect(shares[3]).toBe(0);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(summary.byCategory.reduce((sum, row) => sum + row.activeShare, 0)).toBeCloseTo(1, 12);
  });

  it('groups categories, sorted by active time', () => {
    expect(summary.byCategory.map(({ category, activeMs, idleMs }) => [category, activeMs / MINUTE, idleMs / MINUTE])).toEqual([
      ['design', 105, 5],
      ['3d', 20, 0],
      ['motion', 0, 10],
    ]);
  });

  it('builds a chronological timeline and reconciles', () => {
    expect(summary.timeline.map((segment) => segment.applicationId)).toEqual([
      'figma',
      'adobe-photoshop',
      'figma',
      'adobe-photoshop',
      'blender',
      'adobe-after-effects',
    ]);
    expect(summary.timeline[3]).toMatchObject({ kind: 'idle', open: false });
    expectReconciled(summary);
  });

  it('breaks ties in active time by name', () => {
    const tied = summarize(
      [
        event({ applicationId: 'figma', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:30:00Z' }),
        event({ applicationId: 'blender', start: '2026-10-13T09:30:00Z', end: '2026-10-13T10:00:00Z' }),
        event({ applicationId: 'adobe-photoshop', start: '2026-10-13T10:00:00Z', end: '2026-10-13T10:30:00Z' }),
        event({ applicationId: 'blender', kind: 'idle', start: '2026-10-13T10:30:00Z', end: '2026-10-13T11:30:00Z' }),
      ],
      { range: TODAY_UTC, applications: APPS },
    );
    expect(tied.byApplication.map((row) => row.name)).toEqual(['Adobe Photoshop', 'Blender', 'Figma']);
  });
});

describe('summarize: data hygiene', () => {
  it('counts an interval reported twice (same id, different revisions) once', () => {
    const checkpoint = event({ id: 'live', revision: 4, state: 'open', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:45:00Z' });
    const closed = event({ id: 'live', revision: 5, state: 'closed', start: '2026-10-13T09:00:00Z', end: '2026-10-13T10:00:00Z' });
    const summary = summarize([checkpoint, closed, checkpoint], { range: TODAY_UTC, applications: APPS });
    expect(summary.totals.foregroundMs).toBe(HOUR);
    expect(summary.intervalCount).toBe(1);
    expect(summary.timeline).toEqual([
      { id: 'live', applicationId: 'figma', kind: 'active', startMs: at('2026-10-13T09:00:00Z'), endMs: at('2026-10-13T10:00:00Z'), open: false },
    ]);
  });

  it('counts overlapping intervals on one device once and reports the clipped time', () => {
    const summary = summarize(
      [
        event({ id: 'a', applicationId: 'figma', start: '2026-10-13T09:00:00Z', end: '2026-10-13T10:00:00Z' }),
        event({ id: 'b', applicationId: 'blender', start: '2026-10-13T09:40:00Z', end: '2026-10-13T10:30:00Z' }),
      ],
      { range: TODAY_UTC, applications: APPS },
    );
    expect(summary.totals.foregroundMs).toBe(90 * MINUTE);
    expect(summary.overlapClippedMs).toBe(20 * MINUTE);
    expect(summary.byApplication.find((row) => row.applicationId === 'blender')!.activeMs).toBe(30 * MINUTE);
    expectReconciled(summary);
  });

  it('reports only the overlap that falls inside the range', () => {
    const summary = summarize(
      [
        // Overlap entirely on 12 Oct (outside today's range): not this report's concern.
        event({ id: 'y1', applicationId: 'figma', start: '2026-10-12T09:00:00Z', end: '2026-10-12T10:00:00Z' }),
        event({ id: 'y2', applicationId: 'blender', start: '2026-10-12T09:30:00Z', end: '2026-10-12T10:30:00Z' }),
        // Straddles midnight: 'inner' is fully covered by 'outer'; 30 of its 60 min fall inside today.
        event({ id: 'outer', applicationId: 'figma', start: '2026-10-12T23:00:00Z', end: '2026-10-13T01:00:00Z' }),
        event({ id: 'inner', applicationId: 'blender', start: '2026-10-12T23:30:00Z', end: '2026-10-13T00:30:00Z' }),
      ],
      { range: TODAY_UTC, applications: APPS },
    );
    expect(summary.overlapClippedMs).toBe(30 * MINUTE);
    expect(summary.totals.foregroundMs).toBe(HOUR); // 'outer' from 00:00 to 01:00 only
    expect(summary.byApplication.map((row) => row.applicationId)).toEqual(['figma']);
    expectReconciled(summary);
  });

  it('raw in-range time minus overlapClippedMs equals the counted time', () => {
    const events = [
      event({ id: 'a', applicationId: 'figma', start: '2026-10-13T08:00:00Z', end: '2026-10-13T09:00:00Z' }),
      event({ id: 'b', applicationId: 'blender', kind: 'idle', start: '2026-10-13T08:45:00Z', end: '2026-10-13T09:20:00Z' }),
      event({ id: 'c', applicationId: 'adobe-photoshop', start: '2026-10-13T09:10:00Z', end: '2026-10-13T09:15:00Z' }),
    ];
    const summary = summarize(events, { range: TODAY_UTC, applications: APPS });
    const raw = events.reduce((sum, item) => sum + Date.parse(item.endedAt) - Date.parse(item.startedAt), 0);
    expect(summary.overlapClippedMs).toBe(15 * MINUTE + 5 * MINUTE);
    expect(raw - summary.overlapClippedMs).toBe(summary.totals.foregroundMs);
    expectReconciled(summary);
  });

  it('does not clip overlapping intervals recorded on two different devices', () => {
    const summary = summarize(
      [
        event({ id: 'a', deviceId: 'desktop', applicationId: 'figma', start: '2026-10-13T09:00:00Z', end: '2026-10-13T10:00:00Z' }),
        event({ id: 'b', deviceId: 'laptop', applicationId: 'blender', start: '2026-10-13T09:40:00Z', end: '2026-10-13T10:30:00Z' }),
      ],
      { range: TODAY_UTC, applications: APPS },
    );
    expect(summary.totals.foregroundMs).toBe(110 * MINUTE);
    expect(summary.overlapClippedMs).toBe(0);
    expectReconciled(summary);
  });

  it('includes the open (in-progress) interval and flags it in the timeline', () => {
    const summary = summarize(
      [
        event({ applicationId: 'figma', start: '2026-10-13T16:00:00Z', end: '2026-10-13T17:00:00Z' }),
        event({ applicationId: 'blender', state: 'open', endReason: null, start: '2026-10-13T17:00:00Z', end: '2026-10-13T17:59:30Z' }),
      ],
      { range: TODAY_UTC, applications: APPS },
    );
    expect(summary.totals.activeMs).toBe(HOUR + 59.5 * MINUTE);
    expect(summary.timeline.map((segment) => segment.open)).toEqual([false, true]);
  });

  it('ignores malformed records instead of failing the report', () => {
    const summary = summarize(
      [
        event({ applicationId: 'figma', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:30:00Z' }),
        event({ applicationId: 'figma', start: 'garbage', end: '2026-10-13T09:30:00Z' }),
        event({ applicationId: 'figma', start: '2026-10-13T11:00:00Z', end: '2026-10-13T10:00:00Z' }),
      ],
      { range: TODAY_UTC, applications: APPS },
    );
    expect(summary.totals.foregroundMs).toBe(30 * MINUTE);
    expect(summary.intervalCount).toBe(1);
  });
});

describe('summarize: report exclusion and unknown applications', () => {
  const events = [
    event({ applicationId: 'figma', start: '2026-10-13T09:00:00Z', end: '2026-10-13T10:00:00Z' }),
    event({ applicationId: 'vscode', applicationName: 'Visual Studio Code', start: '2026-10-13T10:00:00Z', end: '2026-10-13T10:30:00Z' }),
  ];

  it('hides applications excluded from reports from every total and list', () => {
    const summary = summarize(events, { range: TODAY_UTC, applications: APPS });
    expect(summary.totals.foregroundMs).toBe(HOUR);
    expect(summary.byApplication.map((row) => row.applicationId)).toEqual(['figma']);
    expect(summary.byCategory.map((row) => row.category)).toEqual(['design']);
    expect(summary.byDay[0]!.activeByApplication).toEqual({ figma: HOUR });
    expect(summary.timeline.map((segment) => segment.applicationId)).toEqual(['figma']);
    expect(summary.intervalCount).toBe(1);
    expect(summary.excludedApplicationIds).toEqual(['vscode']);
    expectReconciled(summary);
  });

  it('shows them when includeExcluded is set', () => {
    const summary = summarize(events, { range: TODAY_UTC, applications: APPS, includeExcluded: true });
    expect(summary.totals.foregroundMs).toBe(90 * MINUTE);
    expect(summary.byApplication.map((row) => row.applicationId)).toEqual(['figma', 'vscode']);
    expect(summary.excludedApplicationIds).toEqual([]);
    expectReconciled(summary);
  });

  it('lists an excluded application only when it had time inside the range', () => {
    const summary = summarize(
      [
        events[0]!,
        event({ applicationId: 'vscode', start: '2026-10-12T10:00:00Z', end: '2026-10-12T10:30:00Z' }), // yesterday
      ],
      { range: TODAY_UTC, applications: APPS },
    );
    expect(summary.excludedApplicationIds).toEqual([]);
  });

  it('keeps time from a deleted application under its recorded name in category "other"', () => {
    const summary = summarize(
      [
        event({ applicationId: 'custom-sketchup', applicationName: 'SketchUp', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:40:00Z' }),
        event({ applicationId: 'figma', start: '2026-10-13T10:00:00Z', end: '2026-10-13T10:30:00Z' }),
      ],
      { range: TODAY_UTC, applications: APPS },
    );
    expect(summary.byApplication[0]).toMatchObject({
      applicationId: 'custom-sketchup',
      name: 'SketchUp',
      category: 'other',
      activeMs: 40 * MINUTE,
    });
    expect(summary.byCategory.map((row) => row.category)).toEqual(['other', 'design']);
    expectReconciled(summary);
  });

  it('shows the current registry name for a renamed application', () => {
    const summary = summarize(
      [event({ applicationId: 'figma', applicationName: 'Figma (old name)', start: '2026-10-13T09:00:00Z', end: '2026-10-13T09:10:00Z' })],
      { range: TODAY_UTC, applications: [application('figma', 'Figma Design', 'design')] },
    );
    expect(summary.byApplication[0]!.name).toBe('Figma Design');
  });
});

describe('summarize: per-day, per-week and per-project breakdowns', () => {
  it('byDay has one entry per range day, including empty days', () => {
    const range = resolveRange('last7', { now: NOW, timeZone: 'UTC' });
    const summary = summarize(
      [
        event({ applicationId: 'figma', start: '2026-10-08T09:00:00Z', end: '2026-10-08T10:00:00Z' }),
        event({ applicationId: 'blender', start: '2026-10-08T10:00:00Z', end: '2026-10-08T10:30:00Z' }),
        event({ applicationId: 'blender', kind: 'idle', start: '2026-10-12T13:00:00Z', end: '2026-10-12T13:10:00Z' }),
      ],
      { range, applications: APPS },
    );
    expect(summary.byDay.map((day) => day.day)).toEqual(range.days);
    expect(summary.byDay.map((day) => day.foregroundMs / MINUTE)).toEqual([0, 90, 0, 0, 0, 10, 0]);
    expect(summary.byDay[1]!.activeByApplication).toEqual({ figma: HOUR, blender: 30 * MINUTE });
    expect(summary.byDay[5]!.activeByApplication).toEqual({}); // idle-only day: no active time
    expect(summary.byDay[0]).toEqual({ day: '2026-10-07', foregroundMs: 0, activeMs: 0, idleMs: 0, activeByApplication: {} });
    expectReconciled(summary);
  });

  it('an interval spanning local midnight is split across days in the report zone', () => {
    const range = resolveRange('last7', { now: NOW, timeZone: 'America/New_York' });
    // 23:00 → 01:00 EDT on the night of 11/12 October.
    const summary = summarize(
      [event({ applicationId: 'blender', start: '2026-10-12T03:00:00Z', end: '2026-10-12T05:00:00Z' })],
      { range, applications: APPS },
    );
    const byDay = Object.fromEntries(summary.byDay.map((day) => [day.day, day.activeMs / MINUTE]));
    expect(byDay['2026-10-11']).toBe(60);
    expect(byDay['2026-10-12']).toBe(60);
    expect(summary.timeline).toHaveLength(1); // the timeline keeps the interval whole
    expectReconciled(summary);
  });

  it('byWeek uses local ISO weeks (Monday start) and only weeks that intersect the range', () => {
    // Saturday 3 Oct → Tuesday 13 Oct 2026, New York time.
    const range = resolveRange('custom', {
      now: NOW,
      timeZone: 'America/New_York',
      customStart: '2026-10-03',
      customEnd: '2026-10-13',
    });
    const summary = summarize(
      [
        // Sunday 11 Oct 23:30 → Monday 12 Oct 00:30 EDT: 30 min in each ISO week.
        event({ applicationId: 'figma', start: '2026-10-12T03:30:00Z', end: '2026-10-12T04:30:00Z' }),
        // Saturday 3 Oct 10:00 EDT.
        event({ applicationId: 'blender', start: '2026-10-03T14:00:00Z', end: '2026-10-03T14:20:00Z' }),
        // Monday 12 Oct 02:00 UTC is still Sunday 11 Oct in New York.
        event({ applicationId: 'blender', start: '2026-10-12T02:00:00Z', end: '2026-10-12T02:10:00Z' }),
      ],
      { range, applications: APPS },
    );
    expect(summary.byWeek.map((week) => [week.weekStart, week.activeMs / MINUTE])).toEqual([
      ['2026-09-28', 20],
      ['2026-10-05', 40],
      ['2026-10-12', 30],
    ]);
    expectReconciled(summary);
  });

  it('byWeek is a single zero week for an empty single-day range', () => {
    const summary = summarize([], { range: TODAY_UTC, applications: APPS });
    expect(summary.byWeek).toEqual([{ weekStart: '2026-10-12', foregroundMs: 0, activeMs: 0, idleMs: 0 }]);
  });

  it('byProject groups by projectId with null for unassigned time', () => {
    const summary = summarize(
      [
        event({ applicationId: 'figma', projectId: 'brand-refresh', start: '2026-10-13T09:00:00Z', end: '2026-10-13T10:00:00Z' }),
        event({ applicationId: 'blender', projectId: null, start: '2026-10-13T10:00:00Z', end: '2026-10-13T10:20:00Z' }),
        event({ applicationId: 'blender', projectId: null, kind: 'idle', start: '2026-10-13T10:20:00Z', end: '2026-10-13T10:30:00Z' }),
        event({ applicationId: 'adobe-photoshop', projectId: 'kiosk', start: '2026-10-13T10:30:00Z', end: '2026-10-13T11:15:00Z' }),
      ],
      { range: TODAY_UTC, applications: APPS },
    );
    expect(summary.byProject.map(({ projectId, activeMs, idleMs }) => [projectId, activeMs / MINUTE, idleMs / MINUTE])).toEqual([
      ['brand-refresh', 60, 0],
      ['kiosk', 45, 0],
      [null, 20, 10],
    ]);
    expectReconciled(summary);
  });

  it('an empty report has zero totals and empty lists', () => {
    const summary = summarize([], { range: TODAY_UTC, applications: APPS });
    expect(summary.totals).toEqual({ foregroundMs: 0, activeMs: 0, idleMs: 0 });
    expect(summary.byApplication).toEqual([]);
    expect(summary.byCategory).toEqual([]);
    expect(summary.byProject).toEqual([]);
    expect(summary.timeline).toEqual([]);
    expect(summary.byDay).toHaveLength(1);
    expect(summary.intervalCount).toBe(0);
    expect(summary.range).toBe(TODAY_UTC);
  });
});

describe('summarize: clipping at range edges', () => {
  it('clips intervals that start before or end after the range', () => {
    const range = resolveRange('yesterday', { now: NOW, timeZone: 'UTC' }); // 12 Oct
    const summary = summarize(
      [
        event({ id: 'before', applicationId: 'figma', start: '2026-10-11T23:00:00Z', end: '2026-10-12T01:00:00Z' }),
        event({ id: 'inside', applicationId: 'blender', start: '2026-10-12T12:00:00Z', end: '2026-10-12T12:30:00Z' }),
        event({ id: 'after', applicationId: 'adobe-photoshop', state: 'open', start: '2026-10-12T23:30:00Z', end: '2026-10-13T00:15:00Z' }),
        event({ id: 'outside', applicationId: 'figma', start: '2026-10-13T09:00:00Z', end: '2026-10-13T10:00:00Z' }),
      ],
      { range, applications: APPS },
    );
    expect(summary.timeline).toEqual([
      { id: 'before', applicationId: 'figma', kind: 'active', startMs: range.startMs, endMs: at('2026-10-12T01:00:00Z'), open: false },
      { id: 'inside', applicationId: 'blender', kind: 'active', startMs: at('2026-10-12T12:00:00Z'), endMs: at('2026-10-12T12:30:00Z'), open: false },
      // Its live edge lies beyond the range, so the clipped piece is not "open".
      { id: 'after', applicationId: 'adobe-photoshop', kind: 'active', startMs: at('2026-10-12T23:30:00Z'), endMs: range.endMs, open: false },
    ]);
    expect(summary.totals.activeMs).toBe(2 * HOUR);
    expect(summary.intervalCount).toBe(3);
    expectReconciled(summary);
  });

  it('respects 23 h DST days in the report zone', () => {
    const range = resolveRange('today', { now: at('2026-03-08T20:00:00Z'), timeZone: 'America/New_York' });
    const summary = summarize(
      [event({ applicationId: 'blender', kind: 'idle', start: '2026-03-07T12:00:00Z', end: '2026-03-09T12:00:00Z' })],
      { range, applications: APPS },
    );
    expect(summary.totals).toEqual({ foregroundMs: 23 * HOUR, activeMs: 0, idleMs: 23 * HOUR });
    expect(summary.byDay).toEqual([
      { day: '2026-03-08', foregroundMs: 23 * HOUR, activeMs: 0, idleMs: 23 * HOUR, activeByApplication: {} },
    ]);
  });

  it('assigns early-morning UTC work to the right local day in Asia/Kolkata', () => {
    const range = resolveRange('today', { now: at('2026-10-13T06:00:00Z'), timeZone: 'Asia/Kolkata' });
    const summary = summarize(
      [
        event({ applicationId: 'figma', start: '2026-10-12T18:00:00Z', end: '2026-10-12T19:00:00Z' }), // 23:30 → 00:30 IST
      ],
      { range, applications: APPS },
    );
    expect(summary.totals.activeMs).toBe(30 * MINUTE);
    expect(summary.byDay[0]).toMatchObject({ day: '2026-10-13', activeMs: 30 * MINUTE });
  });
});
