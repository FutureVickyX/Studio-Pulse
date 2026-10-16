/**
 * Property-style checks with a seeded generator: messy input (duplicates, stale revisions, overlaps
 * on one device, a second device, malformed rows, deleted and excluded applications, intervals that
 * cross range edges and DST days) in many time zones and ranges. Whatever the input, every figure in
 * a summary must be derived from the same intervals and reconcile exactly.
 *
 * The generator is deterministic (fixed seeds), so a failure is reproducible: the case index and
 * seed are part of each assertion message.
 */

import { describe, expect, it } from 'vitest';

import type { TrackingEvent } from '@studio-pulse/shared-types';
import {
  localDayKey,
  normalizeEvents,
  resolveRange,
  splitByLocalDay,
  summarize,
} from '@studio-pulse/time-engine';
import type { DateRange, RangePreset, UsageSummary } from '@studio-pulse/time-engine';

import { DAY, HOUR, MINUTE, SECOND, application, iso, sumTotals } from './builders';

const ZONES = [
  'UTC',
  'America/New_York',
  'Europe/London',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'America/Santiago',
  'Pacific/Chatham',
] as const;

const APPS = [
  application('figma', 'Figma', 'design'),
  application('adobe-photoshop', 'Adobe Photoshop', 'photo'),
  application('adobe-after-effects', 'Adobe After Effects', 'motion'),
  application('blender', 'Blender', '3d'),
  application('vscode', 'Visual Studio Code', 'code', { includeInReports: false }),
];
/** Ids that may appear in records: the registry plus a deleted custom application. */
const RECORDED_APP_IDS = [...APPS.map((app) => app.id), 'custom-deleted'];
const EXCLUDED_IDS = new Set(APPS.filter((app) => !app.includeInReports).map((app) => app.id));

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

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('empty list');
  return item;
}

