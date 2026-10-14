/**
 * Cross-package: a realistic multi-app working day of TrackingEvent records goes through
 * @studio-pulse/validation (registry, custom app, settings, custom range) and is summarized by
 * @studio-pulse/time-engine. Every figure must reconcile exactly with every other figure and with
 * the hand-computed minutes of the script below: all totals are calculated from the underlying
 * records, nothing else.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '@studio-pulse/shared-types';
import type { ApplicationDefinition, ApplicationInput, Settings } from '@studio-pulse/shared-types';
import defaultApplicationsJson from '@studio-pulse/shared-types/default-applications.json';
import { formatDuration, formatShare, resolveRange, summarize } from '@studio-pulse/time-engine';
import type { DateRange, UsageSummary } from '@studio-pulse/time-engine';
import {
  APPLICATION_ID_PATTERN,
  validateApplicationInput,
  validateCustomRange,
  validateDefaultApplications,
  validateSettings,
} from '@studio-pulse/validation';

import { TrackingDayBuilder } from './support/tracking-day';
import type { AppRef } from './support/tracking-day';

const MINUTE = 60_000;
const TIME_ZONE = 'Europe/London'; // BST (UTC+1) throughout this scenario
/** Tuesday 13 October 2026, 10:20 in London: the Photoshop interval is still being recorded. */
const NOW = Date.parse('2026-10-13T09:20:00Z');
const CREATED_AT = '2026-10-01T08:00:00.000Z';

// ---------------------------------------------------------------------------------------------
// Inputs, validated the way the UI and the Rust core validate them
// ---------------------------------------------------------------------------------------------

function unwrap<T>(result: { ok: true; value: T } | { ok: false; issues: string[] }): T {
  if (!result.ok) throw new Error(`validation failed: ${result.issues.join('; ')}`);
  return result.value;
}