function int(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** A DST-heavy window: March to early November 2026. */
const WINDOW_START = Date.parse('2026-03-01T00:00:00Z');
const WINDOW_DAYS = 250;

function randomRange(random: () => number, timeZone: string): DateRange {
  const now = WINDOW_START + int(random, 40, WINDOW_DAYS) * DAY + int(random, 0, DAY - 1);
  const preset = pick<RangePreset>(random, ['today', 'yesterday', 'last7', 'last30', 'custom']);
  if (preset !== 'custom') return resolveRange(preset, { now, timeZone });
  const end = localDayKey(now, timeZone);
  const start = localDayKey(now - int(random, 0, 20) * DAY, timeZone);
  return resolveRange('custom', { now, timeZone, customStart: start, customEnd: end });
}

function randomEvents(random: () => number, range: DateRange): TrackingEvent[] {
  const events: TrackingEvent[] = [];
  const count = int(random, 0, 40);
  for (let index = 0; index < count; index += 1) {
    // Starts from two days before the range to one day after it.
    const span = range.endMs - range.startMs + 3 * DAY;
    const startMs = range.startMs - 2 * DAY + Math.floor(random() * span);
    const durationMs = pick(random, [SECOND, 37 * SECOND, 5 * MINUTE, 47 * MINUTE, 3 * HOUR, 26 * HOUR]) + int(random, 0, 999);
    const kind = random() < 0.7 ? 'active' : 'idle';
    const seconds = durationMs / 1000;
    const base: TrackingEvent = {
      id: `e${index}`,
      userId: null,
      deviceId: random() < 0.8 ? 'desk' : 'laptop',
      applicationId: pick(random, RECORDED_APP_IDS),
      applicationName: 'Recorded name',
      kind,
      startedAt: iso(startMs),
      endedAt: iso(startMs + durationMs),
      durationSeconds: seconds,
      activeSeconds: kind === 'active' ? seconds : 0,
      idleSeconds: kind === 'idle' ? seconds : 0,
      projectId: pick(random, [null, null, 'p1', 'p2']),
      taskId: null,
      source: 'automatic',
      syncStatus: 'pending',
      state: random() < 0.1 ? 'open' : 'closed',
      endReason: null,
      revision: int(random, 1, 5),
    };
    events.push(base);

    const roll = random();
    if (roll < 0.15) {
      // A stale checkpoint of the same interval (lower revision, ended earlier).
      events.push({ ...base, revision: base.revision - 1, endedAt: iso(startMs + Math.floor(durationMs / 2)), state: 'open' });
    } else if (roll < 0.25) {
      // The exact same row delivered twice.
      events.push({ ...base });
    } else if (roll < 0.3) {
      // Malformed rows that must be ignored.
      events.push({ ...base, id: `${base.id}-bad`, endedAt: iso(startMs - MINUTE) });
      events.push({ ...base, id: `${base.id}-nan`, startedAt: 'not-a-date' });
    }
  }
  // Shuffle: the order in which records arrive must not matter.
  for (let index = events.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [events[index], events[other]] = [events[other]!, events[index]!];
  }
  return events;
}

function inRangeMs(startMs: number, endMs: number, range: DateRange): number {
  return Math.max(0, Math.min(endMs, range.endMs) - Math.max(startMs, range.startMs));
}

function expectReconciled(summary: UsageSummary, label: string): void {
  const { totals, range } = summary;
  expect(totals.foregroundMs, label).toBe(totals.activeMs + totals.idleMs);
  for (const value of Object.values(totals)) {
    expect(Number.isInteger(value) && value >= 0, label).toBe(true);
  }
  expect(sumTotals(summary.byApplication), label).toEqual(totals);
  expect(sumTotals(summary.byCategory), label).toEqual(totals);
  expect(sumTotals(summary.byDay), label).toEqual(totals);
  expect(sumTotals(summary.byWeek), label).toEqual(totals);
  expect(sumTotals(summary.byProject), label).toEqual(totals);

  const timelineMs = (kind?: 'active' | 'idle') =>
    summary.timeline
      .filter((segment) => kind === undefined || segment.kind === kind)
      .reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);
  expect(timelineMs(), label).toBe(totals.foregroundMs);
  expect(timelineMs('active'), label).toBe(totals.activeMs);
  expect(timelineMs('idle'), label).toBe(totals.idleMs);
  expect(summary.timeline.length, label).toBe(summary.intervalCount);
  for (let index = 0; index < summary.timeline.length; index += 1) {
    const segment = summary.timeline[index]!;
    expect(segment.startMs >= range.startMs && segment.endMs <= range.endMs && segment.endMs > segment.startMs, label).toBe(true);
    if (index > 0) expect(summary.timeline[index - 1]!.startMs <= segment.startMs, label).toBe(true);
  }

  expect(summary.byDay.map((entry) => entry.day), label).toEqual(range.days);
  for (const entry of summary.byDay) {
    const perApp = Object.values(entry.activeByApplication).reduce((sum, ms) => sum + ms, 0);
    expect(perApp, label).toBe(entry.activeMs);
  }
  for (const app of summary.byApplication) {
    const acrossDays = summary.byDay.reduce((sum, entry) => sum + (entry.activeByApplication[app.applicationId] ?? 0), 0);
    expect(acrossDays, label).toBe(app.activeMs);
  }

  for (let index = 1; index < summary.byApplication.length; index += 1) {
    expect(summary.byApplication[index - 1]!.activeMs >= summary.byApplication[index]!.activeMs, label).toBe(true);
  }
  if (totals.activeMs > 0) {
    expect(summary.byApplication.reduce((sum, app) => sum + app.activeShare, 0), label).toBeCloseTo(1, 9);
    expect(summary.byCategory.reduce((sum, category) => sum + category.activeShare, 0), label).toBeCloseTo(1, 9);
  } else {
    expect(summary.byApplication.every((app) => app.activeShare === 0), label).toBe(true);
  }

  for (const week of summary.byWeek) {
    expect(new Date(`${week.weekStart}T12:00:00Z`).getUTCDay(), label).toBe(1); // Monday
  }
}

describe('summarize: reconciliation on generated messy input', () => {
  const CASES = 150;

  it(`holds every invariant across ${CASES} seeded cases`, () => {
    // How often the generator hit each interesting situation (so the test cannot pass vacuously).
    const seen = { withTime: 0, overlap: 0, excluded: 0, deleted: 0, open: 0, multiDay: 0, idle: 0 };
    for (let index = 0; index < CASES; index += 1) {
      const seed = 0x5eed + index * 7919;
      const random = rng(seed);
      const timeZone = pick(random, ZONES);
      const range = randomRange(random, timeZone);
      const events = randomEvents(random, range);
      const label = `case ${index} (seed ${seed}, ${timeZone}, ${range.preset} ${range.days[0]}…${range.days.at(-1)})`;

      const visible = summarize(events, { range, applications: APPS });
      const everything = summarize(events, { range, applications: APPS, includeExcluded: true });
      expectReconciled(visible, label);
      expectReconciled(everything, label);

      // Exclusion only removes the excluded applications' time.
      const excludedMs = everything.byApplication
        .filter((app) => EXCLUDED_IDS.has(app.applicationId))
        .reduce((sum, app) => sum + app.foregroundMs, 0);
      expect(visible.totals.foregroundMs + excludedMs, label).toBe(everything.totals.foregroundMs);
      expect(visible.byApplication.some((app) => EXCLUDED_IDS.has(app.applicationId)), label).toBe(false);
      expect(
        visible.excludedApplicationIds,
        label,
      ).toEqual(everything.byApplication.filter((app) => EXCLUDED_IDS.has(app.applicationId)).map((app) => app.applicationId).sort());
      expect(everything.excludedApplicationIds, label).toEqual([]);

      // Unknown (deleted) applications fall back to the recorded name in category "other".
      for (const app of everything.byApplication.filter((row) => row.applicationId === 'custom-deleted')) {
        expect(app, label).toMatchObject({ name: 'Recorded name', category: 'other' });
      }

      // Every instant on a device is counted once, and the de-duplicated raw time inside the range
      // minus the reported overlap is exactly what was counted.
      const normalized = normalizeEvents(events);
      const raw = normalized.reduce((sum, item) => sum + inRangeMs(item.startMs, item.endMs, range), 0);
      expect(raw - everything.overlapClippedMs, label).toBe(everything.totals.foregroundMs);
      expect(everything.overlapClippedMs, label).toBe(visible.overlapClippedMs);
      const deviceOf = new Map(normalized.map((item) => [item.id, item.deviceId]));
      const lastEnd = new Map<string, number>();
      for (const segment of everything.timeline) {
        const device = deviceOf.get(segment.id)!;
        expect(segment.startMs >= (lastEnd.get(device) ?? Number.NEGATIVE_INFINITY), label).toBe(true);
        lastEnd.set(device, segment.endMs);
      }

      // Arrival order does not matter.
      expect(summarize([...events].reverse(), { range, applications: APPS }), label).toEqual(visible);

      if (everything.totals.foregroundMs > 0) seen.withTime += 1;
      if (everything.overlapClippedMs > 0) seen.overlap += 1;
      if (visible.excludedApplicationIds.length > 0) seen.excluded += 1;
      if (everything.byApplication.some((app) => app.applicationId === 'custom-deleted')) seen.deleted += 1;
      if (everything.timeline.some((segment) => segment.open)) seen.open += 1;
      if (everything.byDay.filter((entry) => entry.foregroundMs > 0).length > 1) seen.multiDay += 1;
      if (everything.totals.idleMs > 0) seen.idle += 1;
    }
    for (const [situation, count] of Object.entries(seen)) {
      expect(count, `generated cases with ${situation}`).toBeGreaterThanOrEqual(10);
    }
  });
});

describe('splitByLocalDay: generated intervals in DST and fractional-offset zones', () => {
  it('pieces lie inside their local day, are contiguous, and sum exactly to the interval', () => {
    const random = rng(20261014);
    for (let index = 0; index < 300; index += 1) {
      const timeZone = pick(random, ZONES);
      const startMs = WINDOW_START + Math.floor(random() * WINDOW_DAYS * DAY);
      const durationMs = int(random, 1, 4 * DAY);
      const activeMs = random() < 0.5 ? durationMs : 0;
      const label = `#${index} ${timeZone} ${iso(startMs)} +${durationMs}ms`;
      const pieces = splitByLocalDay(
        [
          {
            id: `i${index}`,
            deviceId: 'desk',
            applicationId: 'figma',
            applicationName: 'Figma',
            kind: activeMs > 0 ? 'active' : 'idle',
            startMs,
            endMs: startMs + durationMs,
            activeMs,
            idleMs: durationMs - activeMs,
            projectId: null,
            taskId: null,
            source: 'automatic',
            open: false,
          },
        ],
        timeZone,
      );

      expect(pieces.length, label).toBeGreaterThan(0);
      expect(pieces[0]!.interval.startMs, label).toBe(startMs);
      expect(pieces.at(-1)!.interval.endMs, label).toBe(startMs + durationMs);
      let cursor = startMs;
      let active = 0;
      let idle = 0;
      for (const { day, interval } of pieces) {
        expect(interval.startMs, label).toBe(cursor);
        expect(localDayKey(interval.startMs, timeZone), label).toBe(day);
        expect(localDayKey(interval.endMs - 1, timeZone), label).toBe(day);
        expect(interval.activeMs + interval.idleMs, label).toBe(interval.endMs - interval.startMs);
        cursor = interval.endMs;
        active += interval.activeMs;
        idle += interval.idleMs;
      }
      expect([active, idle], label).toEqual([activeMs, durationMs - activeMs]);
      const days = pieces.map((piece) => piece.day);
      expect(new Set(days).size, label).toBe(days.length);
    }
  });
});