/** The registry as seeded on first run, after the user's edits in Settings → Applications. */
function buildRegistry(): ApplicationDefinition[] {
  const defaults = unwrap(validateDefaultApplications(defaultApplicationsJson));
  const registry: ApplicationDefinition[] = defaults.applications.map((app, index) => ({
    id: app.id,
    displayName: app.displayName,
    category: app.category,
    matchers: app.matchers,
    enabled: app.enabledByDefault,
    includeInReports: true,
    builtIn: true,
    sortOrder: index,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }));

  // Edit: VS Code is tracked but kept out of reports.
  const vscode = registry.find((app) => app.id === 'vscode')!;
  const vscodeEdit: ApplicationInput = unwrap(
    validateApplicationInput({
      id: vscode.id,
      displayName: vscode.displayName,
      category: vscode.category,
      matchers: vscode.matchers,
      enabled: true,
      includeInReports: false,
    }),
  );
  Object.assign(vscode, { enabled: vscodeEdit.enabled, includeInReports: vscodeEdit.includeInReports });

  // A custom application added by the user (the Rust core assigns the `custom-…` id).
  const sketchup = unwrap(
    validateApplicationInput({
      id: null,
      displayName: '  SketchUp  ',
      category: '3d',
      matchers: [{ exe: 'SketchUp.exe' }],
      enabled: true,
      includeInReports: true,
    }),
  );
  registry.push({
    ...sketchup,
    id: 'custom-sketchup',
    builtIn: false,
    sortOrder: registry.length,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  // `custom-old-tool` ("Old Tool") existed when the records below were made and was deleted since.
  return registry;
}

const SETTINGS: Settings = unwrap(
  validateSettings({ ...DEFAULT_SETTINGS, onboarding: { completed: true, completedAt: '2026-10-01T08:05:00.000Z' } }),
);

const APPLICATIONS = buildRegistry();

// ---------------------------------------------------------------------------------------------
// The recorded day
// ---------------------------------------------------------------------------------------------

const FIGMA: AppRef = { id: 'figma', name: 'Figma' };
const PHOTOSHOP: AppRef = { id: 'adobe-photoshop', name: 'Adobe Photoshop' };
const AFTER_EFFECTS: AppRef = { id: 'adobe-after-effects', name: 'Adobe After Effects' };
const BLENDER: AppRef = { id: 'blender', name: 'Blender' };
const KRITA: AppRef = { id: 'krita', name: 'Krita' };
const VSCODE: AppRef = { id: 'vscode', name: 'Visual Studio Code' };
const SKETCHUP: AppRef = { id: 'custom-sketchup', name: 'SketchUp' };
const OLD_TOOL: AppRef = { id: 'custom-old-tool', name: 'Old Tool' };

const BRAND = { projectId: 'brand-refresh' };
const KIOSK = { projectId: 'kiosk' };

const day = new TrackingDayBuilder({ deviceId: 'desk-01', timeZone: TIME_ZONE })
  // Sunday evening sketch.
  .at('2026-10-11', '20:00')
  .work(KRITA, 45)
  // Monday.
  .at('2026-10-12', '09:00')
  .work(FIGMA, 90, BRAND)
  .idle(FIGMA, 15, BRAND) // coffee, Figma left in front
  .work(FIGMA, 30, BRAND)
  .gap(15) // browser: untracked
  .work(PHOTOSHOP, 60, BRAND)
  .withStaleCheckpoint(30) // the 12:00 checkpoint row of the same interval
  .gap(60) // lunch: screen locked
  .work(AFTER_EFFECTS, 90)
  .idle(AFTER_EFFECTS, 20) // watching a RAM preview
  .work(PHOTOSHOP, 40)
  .work(VSCODE, 30) // excluded from reports
  .work(SKETCHUP, 60, KIOSK)
  .work(OLD_TOOL, 15) // application since deleted
  // Late Blender session that runs past midnight, then a render left on screen.
  .at('2026-10-12', '23:10')
  .work(BLENDER, 90, KIOSK)
  .idle(BLENDER, 15, KIOSK)
  // Tuesday morning.
  .at('2026-10-13', '09:30')
  .work(FIGMA, 30)
  .live(PHOTOSHOP, 20) // open interval, 10:00 → now
  .withStaleCheckpoint(5); // persisted checkpoint next to the live overlay

const EVENTS = day.build();

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

type Minutes = { foreground: number; active: number; idle: number };

function minutes(totals: { foregroundMs: number; activeMs: number; idleMs: number }): Minutes {
  return { foreground: totals.foregroundMs / MINUTE, active: totals.activeMs / MINUTE, idle: totals.idleMs / MINUTE };
}

function sum(rows: ReadonlyArray<{ foregroundMs: number; activeMs: number; idleMs: number }>) {
  return rows.reduce(
    (acc, row) => ({
      foregroundMs: acc.foregroundMs + row.foregroundMs,
      activeMs: acc.activeMs + row.activeMs,
      idleMs: acc.idleMs + row.idleMs,
    }),
    { foregroundMs: 0, activeMs: 0, idleMs: 0 },
  );
}

/** Every breakdown in a summary is derived from the same intervals and adds up exactly. */
function expectReconciled(summary: UsageSummary): void {
  const { totals } = summary;
  expect(totals.foregroundMs).toBe(totals.activeMs + totals.idleMs);
  expect(sum(summary.byApplication)).toEqual(totals);
  expect(sum(summary.byDay)).toEqual(totals);
  expect(sum(summary.byWeek)).toEqual(totals);
  expect(sum(summary.byCategory)).toEqual(totals);
  expect(sum(summary.byProject)).toEqual(totals);

  // The timeline is the clipped intervals themselves.
  const timelineMs = (kind?: 'active' | 'idle') =>
    summary.timeline
      .filter((segment) => kind === undefined || segment.kind === kind)
      .reduce((acc, segment) => acc + segment.endMs - segment.startMs, 0);
  expect(timelineMs()).toBe(totals.foregroundMs);
  expect(timelineMs('active')).toBe(totals.activeMs);
  expect(timelineMs('idle')).toBe(totals.idleMs);
  expect(summary.timeline).toHaveLength(summary.intervalCount);
  for (const segment of summary.timeline) {
    expect(segment.startMs).toBeGreaterThanOrEqual(summary.range.startMs);
    expect(segment.endMs).toBeLessThanOrEqual(summary.range.endMs);
  }

  // Per-day app breakdown adds up to each day and, across days, to each application.
  for (const entry of summary.byDay) {
    expect(Object.values(entry.activeByApplication).reduce((acc, ms) => acc + ms, 0)).toBe(entry.activeMs);
  }
  for (const app of summary.byApplication) {
    const acrossDays = summary.byDay.reduce((acc, entry) => acc + (entry.activeByApplication[app.applicationId] ?? 0), 0);
    expect(acrossDays).toBe(app.activeMs);
  }

  // Shares.
  if (totals.activeMs > 0) {
    expect(summary.byApplication.reduce((acc, app) => acc + app.activeShare, 0)).toBeCloseTo(1, 12);
    expect(summary.byCategory.reduce((acc, category) => acc + category.activeShare, 0)).toBeCloseTo(1, 12);
  }
  expect(summary.byDay.map((entry) => entry.day)).toEqual(summary.range.days);
}

function report(range: DateRange, includeExcluded = false): UsageSummary {
  const summary = summarize(EVENTS, { range, applications: APPLICATIONS, includeExcluded });
  expectReconciled(summary);
  return summary;
}

function appMinutes(summary: UsageSummary): Array<[string, number, number]> {
  return summary.byApplication.map((app) => [app.name, app.activeMs / MINUTE, app.idleMs / MINUTE]);
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('integration: validated inputs', () => {
  it('the registry, the custom app and the settings all validate', () => {
    expect(APPLICATIONS.find((app) => app.id === 'custom-sketchup')).toMatchObject({ displayName: 'SketchUp', category: '3d' });
    expect(APPLICATIONS.find((app) => app.id === 'vscode')).toMatchObject({ enabled: true, includeInReports: false });
    expect(APPLICATIONS.some((app) => app.id === OLD_TOOL.id)).toBe(false);
    for (const app of APPLICATIONS) expect(app.id).toMatch(APPLICATION_ID_PATTERN);
    expect(SETTINGS.onboarding.completed).toBe(true);
  });

  it('the recorded day is plausible for the validated settings', () => {
    const idleThresholdMs = SETTINGS.tracking.idleTimeoutMinutes * MINUTE;
    const minimumMs = SETTINGS.tracking.minimumIntervalSeconds * 1000;
    for (const record of day.intervals()) {
      const duration = Date.parse(record.endedAt) - Date.parse(record.startedAt);
      expect(duration).toBeGreaterThanOrEqual(minimumMs);
      if (record.kind === 'idle') expect(duration).toBeGreaterThanOrEqual(idleThresholdMs);
      expect(record.durationSeconds).toBe(record.activeSeconds + record.idleSeconds);
    }
    // Exactly one open interval on the device.
    expect(day.intervals().filter((record) => record.state === 'open')).toHaveLength(1);
    // The fixture contains duplicate rows (stale checkpoints) that reports must not double count.
    expect(EVENTS.length).toBe(day.intervals().length + 2);
  });
});

describe('integration: today (Tuesday, tracking in progress)', () => {
  const summary = report(resolveRange('today', { now: NOW, timeZone: TIME_ZONE }));

  it('totals the post-midnight Blender tail, Figma and the live Photoshop interval', () => {
    expect(minutes(summary.totals)).toEqual({ foreground: 105, active: 90, idle: 15 });
    expect(appMinutes(summary)).toEqual([
      ['Blender', 40, 15],
      ['Figma', 30, 0],
      ['Adobe Photoshop', 20, 0],
    ]);
    expect(summary.excludedApplicationIds).toEqual([]);
    expect(summary.overlapClippedMs).toBe(0);
  });

  it('clips the timeline at local midnight and flags the live interval', () => {
    expect(summary.timeline[0]).toMatchObject({ applicationId: 'blender', startMs: summary.range.startMs, kind: 'active' });
    expect(summary.range.startMs).toBe(Date.parse('2026-10-12T23:00:00Z')); // 00:00 BST
    const last = summary.timeline.at(-1)!;
    expect(last).toMatchObject({ applicationId: 'adobe-photoshop', open: true, endMs: NOW });
    expect(summary.timeline.filter((segment) => segment.open)).toHaveLength(1);
  });

  it('formats for display', () => {
    expect(formatDuration(summary.totals.activeMs)).toBe('1h 30m');
    expect(formatShare(summary.byApplication[0]!.activeShare)).toBe('44%');
  });
});

describe('integration: yesterday (Monday)', () => {
  const summary = report(resolveRange('yesterday', { now: NOW, timeZone: TIME_ZONE }));

  it('matches the hand-computed minutes for every application', () => {
    expect(appMinutes(summary)).toEqual([
      ['Figma', 120, 15],
      ['Adobe Photoshop', 100, 0],
      ['Adobe After Effects', 90, 20],
      ['SketchUp', 60, 0],
      ['Blender', 50, 0], // 23:10 → midnight only
      ['Old Tool', 15, 0],
    ]);
    expect(minutes(summary.totals)).toEqual({ foreground: 470, active: 435, idle: 35 });
  });

  it('hides VS Code, keeps the deleted app under its recorded name, and counts each interval once', () => {
    expect(summary.excludedApplicationIds).toEqual(['vscode']);
    expect(summary.byApplication.find((app) => app.applicationId === 'custom-old-tool')).toMatchObject({
      name: 'Old Tool',
      category: 'other',
    });
    expect(summary.intervalCount).toBe(10);
    expect(summary.overlapClippedMs).toBe(0);
  });

  it('shows VS Code only when excluded applications are requested', () => {
    const withExcluded = report(resolveRange('yesterday', { now: NOW, timeZone: TIME_ZONE }), true);
    expect(minutes(withExcluded.totals)).toEqual({ foreground: 500, active: 465, idle: 35 });
    expect(withExcluded.byApplication.find((app) => app.applicationId === 'vscode')!.activeMs).toBe(30 * MINUTE);
    expect(withExcluded.excludedApplicationIds).toEqual([]);
  });
});

describe('integration: last 7 days', () => {
  const range = resolveRange('last7', { now: NOW, timeZone: TIME_ZONE });
  const summary = report(range);

  it('totals every application across the week', () => {
    expect(minutes(summary.totals)).toEqual({ foreground: 620, active: 570, idle: 50 });
    expect(appMinutes(summary)).toEqual([
      ['Figma', 150, 15],
      ['Adobe Photoshop', 120, 0],
      ['Adobe After Effects', 90, 20],
      ['Blender', 90, 15],
      ['SketchUp', 60, 0],
      ['Krita', 45, 0],
      ['Old Tool', 15, 0],
    ]);
  });

  it('breaks down by day (including empty days), ISO week, category and project', () => {
    expect(summary.byDay.map((entry) => [entry.day, entry.activeMs / MINUTE, entry.idleMs / MINUTE])).toEqual([
      ['2026-10-07', 0, 0],
      ['2026-10-08', 0, 0],
      ['2026-10-09', 0, 0],
      ['2026-10-10', 0, 0],
      ['2026-10-11', 45, 0],
      ['2026-10-12', 435, 35],
      ['2026-10-13', 90, 15],
    ]);
    expect(summary.byWeek.map((week) => [week.weekStart, week.activeMs / MINUTE, week.idleMs / MINUTE])).toEqual([
      ['2026-10-05', 45, 0],
      ['2026-10-12', 525, 50],
    ]);
    expect(summary.byCategory.map((category) => [category.category, category.activeMs / MINUTE, category.idleMs / MINUTE])).toEqual([
      ['design', 315, 15],
      ['3d', 150, 15],
      ['motion', 90, 20],
      ['other', 15, 0],
    ]);
    expect(summary.byProject.map((project) => [project.projectId, project.activeMs / MINUTE, project.idleMs / MINUTE])).toEqual([
      [null, 240, 20],
      ['brand-refresh', 180, 15],
      ['kiosk', 150, 15],
    ]);
  });

  it('equals the sum of seven single-day reports (no time lost or double counted at day edges)', () => {
    const daily = range.days.map((dayKey) =>
      report(resolveRange('custom', { now: NOW, timeZone: TIME_ZONE, customStart: dayKey, customEnd: dayKey })),
    );
    expect(sum(daily.map((entry) => entry.totals))).toEqual(summary.totals);
    for (const app of summary.byApplication) {
      const perDay = daily.reduce(
        (acc, entry) => acc + (entry.byApplication.find((row) => row.applicationId === app.applicationId)?.activeMs ?? 0),
        0,
      );
      expect(perDay, app.applicationId).toBe(app.activeMs);
    }
  });

  it('is independent of the order in which records arrive', () => {
    const shuffled = [...EVENTS].reverse();
    const again = summarize(shuffled, { range, applications: APPLICATIONS });
    expect(again).toEqual(summary);
  });
});

describe('integration: validated custom range', () => {
  it('summarizes Sunday and Monday after validating the picker input', () => {
    const picked = unwrap(validateCustomRange('2026-10-11', '2026-10-12'));
    const summary = report(
      resolveRange('custom', { now: NOW, timeZone: TIME_ZONE, customStart: picked.start, customEnd: picked.end }),
    );
    expect(summary.range.label).toBe('11 Oct – 12 Oct');
    expect(minutes(summary.totals)).toEqual({ foreground: 515, active: 480, idle: 35 });
  });

  it('never reaches the engine with an invalid picker input', () => {
    expect(validateCustomRange('2026-10-12', '2026-10-11').ok).toBe(false);
    expect(validateCustomRange('2025-10-01', '2026-10-13').ok).toBe(false); // longer than 366 days
  });
});

describe('integration: another viewer time zone', () => {
  it('re-buckets the same records by New York days without changing the totals', () => {
    const london = report(resolveRange('custom', { now: NOW, timeZone: TIME_ZONE, customStart: '2026-10-01', customEnd: '2026-10-20' }));
    const newYork = report(
      resolveRange('custom', { now: NOW, timeZone: 'America/New_York', customStart: '2026-10-01', customEnd: '2026-10-20' }),
    );
    expect(newYork.totals).toEqual(london.totals);
    // Monday 23:10 BST is 18:10 EDT, so the whole Blender session belongs to Monday in New York.
    const nyMonday = newYork.byDay.find((entry) => entry.day === '2026-10-12')!;
    expect(nyMonday.activeByApplication['blender']).toBe(90 * MINUTE);
  });
});
