import { describe, expect, it } from 'vitest';

import {
  ALL,
  ALL_PROJECTS,
  CSV_BOM,
  DEFAULT_PREFERENCES,
  EVERYONE,
  MAX_SAVED_VIEWS,
  MEASUREMENTS,
  SESSION_COLUMNS,
  SUMMARY_COLUMNS,
  activityChartData,
  allowedBuckets,
  analyticsFootnote,
  analyticsSummaryKey,
  applicationColors,
  applicationItems,
  applicationOptions,
  applySavedView,
  assignedProjects,
  autoBucket,
  buildSessionsCsv,
  buildSessionsJson,
  buildSummaryCsv,
  buildSummaryJson,
  createReportLabels,
  csvCell,
  decodeProjectFilter,
  deleteView,
  encodeProjectFilter,
  exportFileName,
  exportReady,
  formatDayRange,
  formatLocalIso,
  isDay,
  isReportTimeZone,
  memberItems,
  mySessionsKey,
  parsePreferences,
  periodSeries,
  predictTeammatesVisible,
  preferencesKey,
  previousPeriodParams,
  previousReferenceText,
  privacyNote,
  projectFilterOptions,
  projectItems,
  projectProgressRows,
  readPreferences,
  reportTotals,
  reportingToday,
  resolveAnalyticsRange,
  resolveBucket,
  resolveScope,
  SAVE_VIEW_RANGE_MESSAGE,
  saveView,
  scopedLabel,
  selectTasks,
  serializePreferences,
  sessionQueryFilters,
  sessionRecords,
  showsPreviousReference,
  splitReport,
  stableJson,
  standingVerdict,
  summarizeTaskProgress,
  summaryParams,
  summaryRecords,
  taskItems,
  teammatesVisibleNow,
  timeOfOptions,
  toCsv,
  unattributedTime,
  upcomingDeadlines,
  validatePreferences,
  validateSavedViewName,
  whoseTime,
  withoutApplicationFilter,
  workspaceSlug,
  writePreferences,
} from '../../../apps/web/src/lib/analytics';
import type {
  AnalyticsPreferences,
  ProjectFilter,
  RangeChoice,
  ReportRange,
  ReportRow,
  SavedView,
  SummaryExportInput,
  SummaryExportMeta,
  TaskProgressSummary,
} from '../../../apps/web/src/lib/analytics';
import type { MySession } from '../../../apps/web/src/lib/api';
import type { Project, Task } from '../../../apps/web/src/lib/model';

const WS = '00000000-0000-4000-8000-000000000001';
const ME = 'u-me';
const YOU = 'u-you';
const LONDON = 'Europe/London';
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Friday 13 November 2026, noon UTC (and noon in London). */
const NOW = Date.UTC(2026, 10, 13, 12);
const TODAY = '2026-11-13';

function mustResolve(choice: RangeChoice, options: { now: number; timeZone: string } = { now: NOW, timeZone: LONDON }): ReportRange {
  const result = resolveAnalyticsRange(choice, options);
  if (!result.ok) throw new Error(result.message);
  return result.range;
}

function rangeMessage(choice: RangeChoice): string | null {
  const result = resolveAnalyticsRange(choice, { now: NOW, timeZone: LONDON });
  return result.ok ? null : result.message;
}

// ---------------------------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------------------------

describe('scope', () => {
  it('My work asks for the viewer’s own time and counts the tasks assigned to them', () => {
    expect(resolveScope({ view: 'mine', me: ME, teammatesVisible: true })).toEqual({
      view: 'mine',
      showsTime: true,
      userIds: [ME],
      taskAssigneeId: ME,
      personId: null,
    });
    // A "Time of" choice left over from Workspace view never reaches My work.
    expect(resolveScope({ view: 'mine', me: ME, personId: YOU, teammatesVisible: true }).userIds).toEqual([ME]);
    expect(resolveScope({ view: 'mine', me: ME, teammatesVisible: false }).userIds).toEqual([ME]);
  });

  it('Workspace asks for everyone visible (null) and counts every task', () => {
    expect(resolveScope({ view: 'workspace', me: ME, teammatesVisible: true })).toEqual({
      view: 'workspace',
      showsTime: true,
      userIds: null,
      taskAssigneeId: null,
      personId: null,
    });
    expect(resolveScope({ view: 'workspace', me: ME, personId: null, teammatesVisible: true }).userIds).toBeNull();
  });

  it('Workspace with a person asks for that person’s time and their assigned tasks', () => {
    expect(resolveScope({ view: 'workspace', me: ME, personId: YOU, teammatesVisible: true })).toEqual({
      view: 'workspace',
      showsTime: true,
      userIds: [YOU],
      taskAssigneeId: YOU,
      personId: YOU,
    });
  });

  it('Workspace without visible teammates shows no time, never asks for a teammate, and counts every task', () => {
    expect(resolveScope({ view: 'workspace', me: ME, personId: YOU, teammatesVisible: false })).toEqual({
      view: 'workspace',
      showsTime: false,
      userIds: [ME],
      taskAssigneeId: null,
      personId: null,
    });
  });

  it('predicts visible teammates only for an owner or admin under "admins" visibility', () => {
    expect(predictTeammatesVisible({ role: 'owner', timeEntryVisibility: 'admins' })).toBe(true);
    expect(predictTeammatesVisible({ role: 'admin', timeEntryVisibility: 'admins' })).toBe(true);
    expect(predictTeammatesVisible({ role: 'member', timeEntryVisibility: 'admins' })).toBe(false);
    expect(predictTeammatesVisible({ role: 'owner', timeEntryVisibility: 'private' })).toBe(false);
    expect(predictTeammatesVisible({ role: 'admin', timeEntryVisibility: 'private' })).toBe(false);
    expect(predictTeammatesVisible({ role: 'member', timeEntryVisibility: 'private' })).toBe(false);
  });

  it('words the privacy note by visibility and role', () => {
    const privateNote = 'Time in this workspace is private to each person. You see only your own. Only the workspace owner can change this.';
    expect(privacyNote({ role: 'member', timeEntryVisibility: 'private' })).toBe(privateNote);
    expect(privacyNote({ role: 'admin', timeEntryVisibility: 'private' })).toBe(privateNote);
    expect(privacyNote({ role: 'owner', timeEntryVisibility: 'private' })).toBe(privateNote);
    expect(privacyNote({ role: 'member', timeEntryVisibility: 'admins' })).toBe(
      'Owners and admins can see members’ time in this workspace, including yours. You see only your own.',
    );
    const everyone = 'Includes the time of everyone in this workspace, including former members.';
    expect(privacyNote({ role: 'owner', timeEntryVisibility: 'admins' })).toBe(everyone);
    expect(privacyNote({ role: 'admin', timeEntryVisibility: 'admins' })).toBe(everyone);
  });

  it('never offers to share time in the privacy note', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      for (const timeEntryVisibility of ['private', 'admins'] as const) {
        expect(privacyNote({ role, timeEntryVisibility })).not.toMatch(/share/i);
        for (const shown of [true, false]) expect(privacyNote({ role, timeEntryVisibility }, shown)).not.toMatch(/share/i);
      }
    }
  });

  it('a server verdict on teammates’ time lasts only while the cached workspace stays in the state it was given in', () => {
    const ownerAdmins = { role: 'owner', timeEntryVisibility: 'admins' } as const;
    const ownerPrivate = { role: 'owner', timeEntryVisibility: 'private' } as const;
    const said = { role: 'owner', visibility: 'admins', value: false };
    // The report said no while the cache said owner/admins: the verdict wins over the prediction…
    expect(standingVerdict(said, ownerAdmins)).toBe(said);
    expect(teammatesVisibleNow(said, ownerAdmins)).toBe(false);
    // …and a reload that comes back with the same pair keeps it.
    expect(standingVerdict(said, { ...ownerAdmins })).toBe(said);
    // The cache moves to private: the verdict is dropped (the page stores null).
    const afterPrivate = standingVerdict(said, ownerPrivate);
    expect(afterPrivate).toBeNull();
    expect(teammatesVisibleNow(afterPrivate, ownerPrivate)).toBe(false);
    // Back to admins: predicted (and asked) afresh, not answered by the old "no".
    expect(standingVerdict(afterPrivate, ownerAdmins)).toBeNull();
    expect(teammatesVisibleNow(afterPrivate, ownerAdmins)).toBe(true);
    // A role change drops it too; no verdict at all is the prediction.
    expect(standingVerdict(said, { role: 'admin', timeEntryVisibility: 'admins' })).toBeNull();
    expect(teammatesVisibleNow(null, { role: 'member', timeEntryVisibility: 'admins' })).toBe(false);
  });

  it('words the privacy note by what is shown when the server’s verdict differs from the cached workspace', () => {
    const everyone = 'Includes the time of everyone in this workspace, including former members.';
    const withheld = 'Teammates’ time isn’t available to you right now. You see only your own.';
    // No "Includes the time of everyone" over a panel with no time.
    expect(privacyNote({ role: 'owner', timeEntryVisibility: 'admins' }, false)).toBe(withheld);
    expect(privacyNote({ role: 'admin', timeEntryVisibility: 'admins' }, false)).toBe(withheld);
    expect(privacyNote({ role: 'member', timeEntryVisibility: 'private' }, true)).toBe(everyone);
    // Agreeing with the prediction changes nothing.
    expect(privacyNote({ role: 'owner', timeEntryVisibility: 'admins' }, true)).toBe(everyone);
    expect(privacyNote({ role: 'member', timeEntryVisibility: 'admins' }, false)).toBe(
      'Owners and admins can see members’ time in this workspace, including yours. You see only your own.',
    );
  });

  it('names whose time a figure shows only when it is not the viewer’s own', () => {
    const labels = createReportLabels({ projects: [], tasks: [], members: [{ userId: YOU, displayName: 'Carol' }] });
    expect(whoseTime(resolveScope({ view: 'mine', me: ME, teammatesVisible: true }), ME, labels)).toBeNull();
    expect(whoseTime(resolveScope({ view: 'workspace', me: ME, teammatesVisible: true }), ME, labels)).toBe('Everyone you can see');
    expect(whoseTime(resolveScope({ view: 'workspace', me: ME, personId: YOU, teammatesVisible: true }), ME, labels)).toBe('Carol');
    expect(whoseTime(resolveScope({ view: 'workspace', me: ME, personId: ME, teammatesVisible: true }), ME, labels)).toBeNull();
    expect(whoseTime(resolveScope({ view: 'workspace', me: ME, teammatesVisible: false }), ME, labels)).toBeNull();
    expect(scopedLabel('Carol', 'Active')).toBe('Carol · Active');
    expect(scopedLabel(null, 'Active')).toBe('Active');
  });
});

// ---------------------------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------------------------

describe('range resolution', () => {
  it('Today is the reporting zone’s current day, with the day before as the previous period', () => {
    expect(mustResolve({ preset: 'today' })).toEqual({
      preset: 'today',
      timeZone: LONDON,
      fromDay: TODAY,
      toDay: TODAY,
      days: 1,
      startMs: Date.UTC(2026, 10, 13),
      endMs: Date.UTC(2026, 10, 14),
      label: 'Today',
      includesToday: true,
      previous: {
        fromDay: '2026-11-12',
        toDay: '2026-11-12',
        days: 1,
        startMs: Date.UTC(2026, 10, 12),
        endMs: Date.UTC(2026, 10, 13),
        label: 'Previous day (12 Nov)',
      },
    });
  });

  it('Yesterday does not include today', () => {
    const range = mustResolve({ preset: 'yesterday' });
    expect(range).toMatchObject({ fromDay: '2026-11-12', toDay: '2026-11-12', days: 1, label: 'Yesterday', includesToday: false });
    expect(range.previous).toMatchObject({ fromDay: '2026-11-11', toDay: '2026-11-11', days: 1 });
  });

  it('Last 7 days ends today and follows the 7 days before it', () => {
    expect(mustResolve({ preset: 'last7' })).toEqual({
      preset: 'last7',
      timeZone: LONDON,
      fromDay: '2026-11-07',
      toDay: TODAY,
      days: 7,
      startMs: Date.UTC(2026, 10, 7),
      endMs: Date.UTC(2026, 10, 14),
      label: 'Last 7 days',
      includesToday: true,
      previous: {
        fromDay: '2026-10-31',
        toDay: '2026-11-06',
        days: 7,
        startMs: Date.UTC(2026, 9, 31),
        endMs: Date.UTC(2026, 10, 7),
        label: 'Previous 7 days (31 Oct – 6 Nov)',
      },
    });
  });

  it('Last 30 days starts 29 days back, at that day’s local midnight (summer time)', () => {
    const range = mustResolve({ preset: 'last30' });
    expect(range).toMatchObject({ fromDay: '2026-10-15', toDay: TODAY, days: 30, label: 'Last 30 days', includesToday: true });
    // 15 October is still British Summer Time: local midnight is 23:00 UTC the evening before.
    expect(range.startMs).toBe(Date.UTC(2026, 9, 14, 23));
    expect(range.endMs).toBe(Date.UTC(2026, 10, 14));
    expect(range.previous).toMatchObject({ fromDay: '2026-09-15', toDay: '2026-10-14', days: 30 });
    expect(range.previous.endMs).toBe(range.startMs);
  });

  it('takes today from the reporting zone, not from UTC or the host', () => {
    const now = Date.UTC(2026, 10, 13, 2); // 18:00 on the 12th in Los Angeles, 11:00 on the 13th in Tokyo
    const losAngeles = mustResolve({ preset: 'today' }, { now, timeZone: 'America/Los_Angeles' });
    expect(losAngeles).toMatchObject({ fromDay: '2026-11-12', toDay: '2026-11-12', timeZone: 'America/Los_Angeles' });
    expect(losAngeles.startMs).toBe(Date.UTC(2026, 10, 12, 8));
    expect(losAngeles.endMs).toBe(Date.UTC(2026, 10, 13, 8));
    const tokyo = mustResolve({ preset: 'today' }, { now, timeZone: 'Asia/Tokyo' });
    expect(tokyo).toMatchObject({ fromDay: '2026-11-13', toDay: '2026-11-13' });
    expect(tokyo.startMs).toBe(Date.UTC(2026, 10, 12, 15));
  });

  it('covers a 25-hour day when the clocks go back', () => {
    const range = mustResolve({ preset: 'custom', customFrom: '2026-11-01', customTo: '2026-11-01' }, { now: NOW, timeZone: 'America/New_York' });
    expect(range.startMs).toBe(Date.UTC(2026, 10, 1, 4));
    expect(range.endMs).toBe(Date.UTC(2026, 10, 2, 5));
  });

  it('resolves a custom range with its label and the equally long period before it', () => {
    expect(mustResolve({ preset: 'custom', customFrom: '2026-11-03', customTo: '2026-11-09' })).toEqual({
      preset: 'custom',
      timeZone: LONDON,
      fromDay: '2026-11-03',
      toDay: '2026-11-09',
      days: 7,
      startMs: Date.UTC(2026, 10, 3),
      endMs: Date.UTC(2026, 10, 10),
      label: '3–9 Nov',
      includesToday: false,
      previous: {
        fromDay: '2026-10-27',
        toDay: '2026-11-02',
        days: 7,
        startMs: Date.UTC(2026, 9, 27),
        endMs: Date.UTC(2026, 10, 3),
        label: 'Previous 7 days (27 Oct – 2 Nov)',
      },
    });
  });

  it('flags a custom range that includes today, also when it runs into the future', () => {
    expect(mustResolve({ preset: 'custom', customFrom: '2026-11-10', customTo: '2026-11-20' }).includesToday).toBe(true);
    expect(mustResolve({ preset: 'custom', customFrom: TODAY, customTo: TODAY }).includesToday).toBe(true);
    expect(mustResolve({ preset: 'custom', customFrom: '2026-11-14', customTo: '2026-11-20' }).includesToday).toBe(false);
    expect(mustResolve({ preset: 'custom', customFrom: '2026-11-01', customTo: '2026-11-12' }).includesToday).toBe(false);
  });

  it('labels day ranges compactly, with years outside the current one', () => {
    expect(formatDayRange('2026-11-12', '2026-11-12', TODAY)).toBe('12 Nov');
    expect(formatDayRange('2026-11-03', '2026-11-09', TODAY)).toBe('3–9 Nov');
    expect(formatDayRange('2026-10-28', '2026-11-03', TODAY)).toBe('28 Oct – 3 Nov');
    expect(formatDayRange('2025-11-03', '2025-11-09', TODAY)).toBe('3–9 Nov 2025');
    expect(mustResolve({ preset: 'custom', customFrom: '2025-12-28', customTo: '2026-01-03' }).label).toBe('28 Dec 2025 – 3 Jan 2026');
  });

  it('refuses a custom range without two real dates', () => {
    const message = 'Choose a start and an end date.';
    expect(rangeMessage({ preset: 'custom' })).toBe(message);
    expect(rangeMessage({ preset: 'custom', customFrom: '2026-11-03' })).toBe(message);
    expect(rangeMessage({ preset: 'custom', customFrom: '2026-02-30', customTo: '2026-03-02' })).toBe(message);
    expect(rangeMessage({ preset: 'custom', customFrom: '03/11/2026', customTo: '2026-11-09' })).toBe(message);
  });

  it('refuses a custom range that ends before it starts', () => {
    expect(rangeMessage({ preset: 'custom', customFrom: '2026-11-09', customTo: '2026-11-03' })).toBe('The end date is before the start date.');
  });

  it('accepts 366 days and refuses 367', () => {
    const longest = mustResolve({ preset: 'custom', customFrom: '2025-01-01', customTo: '2026-01-01' });
    expect(longest.days).toBe(366);
    expect(longest.previous).toMatchObject({ fromDay: '2024-01-01', toDay: '2024-12-31', days: 366 });
    expect(rangeMessage({ preset: 'custom', customFrom: '2025-01-01', customTo: '2026-01-02' })).toBe('A custom range covers at most 366 days.');
  });

  it('accepts days from 1 January 2020 to 31 December 2099 only', () => {
    expect(rangeMessage({ preset: 'custom', customFrom: '2019-12-31', customTo: '2020-01-05' })).toBe('Reports cover days from 1 January 2020.');
    expect(mustResolve({ preset: 'custom', customFrom: '2020-01-01', customTo: '2020-01-05' }).fromDay).toBe('2020-01-01');
    expect(rangeMessage({ preset: 'custom', customFrom: '2099-12-30', customTo: '2100-01-01' })).toBe('Reports cover days before 1 January 2100.');
    expect(mustResolve({ preset: 'custom', customFrom: '2099-12-30', customTo: '2099-12-31' }).toDay).toBe('2099-12-31');
  });

  it('recognises real calendar days only', () => {
    expect(isDay('2026-11-13')).toBe(true);
    expect(isDay('2024-02-29')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2026-13-01')).toBe(false);
    expect(isDay('2026-1-1')).toBe(false);
    expect(isDay(20261113)).toBe(false);
    expect(isDay(null)).toBe(false);
  });
});

describe('previous-period reference', () => {
  const mine = resolveScope({ view: 'mine', me: ME, teammatesVisible: true });
  const everyone = resolveScope({ view: 'workspace', me: ME, teammatesVisible: true });

  it('is shown for my own time and for everyone together', () => {
    expect(showsPreviousReference(mustResolve({ preset: 'last7' }), mine, ME)).toBe(true);
    expect(showsPreviousReference(mustResolve({ preset: 'last30' }), mine, ME)).toBe(true);
    expect(showsPreviousReference(mustResolve({ preset: 'yesterday' }), mine, ME)).toBe(true);
    expect(showsPreviousReference(mustResolve({ preset: 'last7' }), everyone, ME)).toBe(true);
  });

  it('is not shown for Today, nor for a custom range of just today', () => {
    expect(showsPreviousReference(mustResolve({ preset: 'today' }), mine, ME)).toBe(false);
    expect(showsPreviousReference(mustResolve({ preset: 'today' }), everyone, ME)).toBe(false);
    expect(showsPreviousReference(mustResolve({ preset: 'custom', customFrom: TODAY, customTo: TODAY }), mine, ME)).toBe(false);
  });

  it('is not shown for a specific teammate, but is for the viewer picked under "Time of"', () => {
    const teammate = resolveScope({ view: 'workspace', me: ME, personId: YOU, teammatesVisible: true });
    const myself = resolveScope({ view: 'workspace', me: ME, personId: ME, teammatesVisible: true });
    expect(showsPreviousReference(mustResolve({ preset: 'last7' }), teammate, ME)).toBe(false);
    expect(showsPreviousReference(mustResolve({ preset: 'yesterday' }), teammate, ME)).toBe(false);
    expect(showsPreviousReference(mustResolve({ preset: 'last7' }), myself, ME)).toBe(true);
  });

  it('is not shown where no time is shown, nor when it would start before 2020', () => {
    const tasksOnly = resolveScope({ view: 'workspace', me: ME, teammatesVisible: false });
    expect(showsPreviousReference(mustResolve({ preset: 'last7' }), tasksOnly, ME)).toBe(false);
    expect(showsPreviousReference(mustResolve({ preset: 'custom', customFrom: '2020-01-03', customTo: '2020-01-09' }), mine, ME)).toBe(false);
    expect(showsPreviousReference(mustResolve({ preset: 'custom', customFrom: '2020-01-08', customTo: '2020-01-14' }), mine, ME)).toBe(true);
  });

  it('reads as a neutral line, never a delta', () => {
    const active = 31 * HOUR + 10 * MINUTE;
    expect(previousReferenceText(mustResolve({ preset: 'last7' }), active)).toBe(
      'Previous 7 days (31 Oct – 6 Nov): 31h 10m (today still in progress)',
    );
    const past = previousReferenceText(mustResolve({ preset: 'custom', customFrom: '2026-11-03', customTo: '2026-11-09' }), active);
    expect(past).toBe('Previous 7 days (27 Oct – 2 Nov): 31h 10m');
    expect(past).not.toMatch(/[+%↑↓▲▼]|more|less|better|worse/i);
  });
});

// ---------------------------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------------------------

describe('buckets', () => {
  it('Auto is day up to 31 days, week up to 120, month beyond', () => {
    expect(autoBucket(1)).toBe('day');
    expect(autoBucket(31)).toBe('day');
    expect(autoBucket(32)).toBe('week');
    expect(autoBucket(120)).toBe('week');
    expect(autoBucket(121)).toBe('month');
    expect(autoBucket(366)).toBe('month');
  });

  it('offers Day only up to 92 days', () => {
    expect(allowedBuckets(1)).toEqual(['day', 'week', 'month']);
    expect(allowedBuckets(92)).toEqual(['day', 'week', 'month']);
    expect(allowedBuckets(93)).toEqual(['week', 'month']);
    expect(allowedBuckets(366)).toEqual(['week', 'month']);
  });

  it('resolves a choice, sending Day past 92 days back to Auto', () => {
    expect(resolveBucket('auto', 7)).toBe('day');
    expect(resolveBucket('auto', 60)).toBe('week');
    expect(resolveBucket('auto', 200)).toBe('month');
    expect(resolveBucket('day', 92)).toBe('day');
    expect(resolveBucket('day', 93)).toBe('week');
    expect(resolveBucket('day', 200)).toBe('month');
    expect(resolveBucket('week', 7)).toBe('week');
    expect(resolveBucket('month', 7)).toBe('month');
    expect(resolveBucket('week', 366)).toBe('week');
  });
});

// ---------------------------------------------------------------------------------------------
// Requests and cache keys
// ---------------------------------------------------------------------------------------------

describe('report requests and cache keys', () => {
  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const range = mustResolve({ preset: 'last7' });
  const mine = resolveScope({ view: 'mine', me: ME, teammatesVisible: false });
  const base = summaryParams({ workspaceId: WS, range, bucket: 'day', scope: mine, projectFilter: ALL_PROJECTS, applicationId: null });

  it('maps range, scope and filters to the report request', () => {
    expect(base).toEqual({
      workspaceId: WS,
      fromDay: '2026-11-07',
      toDay: TODAY,
      timeZone: LONDON,
      bucket: 'day',
      userIds: [ME],
      projectId: null,
      unattributed: false,
      applicationId: null,
    });
    const everyone = resolveScope({ view: 'workspace', me: ME, teammatesVisible: true });
    expect(
      summaryParams({ workspaceId: WS, range, bucket: 'week', scope: everyone, projectFilter: { kind: 'project', id: PROJECT }, applicationId: 'figma' }),
    ).toEqual({
      workspaceId: WS,
      fromDay: '2026-11-07',
      toDay: TODAY,
      timeZone: LONDON,
      bucket: 'week',
      userIds: null,
      projectId: PROJECT,
      unattributed: false,
      applicationId: 'figma',
    });
    expect(
      summaryParams({ workspaceId: WS, range, bucket: 'day', scope: mine, projectFilter: { kind: 'unattributed' }, applicationId: null }),
    ).toMatchObject({ projectId: null, unattributed: true });
  });

  it('derives the unfiltered and previous-period requests', () => {
    const filtered = { ...base, applicationId: 'figma' };
    expect(withoutApplicationFilter(filtered)).toEqual(base);
    expect(previousPeriodParams(filtered, range.previous)).toEqual({
      ...filtered,
      fromDay: '2026-10-31',
      toDay: '2026-11-06',
      bucket: 'month',
    });
  });

  it('writes JSON with sorted keys and without null or undefined members', () => {
    expect(stableJson({ b: 1, a: { d: null, c: [3, { z: 1, y: undefined }] } })).toBe('{"a":{"c":[3,{"z":1}]},"b":1}');
    expect(stableJson({ x: 'a', y: 2 })).toBe(stableJson({ y: 2, x: 'a' }));
  });

  it('keys a report under ws:<id>:time:analytics: with the stable JSON of its request', () => {
    expect(analyticsSummaryKey(base)).toBe(
      `ws:${WS}:time:analytics:summary:{"bucket":"day","fromDay":"2026-11-07","timeZone":"Europe/London","toDay":"2026-11-13","userIds":["u-me"]}`,
    );
    expect(
      analyticsSummaryKey({ ...base, bucket: 'week', userIds: ['b', 'a'], projectId: null, unattributed: true, applicationId: 'figma' }),
    ).toBe(
      `ws:${WS}:time:analytics:summary:{"applicationId":"figma","bucket":"week","fromDay":"2026-11-07","timeZone":"Europe/London","toDay":"2026-11-13","unattributed":true,"userIds":["a","b"]}`,
    );
  });

  it('gives equal requests equal keys and different requests different keys', () => {
    const reordered = {
      applicationId: null,
      unattributed: false,
      projectId: null,
      userIds: [ME],
      bucket: 'day' as const,
      timeZone: LONDON,
      toDay: TODAY,
      fromDay: '2026-11-07',
      workspaceId: WS,
    };
    expect(analyticsSummaryKey(reordered)).toBe(analyticsSummaryKey(base));
    // Leaving out the optional members is the same as passing null (or the default `false`).
    expect(analyticsSummaryKey({ workspaceId: WS, fromDay: '2026-11-07', toDay: TODAY, timeZone: LONDON, bucket: 'day', userIds: [ME] })).toBe(
      analyticsSummaryKey(base),
    );
    expect(analyticsSummaryKey({ ...base, userIds: ['a', 'b'] })).toBe(analyticsSummaryKey({ ...base, userIds: ['b', 'a'] }));

    const key = analyticsSummaryKey(base);
    expect(analyticsSummaryKey({ ...base, workspaceId: '00000000-0000-4000-8000-000000000002' })).not.toBe(key);
    expect(analyticsSummaryKey({ ...base, applicationId: 'figma' })).not.toBe(key);
    expect(analyticsSummaryKey({ ...base, projectId: PROJECT })).not.toBe(key);
    expect(analyticsSummaryKey({ ...base, unattributed: true })).not.toBe(key);
    expect(analyticsSummaryKey({ ...base, userIds: null })).not.toBe(key);
    expect(analyticsSummaryKey({ ...base, userIds: [YOU] })).not.toBe(key);
    expect(analyticsSummaryKey({ ...base, timeZone: 'UTC' })).not.toBe(key);
    expect(analyticsSummaryKey({ ...base, fromDay: '2026-11-06' })).not.toBe(key);
    expect(analyticsSummaryKey({ ...base, bucket: 'week' })).not.toBe(key);
  });

  it('keys the session list under the same prefix', () => {
    const query = { workspaceId: WS, userId: ME, startIso: '2026-11-07T00:00:00.000Z', endIso: '2026-11-14T00:00:00.000Z', limit: 50 };
    expect(mySessionsKey(query)).toBe(
      `ws:${WS}:time:analytics:sessions:{"endIso":"2026-11-14T00:00:00.000Z","limit":50,"startIso":"2026-11-07T00:00:00.000Z","userId":"u-me"}`,
    );
    expect(mySessionsKey({ ...query, unattributedOnly: true })).toBe(
      `ws:${WS}:time:analytics:sessions:{"endIso":"2026-11-14T00:00:00.000Z","limit":50,"startIso":"2026-11-07T00:00:00.000Z","unattributedOnly":true,"userId":"u-me"}`,
    );
    expect(mySessionsKey(query).startsWith(`ws:${WS}:time:`)).toBe(true);
    expect(analyticsSummaryKey(base).startsWith(`ws:${WS}:time:`)).toBe(true);
    // The page's filters are part of the key: a filtered list is never shown for another filter.
    expect(mySessionsKey({ ...query, ...sessionQueryFilters({ kind: 'project', id: PROJECT }, 'figma', false) })).toBe(
      `ws:${WS}:time:analytics:sessions:{"applicationId":"figma","endIso":"2026-11-14T00:00:00.000Z","limit":50,"projectId":"${PROJECT}","startIso":"2026-11-07T00:00:00.000Z","userId":"u-me"}`,
    );
  });

  it('turns the page’s filters into the session list’s, as the report applies them', () => {
    // No filter: every session.
    expect(sessionQueryFilters(ALL_PROJECTS, null, false)).toEqual({});
    // A project and an application, as the report's p_project_id and p_application_id.
    expect(sessionQueryFilters({ kind: 'project', id: PROJECT }, 'figma', false)).toEqual({ projectId: PROJECT, applicationId: 'figma' });
    // The page's Unattributed filter: no project and no task, as the report's p_unattributed.
    expect(sessionQueryFilters({ kind: 'unattributed' }, null, false)).toEqual({ unattributedOnly: true });
    expect(sessionQueryFilters({ kind: 'unattributed' }, 'figma', true)).toEqual({ applicationId: 'figma', unattributedOnly: true });
    // The card's "Only unattributed" narrows the list while no project is chosen …
    expect(sessionQueryFilters(ALL_PROJECTS, 'figma', true)).toEqual({ applicationId: 'figma', unattributedOnly: true });
    // … and is set aside under a project filter, where it could only empty the list.
    expect(sessionQueryFilters({ kind: 'project', id: PROJECT }, null, true)).toEqual({ projectId: PROJECT });
  });
});

// ---------------------------------------------------------------------------------------------
// Fixtures: report rows, projects, tasks, people
// ---------------------------------------------------------------------------------------------

function row(overrides: Partial<ReportRow> & Pick<ReportRow, 'dimension'>): ReportRow {
  return {
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
    teammatesVisible: null,
    ...overrides,
  };
}

function task(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    workspace_id: WS,
    project_id: null,
    title: `Task ${overrides.id}`,
    description: '',
    status: 'todo',
    priority: 'normal',
    assignee_id: null,
    created_by: ME,
    due_date: null,
    start_date: null,
    estimated_minutes: null,
    completed_at: null,
    created_at: '2026-10-01T09:00:00Z',
    updated_at: '2026-10-01T09:00:00Z',
    version: 1,
    ...overrides,
  };
}

function project(overrides: Partial<Project> & Pick<Project, 'id' | 'name'>): Project {
  return {
    workspace_id: WS,
    description: '',
    status: 'active',
    created_by: ME,
    created_at: '2026-10-01T09:00:00Z',
    updated_at: '2026-10-01T09:00:00Z',
    lead_id: null,
    start_date: null,
    due_date: null,
    version: 1,
    ...overrides,
  };
}

const PROJECTS: readonly Project[] = [
  project({ id: 'p1', name: 'Brand refresh' }),
  project({ id: 'p2', name: 'Annual report', lead_id: ME }),
  project({ id: 'p3', name: 'Zine', status: 'archived', lead_id: ME }),
  project({ id: 'p4', name: 'Empty' }),
];

const TASKS: readonly Task[] = [
  task({ id: 't1', title: 'Logo, v2', project_id: 'p1', status: 'in_progress', assignee_id: ME, due_date: '2026-11-12', estimated_minutes: 120 }),
  task({ id: 't2', title: '=cmd', status: 'todo', assignee_id: ME, due_date: '2026-11-20' }),
  task({ id: 't3', title: 'Old', project_id: 'p1', status: 'archived', assignee_id: ME, due_date: '2026-11-01' }),
  task({ id: 't4', title: 'Storyboard', project_id: 'p1', status: 'todo', assignee_id: ME, due_date: '2026-11-11' }),
  task({ id: 't5', title: 'Proofs', project_id: 'p1', status: 'in_review', assignee_id: YOU, due_date: '2026-11-19' }),
  task({ id: 't6', title: 'Cover', project_id: 'p2', status: 'done', assignee_id: ME, due_date: '2026-11-01' }),
  task({ id: 't7', title: 'Ideas', status: 'inbox' }),
  task({ id: 't8', title: 'Charts', project_id: 'p2', status: 'in_review', assignee_id: YOU, due_date: '2026-11-10' }),
];

const MEMBERS = [
  { userId: ME, displayName: 'Ada' },
  { userId: YOU, displayName: 'Carol' },
];

const LABELS = createReportLabels({ projects: PROJECTS, tasks: TASKS, members: MEMBERS, formerNames: new Map([['u-gone', 'Bo']]) });

// ---------------------------------------------------------------------------------------------
// Report rows → view models
// ---------------------------------------------------------------------------------------------

describe('report rows', () => {
  it('splits a report by dimension, keeping the server’s order', () => {
    const rows = [
      row({ dimension: 'period', bucketStart: '2026-11-08', activeMs: HOUR }),
      row({ dimension: 'total', activeMs: 2 * HOUR, idleMs: 30 * MINUTE, entryCount: 4, overlapMs: 5 * MINUTE, teammatesVisible: true }),
      row({ dimension: 'period', bucketStart: '2026-11-07', activeMs: HOUR }),
      row({ dimension: 'member', userId: ME }),
      row({ dimension: 'project', projectId: 'p1', unattributed: false }),
      row({ dimension: 'task', projectId: 'p1', taskId: 't1' }),
      row({ dimension: 'application', applicationId: 'figma', applicationName: 'Figma' }),
    ];
    const parts = splitReport(rows);
    expect(parts.periods.map((period) => period.bucketStart)).toEqual(['2026-11-08', '2026-11-07']);
    expect(parts.members).toHaveLength(1);
    expect(parts.projects).toHaveLength(1);
    expect(parts.tasks).toHaveLength(1);
    expect(parts.applications).toHaveLength(1);
    expect(reportTotals(parts.total)).toEqual({
      activeMs: 2 * HOUR,
      idleMs: 30 * MINUTE,
      foregroundMs: 150 * MINUTE,
      sessions: 4,
      overlapMs: 5 * MINUTE,
      teammatesVisible: true,
    });
  });

  it('reads an empty report as zeros, with the server’s word on teammates still unknown', () => {
    const parts = splitReport([]);
    expect(parts.periods).toEqual([]);
    expect(parts.members).toEqual([]);
    expect(parts.projects).toEqual([]);
    expect(parts.tasks).toEqual([]);
    expect(parts.applications).toEqual([]);
    expect(reportTotals(parts.total)).toEqual({ activeMs: 0, idleMs: 0, foregroundMs: 0, sessions: 0, overlapMs: 0, teammatesVisible: null });
  });
});

describe('period series', () => {
  const ZERO = { activeMs: 0, idleMs: 0, foregroundMs: 0, sessions: 0 };

  it('gives one point per day and fills days without time with zeros', () => {
    const points = periodSeries(
      [
        row({ dimension: 'period', bucketStart: '2026-11-12', activeMs: 2 * HOUR, idleMs: 0, entryCount: 1 }),
        row({ dimension: 'period', bucketStart: '2026-11-08', activeMs: HOUR, idleMs: 10 * MINUTE, entryCount: 2 }),
      ],
      { fromDay: '2026-11-07', toDay: '2026-11-13', bucket: 'day' },
    );
    expect(points).toEqual([
      { bucketStart: '2026-11-07', lastDay: '2026-11-07', partial: false, ...ZERO },
      { bucketStart: '2026-11-08', lastDay: '2026-11-08', partial: false, activeMs: HOUR, idleMs: 10 * MINUTE, foregroundMs: 70 * MINUTE, sessions: 2 },
      { bucketStart: '2026-11-09', lastDay: '2026-11-09', partial: false, ...ZERO },
      { bucketStart: '2026-11-10', lastDay: '2026-11-10', partial: false, ...ZERO },
      { bucketStart: '2026-11-11', lastDay: '2026-11-11', partial: false, ...ZERO },
      { bucketStart: '2026-11-12', lastDay: '2026-11-12', partial: false, activeMs: 2 * HOUR, idleMs: 0, foregroundMs: 2 * HOUR, sessions: 1 },
      { bucketStart: '2026-11-13', lastDay: '2026-11-13', partial: false, ...ZERO },
    ]);
  });

  it('starts weeks on Monday and marks a partial first and last week', () => {
    // 15 October 2026 is a Thursday, 13 November a Friday.
    const points = periodSeries([row({ dimension: 'period', bucketStart: '2026-10-26', activeMs: 5 * HOUR, entryCount: 9 })], {
      fromDay: '2026-10-15',
      toDay: '2026-11-13',
      bucket: 'week',
    });
    expect(points).toEqual([
      { bucketStart: '2026-10-12', lastDay: '2026-10-18', partial: true, ...ZERO },
      { bucketStart: '2026-10-19', lastDay: '2026-10-25', partial: false, ...ZERO },
      { bucketStart: '2026-10-26', lastDay: '2026-11-01', partial: false, activeMs: 5 * HOUR, idleMs: 0, foregroundMs: 5 * HOUR, sessions: 9 },
      { bucketStart: '2026-11-02', lastDay: '2026-11-08', partial: false, ...ZERO },
      { bucketStart: '2026-11-09', lastDay: '2026-11-15', partial: true, ...ZERO },
    ]);
  });

  it('marks no week partial when the range is whole weeks', () => {
    const points = periodSeries([], { fromDay: '2026-11-02', toDay: '2026-11-15', bucket: 'week' });
    expect(points.map((point) => [point.bucketStart, point.partial])).toEqual([
      ['2026-11-02', false],
      ['2026-11-09', false],
    ]);
  });

  it('gives one point per month and marks a partial first and last month', () => {
    const points = periodSeries([], { fromDay: '2026-01-15', toDay: '2026-03-31', bucket: 'month' });
    expect(points.map((point) => [point.bucketStart, point.lastDay, point.partial])).toEqual([
      ['2026-01-01', '2026-01-31', true],
      ['2026-02-01', '2026-02-28', false],
      ['2026-03-01', '2026-03-31', false],
    ]);
    const cut = periodSeries([], { fromDay: '2025-12-01', toDay: '2026-02-10', bucket: 'month' });
    expect(cut.map((point) => [point.bucketStart, point.lastDay, point.partial])).toEqual([
      ['2025-12-01', '2025-12-31', false],
      ['2026-01-01', '2026-01-31', false],
      ['2026-02-01', '2026-02-28', true],
    ]);
  });

  it('starts at the first session when the report has no first day', () => {
    const rows = [
      row({ dimension: 'period', bucketStart: '2026-11-05', activeMs: HOUR, entryCount: 1 }),
      row({ dimension: 'period', bucketStart: '2026-11-03', activeMs: HOUR, entryCount: 1 }),
    ];
    const points = periodSeries(rows, { fromDay: null, toDay: '2026-11-06', bucket: 'day' });
    expect(points.map((point) => [point.bucketStart, point.activeMs, point.partial])).toEqual([
      ['2026-11-03', HOUR, false],
      ['2026-11-04', 0, false],
      ['2026-11-05', HOUR, false],
      ['2026-11-06', 0, false],
    ]);
    const weeks = periodSeries([row({ dimension: 'period', bucketStart: '2026-11-02', activeMs: HOUR })], {
      fromDay: null,
      toDay: '2026-11-13',
      bucket: 'week',
    });
    expect(weeks.map((point) => [point.bucketStart, point.partial])).toEqual([
      ['2026-11-02', false],
      ['2026-11-09', true],
    ]);
    expect(periodSeries([], { fromDay: null, toDay: '2026-11-06', bucket: 'day' })).toEqual([]);
  });

  it('turns points into chart data with Active, Idle and In foreground in the readout', () => {
    const weeks = periodSeries([row({ dimension: 'period', bucketStart: '2026-10-12', activeMs: 5 * HOUR + 5 * MINUTE, idleMs: 20 * MINUTE })], {
      fromDay: '2026-10-15',
      toDay: '2026-10-25',
      bucket: 'week',
    });
    expect(activityChartData(weeks, 'week', { today: TODAY, who: 'Carol' })).toEqual([
      {
        key: '2026-10-12',
        label: '12 Oct',
        value: 5 * HOUR + 5 * MINUTE,
        tooltip: {
          title: 'Week of 12 Oct',
          subtitle: 'Carol · Partial week',
          rows: [
            { id: 'active', label: 'Active', value: '5h 05m' },
            { id: 'idle', label: 'Idle', value: '20m' },
            { id: 'foreground', label: 'In foreground', value: '5h 25m' },
          ],
        },
      },
      {
        key: '2026-10-19',
        label: '19 Oct',
        value: 0,
        tooltip: {
          title: 'Week of 19 Oct',
          subtitle: 'Carol',
          rows: [
            { id: 'active', label: 'Active', value: '0m' },
            { id: 'idle', label: 'Idle', value: '0m' },
            { id: 'foreground', label: 'In foreground', value: '0m' },
          ],
        },
      },
    ]);

    const days = periodSeries([], { fromDay: '2026-11-08', toDay: '2026-11-08', bucket: 'day' });
    const [day] = activityChartData(days, 'day', { today: TODAY });
    expect(day?.label).toBe('8 Nov');
    expect(day?.tooltip.title).toBe('Sun 8 Nov');
    expect(day?.tooltip).not.toHaveProperty('subtitle');

    const months = periodSeries([], { fromDay: '2026-01-15', toDay: '2026-01-31', bucket: 'month' });
    const [thisYear] = activityChartData(months, 'month', { today: TODAY });
    expect(thisYear).toMatchObject({ label: 'Jan', tooltip: { title: 'January 2026', subtitle: 'Partial month' } });
    const [lastYear] = activityChartData(months, 'month', { today: '2027-01-05' });
    expect(lastYear).toMatchObject({ label: 'Jan 2026', tooltip: { title: 'January 2026' } });
  });
});

describe('labels', () => {
  it('names active members, and former members without inventing a name', () => {
    expect(LABELS.member(ME)).toEqual({ name: 'Ada', former: false });
    expect(LABELS.member('u-gone')).toEqual({ name: 'Bo (former member)', former: true });
    expect(LABELS.member('u-nobody')).toEqual({ name: 'Former member', former: true });
  });

  it('names projects, archived ones marked, and the two kinds of time without a project', () => {
    expect(LABELS.project('p1', false)).toEqual({ label: 'Brand refresh', archived: false });
    expect(LABELS.project('p3', false)).toEqual({ label: 'Zine (archived)', archived: true });
    expect(LABELS.project(null, true)).toEqual({ label: 'Unattributed', archived: false });
    expect(LABELS.project(null, false)).toEqual({ label: 'No project (task time)', archived: false });
  });

  it('names tasks with their status and own estimate, and time without a task', () => {
    expect(LABELS.task('t1', 'p1')).toEqual({ label: 'Logo, v2', archived: false, status: 'in_progress', estimateMinutes: 120 });
    expect(LABELS.task('t3', 'p1')).toEqual({ label: 'Old (archived)', archived: true, status: 'archived', estimateMinutes: null });
    expect(LABELS.task(null, 'p1')).toEqual({ label: 'No task', archived: false, status: null, estimateMinutes: null });
    expect(LABELS.task(null, null)).toEqual({ label: 'Unattributed', archived: false, status: null, estimateMinutes: null });
  });
});

describe('application items and colours', () => {
  const app = (applicationId: string, activeMinutes: number, extra: Partial<ReportRow> = {}) =>
    row({ dimension: 'application', applicationId, applicationName: applicationId.toUpperCase(), activeMs: activeMinutes * MINUTE, ...extra });

  it('gives each application a fixed slot in registry order, whatever its time', () => {
    const rows = [app('blender', 540), app('zzz-tool', 300), app('figma', 1), app('adobe-photoshop', 120), app('aaa-tool', 2)];
    const expected = [
      ['figma', 'var(--sp-series-1)'],
      ['adobe-photoshop', 'var(--sp-series-2)'],
      ['blender', 'var(--sp-series-3)'],
      // Applications outside the built-in registry come after it, by id.
      ['aaa-tool', 'var(--sp-series-4)'],
      ['zzz-tool', 'var(--sp-series-5)'],
    ];
    const sorted = (colors: Map<string, string>) => [...colors].sort((a, b) => a[1].localeCompare(b[1]));
    expect(sorted(applicationColors(rows))).toEqual(expected);
    // Re-ranked (the times reversed): nobody is repainted.
    const reranked = [app('blender', 1), app('zzz-tool', 2), app('figma', 540), app('adobe-photoshop', 3), app('aaa-tool', 300)];
    expect(sorted(applicationColors(reranked))).toEqual(expected);
  });

  it('uses all eight slots for eight applications, with none folded', () => {
    const ids = ['figma', 'adobe-illustrator', 'adobe-photoshop', 'affinity-designer', 'coreldraw', 'inkscape', 'adobe-after-effects', 'adobe-premiere-pro'];
    const colors = applicationColors(ids.map((id, index) => app(id, index + 1)));
    expect(ids.map((id) => colors.get(id))).toEqual([
      'var(--sp-series-1)',
      'var(--sp-series-2)',
      'var(--sp-series-3)',
      'var(--sp-series-4)',
      'var(--sp-series-5)',
      'var(--sp-series-6)',
      'var(--sp-series-7)',
      'var(--sp-series-8)',
    ]);
  });

  const NINE = [
    app('figma', 900),
    app('adobe-illustrator', 100),
    app('adobe-photoshop', 800),
    app('affinity-designer', 700),
    app('coreldraw', 600),
    app('inkscape', 50),
    app('adobe-after-effects', 500),
    app('adobe-premiere-pro', 400),
    app('davinci-resolve', 300),
  ];

  it('folds the smallest into Other past eight applications: seven keep a slot', () => {
    const colors = applicationColors(NINE);
    expect(Object.fromEntries(colors)).toEqual({
      figma: 'var(--sp-series-1)',
      'adobe-photoshop': 'var(--sp-series-2)',
      'affinity-designer': 'var(--sp-series-3)',
      coreldraw: 'var(--sp-series-4)',
      'adobe-after-effects': 'var(--sp-series-5)',
      'adobe-premiere-pro': 'var(--sp-series-6)',
      'davinci-resolve': 'var(--sp-series-7)',
      'adobe-illustrator': 'var(--sp-series-other)',
      inkscape: 'var(--sp-series-other)',
    });
    // Slots are never cycled or reused.
    const slots = [...colors.values()].filter((color) => color !== 'var(--sp-series-other)');
    expect(new Set(slots).size).toBe(7);
  });

  it('ignores rows without an application', () => {
    expect([...applicationColors([row({ dimension: 'application', applicationId: null, activeMs: HOUR }), app('figma', 1)])]).toEqual([
      ['figma', 'var(--sp-series-1)'],
    ]);
  });

  it('lists applications by active time, with their colours', () => {
    const items = applicationItems(NINE, applicationColors(NINE));
    expect(items.map((item) => [item.applicationId, item.color])).toEqual([
      ['figma', 'var(--sp-series-1)'],
      ['adobe-photoshop', 'var(--sp-series-2)'],
      ['affinity-designer', 'var(--sp-series-3)'],
      ['coreldraw', 'var(--sp-series-4)'],
      ['adobe-after-effects', 'var(--sp-series-5)'],
      ['adobe-premiere-pro', 'var(--sp-series-6)'],
      ['davinci-resolve', 'var(--sp-series-7)'],
      ['adobe-illustrator', 'var(--sp-series-other)'],
      ['inkscape', 'var(--sp-series-other)'],
    ]);
  });

  it('keeps an application’s colour when the report is filtered to it', () => {
    const colors = applicationColors(NINE);
    const filtered = [app('davinci-resolve', 300, { idleMs: 15 * MINUTE, entryCount: 3 })];
    expect(applicationItems(filtered, colors)).toEqual([
      {
        key: 'davinci-resolve',
        applicationId: 'davinci-resolve',
        label: 'DAVINCI-RESOLVE',
        color: 'var(--sp-series-7)',
        activeMs: 300 * MINUTE,
        idleMs: 15 * MINUTE,
        foregroundMs: 315 * MINUTE,
        sessions: 3,
      },
    ]);
  });

  it('breaks ties by foreground time, then name; falls back to the id and the neutral colour', () => {
    const rows = [
      app('b-app', 60, { applicationName: 'Beta' }),
      app('a-app', 60, { applicationName: 'Alpha' }),
      app('c-app', 60, { applicationName: null, idleMs: MINUTE }),
    ];
    const items = applicationItems(rows, new Map());
    expect(items.map((item) => item.label)).toEqual(['c-app', 'Alpha', 'Beta']);
    expect(items.map((item) => item.color)).toEqual(['var(--sp-series-other)', 'var(--sp-series-other)', 'var(--sp-series-other)']);
  });
});

describe('project, task and member items', () => {
  const projectRows = [
    row({ dimension: 'project', projectId: null, unattributed: true, activeMs: 10 * HOUR, entryCount: 6 }),
    row({ dimension: 'project', projectId: 'p1', unattributed: false, activeMs: HOUR, entryCount: 2 }),
    row({ dimension: 'project', projectId: null, unattributed: false, activeMs: 5 * HOUR, entryCount: 4 }),
    row({ dimension: 'project', projectId: 'p2', unattributed: false, activeMs: 3 * HOUR, idleMs: 30 * MINUTE, entryCount: 3 }),
    row({ dimension: 'project', projectId: 'p3', unattributed: false, activeMs: 2 * HOUR, entryCount: 1 }),
  ];

  it('lists projects by active time, then "No project (task time)", then "Unattributed" last', () => {
    expect(projectItems(projectRows, LABELS)).toEqual([
      { key: 'p2', kind: 'project', projectId: 'p2', label: 'Annual report', archived: false, activeMs: 3 * HOUR, idleMs: 30 * MINUTE, foregroundMs: 210 * MINUTE, sessions: 3 },
      { key: 'p3', kind: 'project', projectId: 'p3', label: 'Zine (archived)', archived: true, activeMs: 2 * HOUR, idleMs: 0, foregroundMs: 2 * HOUR, sessions: 1 },
      { key: 'p1', kind: 'project', projectId: 'p1', label: 'Brand refresh', archived: false, activeMs: HOUR, idleMs: 0, foregroundMs: HOUR, sessions: 2 },
      { key: 'no-project', kind: 'noProject', projectId: null, label: 'No project (task time)', archived: false, activeMs: 5 * HOUR, idleMs: 0, foregroundMs: 5 * HOUR, sessions: 4 },
      { key: 'unattributed', kind: 'unattributed', projectId: null, label: 'Unattributed', archived: false, activeMs: 10 * HOUR, idleMs: 0, foregroundMs: 10 * HOUR, sessions: 6 },
    ]);
  });

  it('reads the Unattributed tile from the row with no project and no task', () => {
    expect(unattributedTime(projectRows)).toEqual({ activeMs: 10 * HOUR, idleMs: 0, foregroundMs: 10 * HOUR, sessions: 6 });
    expect(unattributedTime(projectRows.filter((item) => item.unattributed !== true))).toEqual({ activeMs: 0, idleMs: 0, foregroundMs: 0, sessions: 0 });
  });

  it('lists tasks by active time, then time without a task, then "Unattributed" last', () => {
    const items = taskItems(
      [
        row({ dimension: 'task', projectId: null, taskId: null, activeMs: 100 * HOUR }),
        row({ dimension: 'task', projectId: 'p1', taskId: null, activeMs: 99 * HOUR }),
        row({ dimension: 'task', projectId: 'p1', taskId: 't1', activeMs: 10 * MINUTE, entryCount: 1 }),
        row({ dimension: 'task', projectId: null, taskId: 't2', activeMs: 30 * MINUTE }),
        row({ dimension: 'task', projectId: 'p1', taskId: 't3', activeMs: 50 * MINUTE }),
      ],
      LABELS,
    );
    expect(items.map((item) => [item.key, item.kind, item.label, item.projectLabel])).toEqual([
      ['p1:t3', 'task', 'Old (archived)', 'Brand refresh'],
      ['-:t2', 'task', '=cmd', 'No project (task time)'],
      ['p1:t1', 'task', 'Logo, v2', 'Brand refresh'],
      ['p1:-', 'noTask', 'No task', 'Brand refresh'],
      ['-:-', 'unattributed', 'Unattributed', 'Unattributed'],
    ]);
    expect(items[2]).toMatchObject({ taskId: 't1', projectId: 'p1', status: 'in_progress', estimateMinutes: 120, archived: false, activeMs: 10 * MINUTE, sessions: 1 });
    expect(items[0]).toMatchObject({ archived: true, status: 'archived', estimateMinutes: null });
  });

  const people = [
    { userId: 'u-zoe', displayName: 'Zoë' },
    { userId: 'u-al', displayName: 'alice' },
    { userId: 'u-bob', displayName: 'Bob' },
    { userId: 'u-sam2', displayName: 'Sam' },
    { userId: 'u-sam1', displayName: 'Sam' },
  ];
  const peopleLabels = createReportLabels({ projects: [], tasks: [], members: people, formerNames: new Map([['u-old', 'Aaron']]) });
  const ALPHABETICAL = ['u-al', 'u-bob', 'u-sam1', 'u-sam2', 'u-zoe', 'u-old', 'u-ghost'];

  it('lists people alphabetically by name, then id, former members last', () => {
    const rows = [
      row({ dimension: 'member', userId: 'u-zoe', activeMs: 9 * HOUR }),
      row({ dimension: 'member', userId: 'u-old', activeMs: 8 * HOUR }),
      row({ dimension: 'member', userId: 'u-ghost', activeMs: 7 * HOUR }),
      row({ dimension: 'member', userId: 'u-sam2', activeMs: 6 * HOUR }),
      row({ dimension: 'member', userId: 'u-al', activeMs: MINUTE, idleMs: MINUTE, entryCount: 1 }),
      row({ dimension: 'member', userId: 'u-bob', activeMs: 5 * HOUR }),
      row({ dimension: 'member', userId: 'u-sam1', activeMs: 4 * HOUR }),
      row({ dimension: 'member', userId: null, activeMs: 50 * HOUR }),
    ];
    const items = memberItems(rows, peopleLabels);
    expect(items.map((item) => item.userId)).toEqual(ALPHABETICAL);
    expect(items.map((item) => item.name)).toEqual(['alice', 'Bob', 'Sam', 'Sam', 'Zoë', 'Aaron (former member)', 'Former member']);
    expect(items.map((item) => item.former)).toEqual([false, false, false, false, false, true, true]);
    expect(items[0]).toEqual({ userId: 'u-al', name: 'alice', former: false, activeMs: MINUTE, idleMs: MINUTE, foregroundMs: 2 * MINUTE, sessions: 1 });
  });

  it('never orders people by time', () => {
    const times = [1, 500, 20, 3000, 7, 90, 250];
    for (let shift = 0; shift < times.length; shift += 1) {
      const rows = ALPHABETICAL.map((userId, index) =>
        row({ dimension: 'member', userId, activeMs: (times[(index + shift) % times.length] ?? 0) * MINUTE }),
      ).reverse();
      expect(memberItems(rows, peopleLabels).map((item) => item.userId)).toEqual(ALPHABETICAL);
    }
  });

  it('offers "Time of" as everyone, active members by name, then former members in the report', () => {
    const rows = [row({ dimension: 'member', userId: 'u-old' }), row({ dimension: 'member', userId: 'u-ghost' }), row({ dimension: 'member', userId: 'u-zoe' })];
    expect(timeOfOptions(people, rows, peopleLabels)).toEqual([
      { value: EVERYONE, label: 'Everyone you can see' },
      { value: 'u-al', label: 'alice' },
      { value: 'u-bob', label: 'Bob' },
      { value: 'u-sam1', label: 'Sam' },
      { value: 'u-sam2', label: 'Sam' },
      { value: 'u-zoe', label: 'Zoë' },
      { value: 'u-old', label: 'Aaron (former member)' },
      { value: 'u-ghost', label: 'Former member' },
    ]);
    const unnamed = [row({ dimension: 'member', userId: 'u-ghost-b' }), row({ dimension: 'member', userId: 'u-ghost-a' })];
    expect(timeOfOptions([], unnamed, peopleLabels)).toEqual([
      { value: '*', label: 'Everyone you can see' },
      { value: 'u-ghost-a', label: 'Former member 1' },
      { value: 'u-ghost-b', label: 'Former member 2' },
    ]);
  });

  it('offers the applications of the unfiltered report by name, keeping the selected one', () => {
    const rows = [
      row({ dimension: 'application', applicationId: 'figma', applicationName: 'Figma' }),
      row({ dimension: 'application', applicationId: 'blender', applicationName: 'Blender' }),
    ];
    expect(applicationOptions(rows, { id: 'houdini', name: 'Houdini' })).toEqual([
      { value: ALL, label: 'All applications' },
      { value: 'blender', label: 'Blender' },
      { value: 'figma', label: 'Figma' },
      { value: 'houdini', label: 'Houdini' },
    ]);
    expect(applicationOptions(rows, { id: 'figma' })).toHaveLength(3);
    expect(applicationOptions([], { id: 'houdini' })).toEqual([
      { value: '*', label: 'All applications' },
      { value: 'houdini', label: 'houdini' },
    ]);
    expect(applicationOptions([], null)).toEqual([{ value: '*', label: 'All applications' }]);
  });

  it('offers all projects, Unattributed, then each project with archived ones marked', () => {
    expect(projectFilterOptions(PROJECTS)).toEqual([
      { value: '*', label: 'All projects' },
      { value: 'unattributed', label: 'Unattributed' },
      { value: 'p1', label: 'Brand refresh' },
      { value: 'p2', label: 'Annual report' },
      { value: 'p3', label: 'Zine (archived)' },
      { value: 'p4', label: 'Empty' },
    ]);
  });

  it('encodes and decodes the project filter', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(encodeProjectFilter(ALL_PROJECTS)).toBe('*');
    expect(encodeProjectFilter({ kind: 'unattributed' })).toBe('unattributed');
    expect(encodeProjectFilter({ kind: 'project', id })).toBe(id);
    expect(decodeProjectFilter('*')).toEqual({ kind: 'all' });
    expect(decodeProjectFilter('unattributed')).toEqual({ kind: 'unattributed' });
    expect(decodeProjectFilter(id.toUpperCase())).toEqual({ kind: 'project', id });
    expect(decodeProjectFilter('not-a-project')).toEqual({ kind: 'all' });
  });
});

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

/** 02:00 UTC on the 13th: still the 12th in Los Angeles. */
const EARLY = Date.UTC(2026, 10, 13, 2);
const LA_TODAY = '2026-11-12';
const EVERY_TASK = { projectFilter: ALL_PROJECTS, assigneeId: null };

describe('task progress', () => {
  it('takes today from the reporting zone', () => {
    expect(reportingToday(EARLY, 'America/Los_Angeles')).toBe(LA_TODAY);
    expect(reportingToday(EARLY, 'UTC')).toBe('2026-11-13');
    expect(reportingToday(EARLY, 'Asia/Tokyo')).toBe('2026-11-13');
  });

  it('counts tasks by status without archived ones, with overdue, due soon and in review', () => {
    expect(summarizeTaskProgress(TASKS, { ...EVERY_TASK, today: LA_TODAY })).toEqual({
      counts: { inbox: 1, todo: 2, in_progress: 1, in_review: 2, done: 1 },
      total: 7,
      overdue: 2,
      dueSoon: 2,
      awaitingReview: 2,
    });
  });

  it('moves overdue and due soon with the reporting zone’s day', () => {
    // One day later (UTC): the task due on the 12th is now overdue, the one due on the 20th is within 7 days.
    const utc = summarizeTaskProgress(TASKS, { ...EVERY_TASK, today: reportingToday(EARLY, 'UTC') });
    expect(utc.overdue).toBe(3);
    expect(utc.dueSoon).toBe(2);
    const losAngeles = summarizeTaskProgress(TASKS, { ...EVERY_TASK, today: reportingToday(EARLY, 'America/Los_Angeles') });
    expect(losAngeles.overdue).toBe(2);
    expect(losAngeles.dueSoon).toBe(2);
  });

  it('counts a task due today or in exactly 7 days as due soon, in 8 days not, yesterday as overdue', () => {
    const due = (due_date: string, status: Task['status'] = 'todo') =>
      summarizeTaskProgress([task({ id: 'x', due_date, status })], { ...EVERY_TASK, today: LA_TODAY });
    expect(due('2026-11-12')).toMatchObject({ overdue: 0, dueSoon: 1 });
    expect(due('2026-11-19')).toMatchObject({ overdue: 0, dueSoon: 1 });
    expect(due('2026-11-20')).toMatchObject({ overdue: 0, dueSoon: 0 });
    expect(due('2026-11-11')).toMatchObject({ overdue: 1, dueSoon: 0 });
    expect(due('2026-11-11', 'done')).toMatchObject({ overdue: 0, dueSoon: 0, total: 1 });
    expect(due('2026-11-12', 'done')).toMatchObject({ overdue: 0, dueSoon: 0 });
    expect(due('2026-11-11', 'in_review')).toMatchObject({ overdue: 1, awaitingReview: 1 });
    expect(due('2026-11-11', 'archived')).toMatchObject({ overdue: 0, dueSoon: 0, total: 0 });
  });

  it('selects by project, by "Unattributed" (tasks without a project) and by person', () => {
    const ids = (selection: Parameters<typeof selectTasks>[1]) => selectTasks(TASKS, selection).map((item) => item.id);
    expect(ids(EVERY_TASK)).toEqual(['t1', 't2', 't4', 't5', 't6', 't7', 't8']);
    expect(ids({ projectFilter: { kind: 'project', id: 'p1' }, assigneeId: null })).toEqual(['t1', 't4', 't5']);
    expect(ids({ projectFilter: { kind: 'unattributed' }, assigneeId: null })).toEqual(['t2', 't7']);
    expect(ids({ projectFilter: ALL_PROJECTS, assigneeId: ME })).toEqual(['t1', 't2', 't4', 't6']);
    expect(ids({ projectFilter: { kind: 'project', id: 'p2' }, assigneeId: YOU })).toEqual(['t8']);
    expect(ids({ projectFilter: { kind: 'unattributed' }, assigneeId: YOU })).toEqual([]);
  });

  it('summarises a selection', () => {
    expect(summarizeTaskProgress(TASKS, { projectFilter: { kind: 'project', id: 'p1' }, assigneeId: null, today: LA_TODAY })).toEqual({
      counts: { inbox: 0, todo: 1, in_progress: 1, in_review: 1, done: 0 },
      total: 3,
      overdue: 1,
      dueSoon: 2,
      awaitingReview: 1,
    });
    expect(summarizeTaskProgress(TASKS, { projectFilter: { kind: 'unattributed' }, assigneeId: null, today: LA_TODAY })).toEqual({
      counts: { inbox: 1, todo: 1, in_progress: 0, in_review: 0, done: 0 },
      total: 2,
      overdue: 0,
      dueSoon: 0,
      awaitingReview: 0,
    });
    expect(summarizeTaskProgress(TASKS, { projectFilter: ALL_PROJECTS, assigneeId: ME, today: LA_TODAY })).toEqual({
      counts: { inbox: 0, todo: 2, in_progress: 1, in_review: 0, done: 1 },
      total: 4,
      overdue: 1,
      dueSoon: 1,
      awaitingReview: 0,
    });
    expect(summarizeTaskProgress(TASKS, { projectFilter: { kind: 'project', id: 'p2' }, assigneeId: YOU, today: LA_TODAY })).toEqual({
      counts: { inbox: 0, todo: 0, in_progress: 0, in_review: 1, done: 0 },
      total: 1,
      overdue: 1,
      dueSoon: 0,
      awaitingReview: 1,
    });
  });

  it('lists upcoming deadlines by due date: overdue first, then the next 7 days', () => {
    expect(upcomingDeadlines(TASKS, { ...EVERY_TASK, today: LA_TODAY }).map((item) => item.id)).toEqual(['t8', 't4', 't1', 't5']);
    expect(upcomingDeadlines(TASKS, { projectFilter: ALL_PROJECTS, assigneeId: ME, today: LA_TODAY }).map((item) => item.id)).toEqual(['t4', 't1']);
  });
});

describe('project progress rows', () => {
  const projectRows = [
    row({ dimension: 'project', projectId: 'p1', unattributed: false, activeMs: HOUR, entryCount: 2 }),
    row({ dimension: 'project', projectId: 'p2', unattributed: false, activeMs: 3 * HOUR, idleMs: 30 * MINUTE, entryCount: 3 }),
    row({ dimension: 'project', projectId: 'p3', unattributed: false, activeMs: 2 * HOUR, entryCount: 1 }),
    row({ dimension: 'project', projectId: null, unattributed: false, activeMs: 5 * HOUR, entryCount: 4 }),
    row({ dimension: 'project', projectId: null, unattributed: true, activeMs: 10 * HOUR, entryCount: 6 }),
  ];
  const input = { projects: PROJECTS, tasks: TASKS, labels: LABELS, today: LA_TODAY };

  it('pairs each project’s recorded time with its tasks done, in review and overdue', () => {
    expect(projectProgressRows({ ...input, selection: EVERY_TASK, projectRows })).toEqual([
      {
        key: 'p2',
        kind: 'project',
        projectId: 'p2',
        label: 'Annual report',
        archived: false,
        time: { activeMs: 3 * HOUR, idleMs: 30 * MINUTE, foregroundMs: 210 * MINUTE, sessions: 3 },
        tasksDone: 1,
        tasksTotal: 2,
        inReview: 1,
        overdue: 1,
      },
      {
        key: 'p3',
        kind: 'project',
        projectId: 'p3',
        label: 'Zine (archived)',
        archived: true,
        time: { activeMs: 2 * HOUR, idleMs: 0, foregroundMs: 2 * HOUR, sessions: 1 },
        tasksDone: 0,
        tasksTotal: 0,
        inReview: 0,
        overdue: 0,
      },
      {
        key: 'p1',
        kind: 'project',
        projectId: 'p1',
        label: 'Brand refresh',
        archived: false,
        time: { activeMs: HOUR, idleMs: 0, foregroundMs: HOUR, sessions: 2 },
        tasksDone: 0,
        tasksTotal: 3,
        inReview: 1,
        overdue: 1,
      },
      {
        key: 'no-project',
        kind: 'noProject',
        projectId: null,
        label: 'No project (task time)',
        archived: false,
        time: { activeMs: 5 * HOUR, idleMs: 0, foregroundMs: 5 * HOUR, sessions: 4 },
        tasksDone: 0,
        tasksTotal: 2,
        inReview: 0,
        overdue: 0,
      },
      {
        key: 'unattributed',
        kind: 'unattributed',
        projectId: null,
        label: 'Unattributed',
        archived: false,
        time: { activeMs: 10 * HOUR, idleMs: 0, foregroundMs: 10 * HOUR, sessions: 6 },
        tasksDone: 0,
        tasksTotal: 0,
        inReview: 0,
        overdue: 0,
      },
    ]);
  });

  it('is tasks only, by name and without any time, when teammates’ time is not visible', () => {
    const rows = projectProgressRows({ ...input, selection: EVERY_TASK, projectRows: null });
    expect(rows.map((item) => [item.key, item.label, item.time, item.tasksDone, item.tasksTotal, item.inReview, item.overdue])).toEqual([
      ['p2', 'Annual report', null, 1, 2, 1, 1],
      ['p1', 'Brand refresh', null, 0, 3, 1, 1],
      ['no-project', 'No project', null, 0, 2, 0, 0],
    ]);
  });

  it('follows the project and person selection', () => {
    const one = projectProgressRows({ ...input, selection: { projectFilter: { kind: 'project', id: 'p1' }, assigneeId: null }, projectRows });
    expect(one.map((item) => item.key)).toEqual(['p1']);
    const person = projectProgressRows({ ...input, selection: { projectFilter: ALL_PROJECTS, assigneeId: YOU }, projectRows: null });
    expect(person.map((item) => [item.key, item.tasksDone, item.tasksTotal, item.inReview, item.overdue])).toEqual([
      ['p2', 0, 1, 1, 1],
      ['p1', 0, 1, 1, 0],
    ]);
  });

  it('shows zero time for a project with tasks but no time in the range', () => {
    const rows = projectProgressRows({ ...input, selection: EVERY_TASK, projectRows: [] });
    expect(rows.map((item) => [item.key, item.time?.activeMs])).toEqual([
      ['p2', 0],
      ['p1', 0],
      ['no-project', 0],
    ]);
  });
});

describe('assigned projects', () => {
  const projectRows = [
    row({ dimension: 'project', projectId: 'p1', unattributed: false, activeMs: HOUR }),
    row({ dimension: 'project', projectId: 'p2', unattributed: false, activeMs: 3 * HOUR }),
    row({ dimension: 'project', projectId: null, unattributed: true, activeMs: 10 * HOUR }),
  ];

  it('lists the projects the viewer leads or has open tasks in, by name, archived ones left out', () => {
    expect(assignedProjects({ projects: PROJECTS, tasks: TASKS, me: ME, projectRows, projectFilter: ALL_PROJECTS })).toEqual([
      { projectId: 'p2', label: 'Annual report', lead: true, openTasks: 0, activeMs: 3 * HOUR },
      { projectId: 'p1', label: 'Brand refresh', lead: false, openTasks: 2, activeMs: HOUR },
    ]);
  });

  it('follows the page’s project filter: no other project, and no false "0m"', () => {
    const only = (projectFilter: ProjectFilter) => assignedProjects({ projects: PROJECTS, tasks: TASKS, me: ME, projectRows, projectFilter });
    // Project = Brand refresh: Annual report is not listed with 0m, it is not listed at all.
    expect(only({ kind: 'project', id: 'p1' })).toEqual([{ projectId: 'p1', label: 'Brand refresh', lead: false, openTasks: 2, activeMs: HOUR }]);
    // An archived project stays out even when it is the one chosen.
    expect(only({ kind: 'project', id: 'p3' })).toEqual([]);
    // Unattributed: no project has time under it, so none is shown (not "0m active").
    expect(only({ kind: 'unattributed' })).toEqual([
      { projectId: 'p2', label: 'Annual report', lead: true, openTasks: 0, activeMs: null },
      { projectId: 'p1', label: 'Brand refresh', lead: false, openTasks: 2, activeMs: null },
    ]);
  });

  it('shows no time where time is not shown, and zero where there is none', () => {
    expect(assignedProjects({ projects: PROJECTS, tasks: TASKS, me: ME, projectRows: null, projectFilter: ALL_PROJECTS }).map((item) => item.activeMs)).toEqual([null, null]);
    expect(assignedProjects({ projects: PROJECTS, tasks: TASKS, me: ME, projectRows: [], projectFilter: ALL_PROJECTS }).map((item) => item.activeMs)).toEqual([0, 0]);
  });

  it('counts only the viewer’s own open tasks', () => {
    expect(assignedProjects({ projects: PROJECTS, tasks: TASKS, me: YOU, projectRows: null, projectFilter: ALL_PROJECTS })).toEqual([
      { projectId: 'p2', label: 'Annual report', lead: false, openTasks: 1, activeMs: null },
      { projectId: 'p1', label: 'Brand refresh', lead: false, openTasks: 1, activeMs: null },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Exports: CSV cells and files
// ---------------------------------------------------------------------------------------------

describe('CSV', () => {
  it('quotes cells as RFC 4180 asks: only when needed, with quotes doubled', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(' padded ')).toBe(' padded ');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('carriage\rreturn')).toBe('"carriage\rreturn"');
    expect(csvCell('both\r\n')).toBe('"both\r\n"');
    expect(csvCell('')).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('neutralises text a spreadsheet would run: a leading = + - @ tab or CR gets an apostrophe', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\rcmd')).toBe('"\'\rcmd"');
    expect(csvCell('=1,2')).toBe('"\'=1,2"');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });

  it('leaves text alone when the character is not first', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('1+1')).toBe('1+1');
    expect(csvCell('e-mail')).toBe('e-mail');
    expect(csvCell('me@example.test')).toBe('me@example.test');
  });

  it('writes numbers untouched, negative ones too', () => {
    expect(csvCell(0)).toBe('0');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(1.5)).toBe('1.5');
    expect(csvCell({ csvNumber: '-1.500' })).toBe('-1.500');
    expect(csvCell({ csvNumber: '0.000' })).toBe('0.000');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('builds a file with a byte order mark and CRLF after every line, the last included', () => {
    expect(CSV_BOM).toBe('﻿');
    expect(toCsv(['a', 'b'], [])).toBe('﻿a,b\r\n');
    expect(
      toCsv(
        ['name', 'count'],
        [
          ['x', 1],
          [null, 'y,z'],
          ['=1', -2],
        ],
      ),
    ).toBe('﻿name,count\r\nx,1\r\n,"y,z"\r\n\'=1,-2\r\n');
  });
});

// ---------------------------------------------------------------------------------------------
// Exports: summary
// ---------------------------------------------------------------------------------------------

const SUMMARY_HEADER =
  'section,period_start,member_id,member,application_id,application,project_id,project,task_id,task,task_status,task_count,active_seconds,idle_seconds,foreground_seconds,sessions,time_zone';

/** The server's order: members by id, the rest by time. */
const SUMMARY_ROWS: readonly ReportRow[] = [
  row({ dimension: 'total', activeMs: 5_400_500, idleMs: 600_000, entryCount: 4, overlapMs: 60_000, teammatesVisible: true }),
  row({ dimension: 'period', bucketStart: '2026-11-12', activeMs: 3_600_000, entryCount: 2 }),
  row({ dimension: 'period', bucketStart: '2026-11-13', activeMs: 1_800_500, idleMs: 600_000, entryCount: 3 }),
  row({ dimension: 'member', userId: 'u-gone', activeMs: 3_000_000, entryCount: 1 }),
  row({ dimension: 'member', userId: YOU, activeMs: 2_000_000, entryCount: 1 }),
  row({ dimension: 'member', userId: 'u-unknown', activeMs: 400_000, entryCount: 1 }),
  row({ dimension: 'member', userId: ME, activeMs: 500, idleMs: 600_000, entryCount: 1 }),
  row({ dimension: 'project', projectId: 'p1', unattributed: false, activeMs: 3_600_000, entryCount: 2 }),
  row({ dimension: 'project', projectId: 'p3', unattributed: false, activeMs: 1_000_000, entryCount: 1 }),
  row({ dimension: 'project', projectId: null, unattributed: false, activeMs: 800_000, entryCount: 1 }),
  row({ dimension: 'project', projectId: null, unattributed: true, activeMs: 500, idleMs: 600_000, entryCount: 1 }),
  row({ dimension: 'task', projectId: 'p1', taskId: 't1', activeMs: 3_000_000, entryCount: 1 }),
  row({ dimension: 'task', projectId: 'p1', taskId: 't3', activeMs: 100_000, entryCount: 1 }),
  row({ dimension: 'task', projectId: 'p1', taskId: null, activeMs: 500_000, entryCount: 1 }),
  row({ dimension: 'task', projectId: null, taskId: 't2', activeMs: 800_000, entryCount: 1 }),
  row({ dimension: 'task', projectId: null, taskId: null, activeMs: 500, idleMs: 600_000, entryCount: 1 }),
  row({ dimension: 'application', applicationId: 'photoshop', applicationName: 'Adobe Photoshop', activeMs: 5_400_000, entryCount: 3 }),
  row({ dimension: 'application', applicationId: 'my-app', applicationName: '@Home, "Studio"', activeMs: 500, idleMs: 600_000, entryCount: 1 }),
];

const PROGRESS: TaskProgressSummary = {
  counts: { inbox: 1, todo: 2, in_progress: 1, in_review: 2, done: 1 },
  total: 7,
  overdue: 2,
  dueSoon: 3,
  awaitingReview: 2,
};

const SUMMARY_INPUT: SummaryExportInput = { rows: SUMMARY_ROWS, taskProgress: PROGRESS, labels: LABELS, timeZone: LONDON };

/** The lines of a CSV file without its byte order mark; the last element is the empty text after the final CRLF. */
function csvLines(text: string): string[] {
  expect(text.startsWith('﻿')).toBe(true);
  return text.slice(1).split('\r\n');
}

describe('summary export', () => {
  it('keeps the column order (append-only)', () => {
    expect(SUMMARY_COLUMNS.join(',')).toBe(SUMMARY_HEADER);
    expect(SUMMARY_COLUMNS).toHaveLength(17);
  });

  it('writes total, periods, people, projects, tasks, applications and task progress, in that order', () => {
    const tz = 'Europe/London';
    expect(csvLines(buildSummaryCsv(SUMMARY_INPUT))).toEqual([
      SUMMARY_HEADER,
      `total,,,,,,,,,,,,5400.500,600.000,6000.500,4,${tz}`,
      `period,2026-11-12,,,,,,,,,,,3600.000,0.000,3600.000,2,${tz}`,
      `period,2026-11-13,,,,,,,,,,,1800.500,600.000,2400.500,3,${tz}`,
      `member,,u-me,Ada,,,,,,,,,0.500,600.000,600.500,1,${tz}`,
      `member,,u-you,Carol,,,,,,,,,2000.000,0.000,2000.000,1,${tz}`,
      `member,,u-gone,Bo (former member),,,,,,,,,3000.000,0.000,3000.000,1,${tz}`,
      `member,,u-unknown,Former member,,,,,,,,,400.000,0.000,400.000,1,${tz}`,
      `project,,,,,,p1,Brand refresh,,,,,3600.000,0.000,3600.000,2,${tz}`,
      `project,,,,,,p3,Zine (archived),,,,,1000.000,0.000,1000.000,1,${tz}`,
      `project,,,,,,,No project (task time),,,,,800.000,0.000,800.000,1,${tz}`,
      `project,,,,,,,Unattributed,,,,,0.500,600.000,600.500,1,${tz}`,
      `task,,,,,,p1,Brand refresh,t1,"Logo, v2",in_progress,,3000.000,0.000,3000.000,1,${tz}`,
      `task,,,,,,p1,Brand refresh,t3,Old (archived),archived,,100.000,0.000,100.000,1,${tz}`,
      `task,,,,,,p1,Brand refresh,,No task,,,500.000,0.000,500.000,1,${tz}`,
      `task,,,,,,,No project (task time),t2,'=cmd,todo,,800.000,0.000,800.000,1,${tz}`,
      `task,,,,,,,Unattributed,,Unattributed,,,0.500,600.000,600.500,1,${tz}`,
      `application,,,,photoshop,Adobe Photoshop,,,,,,,5400.000,0.000,5400.000,3,${tz}`,
      `application,,,,my-app,"'@Home, ""Studio""",,,,,,,0.500,600.000,600.500,1,${tz}`,
      `task_status,,,,,,,,,,inbox,1,,,,,${tz}`,
      `task_status,,,,,,,,,,todo,2,,,,,${tz}`,
      `task_status,,,,,,,,,,in_progress,1,,,,,${tz}`,
      `task_status,,,,,,,,,,in_review,2,,,,,${tz}`,
      `task_status,,,,,,,,,,done,1,,,,,${tz}`,
      `task_status,,,,,,,,,,overdue,2,,,,,${tz}`,
      `task_status,,,,,,,,,,due_next_7_days,3,,,,,${tz}`,
      '',
    ]);
  });

  it('writes seconds with exactly three decimals and counts as whole numbers', () => {
    const one = (activeMs: number, idleMs: number) =>
      csvLines(buildSummaryCsv({ rows: [row({ dimension: 'total', activeMs, idleMs, entryCount: 12 })], taskProgress: null, labels: LABELS, timeZone: 'UTC' }))[1];
    expect(one(0, 0)).toBe('total,,,,,,,,,,,,0.000,0.000,0.000,12,UTC');
    expect(one(1, 0)).toBe('total,,,,,,,,,,,,0.001,0.000,0.001,12,UTC');
    expect(one(1_500, 250)).toBe('total,,,,,,,,,,,,1.500,0.250,1.750,12,UTC');
    expect(one(86_400_000, 999)).toBe('total,,,,,,,,,,,,86400.000,0.999,86400.999,12,UTC');
  });

  it('lists people alphabetically with former members last, never by time', () => {
    const members = summaryRecords(SUMMARY_INPUT).filter((record) => record.section === 'member');
    expect(members.map((record) => [record.member_id, record.member, record.active_seconds])).toEqual([
      ['u-me', 'Ada', 0.5],
      ['u-you', 'Carol', 2000],
      ['u-gone', 'Bo (former member)', 3000],
      ['u-unknown', 'Former member', 400],
    ]);
  });

  it('has only task_status rows in Workspace view when teammates’ time is not visible', () => {
    const input: SummaryExportInput = { rows: null, taskProgress: PROGRESS, labels: LABELS, timeZone: LONDON };
    expect(buildSummaryCsv(input)).toBe(
      '﻿' +
        `${SUMMARY_HEADER}\r\n` +
        'task_status,,,,,,,,,,inbox,1,,,,,Europe/London\r\n' +
        'task_status,,,,,,,,,,todo,2,,,,,Europe/London\r\n' +
        'task_status,,,,,,,,,,in_progress,1,,,,,Europe/London\r\n' +
        'task_status,,,,,,,,,,in_review,2,,,,,Europe/London\r\n' +
        'task_status,,,,,,,,,,done,1,,,,,Europe/London\r\n' +
        'task_status,,,,,,,,,,overdue,2,,,,,Europe/London\r\n' +
        'task_status,,,,,,,,,,due_next_7_days,3,,,,,Europe/London\r\n',
    );
    const records = summaryRecords(input);
    expect(records.map((record) => record.section)).toEqual(Array.from({ length: 7 }, () => 'task_status'));
    for (const record of records) {
      expect([record.member_id, record.member, record.active_seconds, record.idle_seconds, record.foreground_seconds, record.sessions]).toEqual([
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
    }
  });

  it('writes a total of zeros for an empty report, and only the header with nothing to export', () => {
    expect(buildSummaryCsv({ rows: [], taskProgress: null, labels: LABELS, timeZone: 'UTC' })).toBe(
      `﻿${SUMMARY_HEADER}\r\ntotal,,,,,,,,,,,,0.000,0.000,0.000,0,UTC\r\n`,
    );
    expect(buildSummaryCsv({ rows: null, taskProgress: null, labels: LABELS, timeZone: 'UTC' })).toBe(`﻿${SUMMARY_HEADER}\r\n`);
  });

  it('gives every line 17 cells', () => {
    // No cell of this report holds a line break, and quoted commas are removed before counting.
    const lines = csvLines(buildSummaryCsv(SUMMARY_INPUT)).slice(0, -1);
    expect(lines).toHaveLength(26);
    for (const line of lines) {
      expect(line.replace(/"(?:[^"]|"")*"/g, 'q').split(',')).toHaveLength(17);
    }
  });
});

describe('summary JSON', () => {
  const meta: SummaryExportMeta = {
    report: 'workspace-summary',
    workspace: { id: WS, name: 'Studio Pulse' },
    view: 'workspace',
    timeOf: { kind: 'everyone' },
    range: { from: '2026-11-07', to: '2026-11-13', timeZone: LONDON },
    filters: { project: { kind: 'project', id: 'p1', name: 'Brand refresh' }, applicationId: 'photoshop', applicationName: 'Adobe Photoshop' },
    bucket: 'day',
    generatedAt: '2026-11-13T12:00:00.000Z',
    teammatesVisible: true,
  };
  const text = buildSummaryJson(SUMMARY_INPUT, meta);
  const document = JSON.parse(text) as { meta: Record<string, unknown>; rows: Record<string, unknown>[] };

  it('carries format version 1, the request and the definitions in meta', () => {
    expect(Object.keys(document)).toEqual(['meta', 'rows']);
    expect(Object.keys(document.meta)).toEqual([
      'formatVersion',
      'report',
      'workspace',
      'view',
      'timeOf',
      'range',
      'filters',
      'bucket',
      'generatedAt',
      'teammatesVisible',
      'measurements',
      'notBillable',
      'manualTime',
      'reconciliation',
    ]);
    expect(document.meta.formatVersion).toBe(1);
    expect(document.meta.report).toBe('workspace-summary');
    expect(document.meta.workspace).toEqual({ id: WS, name: 'Studio Pulse' });
    expect(document.meta.view).toBe('workspace');
    expect(document.meta.timeOf).toEqual({ kind: 'everyone' });
    expect(document.meta.range).toEqual({ from: '2026-11-07', to: '2026-11-13', timeZone: 'Europe/London' });
    expect(document.meta.filters).toEqual({
      project: { kind: 'project', id: 'p1', name: 'Brand refresh' },
      applicationId: 'photoshop',
      applicationName: 'Adobe Photoshop',
    });
    expect(document.meta.bucket).toBe('day');
    expect(document.meta.generatedAt).toBe('2026-11-13T12:00:00.000Z');
    expect(document.meta.teammatesVisible).toBe(true);
  });

  it('says the time is not billable and that manual time is not available', () => {
    expect(document.meta.notBillable).toBe(true);
    expect(document.meta.manualTime).toBe('not available');
    expect(document.meta.measurements).toEqual({ ...MEASUREMENTS });
    expect(MEASUREMENTS.notBillable).toBe('Recorded application time — not billable.');
    expect(MEASUREMENTS.manualTime).toBe('Manual time entries aren’t available yet.');
    expect(MEASUREMENTS.inForeground).toBe('Active time plus idle time.');
    expect(MEASUREMENTS.unattributed).toBe('Time with no project and no task.');
    expect(typeof document.meta.reconciliation).toBe('string');
    expect(document.meta.reconciliation).toMatch(/each instant counts once/);
  });

  it('has the CSV’s rows under the CSV’s keys, in the CSV’s order, with seconds as numbers', () => {
    expect(document.rows).toHaveLength(25);
    for (const record of document.rows) {
      expect(Object.keys(record).join(',')).toBe(SUMMARY_HEADER);
    }
    expect(document.rows[0]).toEqual({
      section: 'total',
      period_start: null,
      member_id: null,
      member: null,
      application_id: null,
      application: null,
      project_id: null,
      project: null,
      task_id: null,
      task: null,
      task_status: null,
      task_count: null,
      active_seconds: 5400.5,
      idle_seconds: 600,
      foreground_seconds: 6000.5,
      sessions: 4,
      time_zone: 'Europe/London',
    });
    // Text is not neutralised in JSON: that is a spreadsheet concern.
    expect(document.rows[14]).toMatchObject({ section: 'task', task_id: 't2', task: '=cmd', task_status: 'todo', project: 'No project (task time)' });
    expect(document.rows[24]).toMatchObject({ section: 'task_status', task_status: 'due_next_7_days', task_count: 3, active_seconds: null });
    expect(document.rows).toEqual(JSON.parse(JSON.stringify(summaryRecords(SUMMARY_INPUT))));
  });

  it('is indented and ends with a line break', () => {
    expect(text.startsWith('{\n  "meta": {\n    "formatVersion": 1,\n')).toBe(true);
    expect(text.endsWith('\n}\n')).toBe(true);
  });

  it('exports task progress alone, with teammatesVisible null, when no time is exported', () => {
    const tasksOnly = JSON.parse(
      buildSummaryJson({ rows: null, taskProgress: PROGRESS, labels: LABELS, timeZone: LONDON }, { ...meta, teammatesVisible: null }),
    ) as { meta: Record<string, unknown>; rows: Record<string, unknown>[] };
    expect(tasksOnly.meta.teammatesVisible).toBeNull();
    expect(tasksOnly.meta.formatVersion).toBe(1);
    expect(tasksOnly.rows.map((record) => [record.section, record.task_status, record.task_count])).toEqual([
      ['task_status', 'inbox', 1],
      ['task_status', 'todo', 2],
      ['task_status', 'in_progress', 1],
      ['task_status', 'in_review', 2],
      ['task_status', 'done', 1],
      ['task_status', 'overdue', 2],
      ['task_status', 'due_next_7_days', 3],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Exports: my sessions
// ---------------------------------------------------------------------------------------------

const SESSION_HEADER =
  'id,started_at_utc,ended_at_utc,local_start,local_end,time_zone,application_id,application,kind,active_seconds,idle_seconds,project_id,project,task_id,task';

const LOS_ANGELES = 'America/Los_Angeles';

/** A session as PostgREST returns it: 23:30 to 00:45:00.5 UTC across midnight. */
function session(overrides: Partial<MySession> & Pick<MySession, 'id'>): MySession {
  return {
    started_at: '2026-11-12T23:30:00+00:00',
    ended_at: '2026-11-13T00:45:00.5+00:00',
    application_id: 'photoshop',
    application_name: 'Adobe Photoshop',
    kind: 'active',
    active_ms: 4_000_500,
    idle_ms: 499_500,
    project_id: null,
    task_id: null,
    ...overrides,
  };
}

const SESSIONS: readonly MySession[] = [
  session({ id: 's1', project_id: 'p1', task_id: 't1' }),
  session({ id: 's2', application_id: 'evil-app', application_name: '=Evil', kind: 'idle', active_ms: 0, idle_ms: 60_000 }),
  session({ id: 's3', task_id: 't2' }),
  session({ id: 's4', project_id: 'p3' }),
];

describe('local times with their offset', () => {
  it('writes ISO 8601 local time with the zone’s offset at that instant', () => {
    expect(formatLocalIso(Date.UTC(2026, 10, 3, 8), 'Europe/Paris')).toBe('2026-11-03T09:00:00.000+01:00');
    expect(formatLocalIso(Date.UTC(2026, 10, 13, 12), LONDON)).toBe('2026-11-13T12:00:00.000+00:00');
    expect(formatLocalIso(Date.UTC(2026, 6, 1, 12, 0, 0, 250), LONDON)).toBe('2026-07-01T13:00:00.250+01:00');
    expect(formatLocalIso(Date.UTC(2026, 10, 13, 2), LOS_ANGELES)).toBe('2026-11-12T18:00:00.000-08:00');
    expect(formatLocalIso(Date.UTC(2026, 6, 1, 2), LOS_ANGELES)).toBe('2026-06-30T19:00:00.000-07:00');
    expect(formatLocalIso(Date.UTC(2026, 0, 1), 'UTC')).toBe('2026-01-01T00:00:00.000+00:00');
    expect(formatLocalIso(Date.UTC(2026, 11, 31, 23, 59, 59, 999), 'Asia/Tokyo')).toBe('2027-01-01T08:59:59.999+09:00');
  });

  it('handles offsets that are not whole hours', () => {
    expect(formatLocalIso(Date.UTC(2026, 0, 1), 'Asia/Kolkata')).toBe('2026-01-01T05:30:00.000+05:30');
    expect(formatLocalIso(Date.UTC(2026, 0, 1), 'Asia/Kathmandu')).toBe('2026-01-01T05:45:00.000+05:45');
    expect(formatLocalIso(Date.UTC(2026, 0, 1, 12), 'America/St_Johns')).toBe('2026-01-01T08:30:00.000-03:30');
  });

  it('tells the two 01:30s apart on the night the clocks go back', () => {
    expect(formatLocalIso(Date.UTC(2026, 9, 25, 0, 30), LONDON)).toBe('2026-10-25T01:30:00.000+01:00');
    expect(formatLocalIso(Date.UTC(2026, 9, 25, 1, 30), LONDON)).toBe('2026-10-25T01:30:00.000+00:00');
  });
});

describe('sessions export', () => {
  it('keeps the column order (append-only)', () => {
    expect(SESSION_COLUMNS.join(',')).toBe(SESSION_HEADER);
    expect(SESSION_COLUMNS).toHaveLength(15);
  });

  it('writes one line per session, in the order given, with UTC and local times', () => {
    const utc = '2026-11-12T23:30:00.000Z,2026-11-13T00:45:00.500Z';
    const local = '2026-11-12T15:30:00.000-08:00,2026-11-12T16:45:00.500-08:00,America/Los_Angeles';
    expect(csvLines(buildSessionsCsv(SESSIONS, LABELS, LOS_ANGELES))).toEqual([
      SESSION_HEADER,
      `s1,${utc},${local},photoshop,Adobe Photoshop,active,4000.500,499.500,p1,Brand refresh,t1,"Logo, v2"`,
      `s2,${utc},${local},evil-app,'=Evil,idle,0.000,60.000,,Unattributed,,Unattributed`,
      `s3,${utc},${local},photoshop,Adobe Photoshop,active,4000.500,499.500,,No project (task time),t2,'=cmd`,
      `s4,${utc},${local},photoshop,Adobe Photoshop,active,4000.500,499.500,p3,Zine (archived),,No task`,
      '',
    ]);
  });

  it('writes the same sessions in another reporting zone with that zone’s local times', () => {
    expect(sessionRecords(SESSIONS.slice(0, 1), LABELS, LONDON)).toEqual([
      {
        id: 's1',
        started_at_utc: '2026-11-12T23:30:00.000Z',
        ended_at_utc: '2026-11-13T00:45:00.500Z',
        local_start: '2026-11-12T23:30:00.000+00:00',
        local_end: '2026-11-13T00:45:00.500+00:00',
        time_zone: 'Europe/London',
        application_id: 'photoshop',
        application: 'Adobe Photoshop',
        kind: 'active',
        active_seconds: 4000.5,
        idle_seconds: 499.5,
        project_id: 'p1',
        project: 'Brand refresh',
        task_id: 't1',
        task: 'Logo, v2',
      },
    ]);
    const tokyo = sessionRecords(SESSIONS.slice(0, 1), LABELS, 'Asia/Tokyo')[0];
    expect([tokyo?.local_start, tokyo?.local_end, tokyo?.time_zone]).toEqual([
      '2026-11-13T08:30:00.000+09:00',
      '2026-11-13T09:45:00.500+09:00',
      'Asia/Tokyo',
    ]);
  });

  it('exports sessions whole: a session that began before the range keeps its full time', () => {
    const long = session({ id: 'long', started_at: '2026-11-06T22:00:00+00:00', ended_at: '2026-11-07T02:00:00+00:00', active_ms: 14_400_000, idle_ms: 0 });
    const [record] = sessionRecords([long], LABELS, LONDON);
    expect(record).toMatchObject({
      started_at_utc: '2026-11-06T22:00:00.000Z',
      ended_at_utc: '2026-11-07T02:00:00.000Z',
      active_seconds: 14400,
      idle_seconds: 0,
    });
  });

  it('writes only the header without sessions', () => {
    expect(buildSessionsCsv([], LABELS, LONDON)).toBe(`﻿${SESSION_HEADER}\r\n`);
  });

  it('writes JSON with format version 1, the not-billable note and the CSV’s keys', () => {
    const text = buildSessionsJson(SESSIONS, LABELS, {
      workspace: { id: WS, name: 'Studio Pulse' },
      range: { from: '2026-11-07', to: '2026-11-13', timeZone: LOS_ANGELES },
      filters: { project: { kind: 'project', id: 'p1', name: 'Brand refresh' }, applicationId: 'figma', applicationName: 'Figma', unattributedOnly: false },
      generatedAt: '2026-11-13T12:00:00.000Z',
    });
    expect(text.endsWith('\n}\n')).toBe(true);
    const document = JSON.parse(text) as { meta: Record<string, unknown>; rows: Record<string, unknown>[] };
    expect(Object.keys(document.meta)).toEqual([
      'formatVersion',
      'report',
      'workspace',
      'range',
      'filters',
      'generatedAt',
      'sessions',
      'measurements',
      'notBillable',
      'manualTime',
    ]);
    expect(document.meta).toMatchObject({
      formatVersion: 1,
      report: 'my-sessions',
      workspace: { id: WS, name: 'Studio Pulse' },
      range: { from: '2026-11-07', to: '2026-11-13', timeZone: 'America/Los_Angeles' },
      // The page's filters the sessions follow, recorded as the summary records them.
      filters: { project: { kind: 'project', id: 'p1', name: 'Brand refresh' }, applicationId: 'figma', applicationName: 'Figma', unattributedOnly: false },
      generatedAt: '2026-11-13T12:00:00.000Z',
      notBillable: true,
      manualTime: 'not available',
    });
    expect(document.meta.sessions).toBe(
      'Your own sessions overlapping the range and matching the filters, whole (not clipped to the range) and not reconciled, so they can add up to more than the summary.',
    );
    expect(document.rows).toHaveLength(4);
    for (const record of document.rows) {
      expect(Object.keys(record).join(',')).toBe(SESSION_HEADER);
    }
    expect(document.rows[1]).toEqual({
      id: 's2',
      started_at_utc: '2026-11-12T23:30:00.000Z',
      ended_at_utc: '2026-11-13T00:45:00.500Z',
      local_start: '2026-11-12T15:30:00.000-08:00',
      local_end: '2026-11-12T16:45:00.500-08:00',
      time_zone: 'America/Los_Angeles',
      application_id: 'evil-app',
      application: '=Evil',
      kind: 'idle',
      active_seconds: 0,
      idle_seconds: 60,
      project_id: null,
      project: 'Unattributed',
      task_id: null,
      task: 'Unattributed',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Exports: file names
// ---------------------------------------------------------------------------------------------

describe('when an export can be written', () => {
  const ready = { showsTime: true, report: true, taskProgress: true, projects: true, tasks: true, formerNamesPending: false };

  it('waits for the report, or for the task progress where no time is shown', () => {
    expect(exportReady(ready)).toBe(true);
    expect(exportReady({ ...ready, report: false })).toBe(false);
    expect(exportReady({ ...ready, showsTime: false, report: false })).toBe(true);
    expect(exportReady({ ...ready, showsTime: false, taskProgress: false })).toBe(false);
  });

  it('waits for the names the file is labelled with: never "Unknown project" for one still loading', () => {
    // The report came first (cached or fast) while the project or task list is still paging.
    expect(exportReady({ ...ready, projects: false })).toBe(false);
    expect(exportReady({ ...ready, tasks: false })).toBe(false);
    expect(exportReady({ ...ready, showsTime: false, tasks: false })).toBe(false);
    expect(exportReady({ ...ready, formerNamesPending: true })).toBe(false);
    // Once they are in, it can.
    expect(exportReady({ ...ready, projects: true, tasks: true, formerNamesPending: false })).toBe(true);
  });
});

describe('export file names', () => {
  it('slugs a workspace name to [a-z0-9-], at most 40 characters', () => {
    expect(workspaceSlug('Studio Pulse')).toBe('studio-pulse');
    expect(workspaceSlug('  --Hello__World--  ')).toBe('hello-world');
    expect(workspaceSlug('Café Noir!')).toBe('cafe-noir');
    expect(workspaceSlug('Ünïcødé & Co.')).toBe('unic-de-co');
    expect(workspaceSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(workspaceSlug('R&D 2026')).toBe('r-d-2026');
    expect(workspaceSlug('a'.repeat(50))).toBe('a'.repeat(40));
  });

  it('does not end a shortened slug with a hyphen', () => {
    expect(workspaceSlug('abcdefghi '.repeat(5))).toBe('abcdefghi-abcdefghi-abcdefghi-abcdefghi');
  });

  it('falls back to "workspace" when nothing usable is left', () => {
    expect(workspaceSlug('')).toBe('workspace');
    expect(workspaceSlug('   ')).toBe('workspace');
    expect(workspaceSlug('日本語')).toBe('workspace');
    expect(workspaceSlug('!!!')).toBe('workspace');
  });

  it('names files studio-pulse_<slug>_<report>_<from>_to_<to>.<format>', () => {
    const days = { fromDay: '2026-11-07', toDay: '2026-11-13' };
    expect(exportFileName({ workspaceName: 'Studio Pulse', report: 'my-summary', format: 'csv', ...days })).toBe(
      'studio-pulse_studio-pulse_my-summary_2026-11-07_to_2026-11-13.csv',
    );
    expect(exportFileName({ workspaceName: 'Café Noir!', report: 'workspace-summary', format: 'json', ...days })).toBe(
      'studio-pulse_cafe-noir_workspace-summary_2026-11-07_to_2026-11-13.json',
    );
    expect(exportFileName({ workspaceName: '日本語', report: 'my-sessions', format: 'csv', fromDay: '2026-11-13', toDay: '2026-11-13' })).toBe(
      'studio-pulse_workspace_my-sessions_2026-11-13_to_2026-11-13.csv',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

describe('footnote', () => {
  it('says what the time is, and names the overlap only when there is some', () => {
    expect(analyticsFootnote(0)).toBe(
      'Recorded application time — not billable. Manual time entries aren’t available yet. Overlapping time from several devices is counted once. Sessions appear after they end and sync. Applications hidden in a device’s reports still appear here.',
    );
    expect(analyticsFootnote(2 * HOUR + 5 * MINUTE)).toBe(
      'Recorded application time — not billable. Manual time entries aren’t available yet. Overlapping time from several devices is counted once (2h 05m overlapped). Sessions appear after they end and sync. Applications hidden in a device’s reports still appear here.',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Saved preferences
// ---------------------------------------------------------------------------------------------

const DEFAULTS = {
  version: 1,
  view: 'mine',
  range: { preset: 'last7' },
  bucket: 'auto',
  timeZone: null,
  projectFilter: { kind: 'all' },
  applicationId: null,
  projectInsightsRange: 'all',
  presets: [],
};

const DEFAULTS_JSON =
  '{"version":1,"view":"mine","range":{"preset":"last7"},"bucket":"auto","timeZone":null,"projectFilter":{"kind":"all"},"applicationId":null,"projectInsightsRange":"all","presets":[]}';

const PROJECT_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** A stored saved view; `extra` overrides or adds members. */
function storedView(id: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name, view: 'mine', range: { preset: 'last7' }, bucket: 'auto', projectFilter: { kind: 'all' }, applicationId: null, ...extra };
}

const WEEKLY: SavedView = {
  id: 'v1',
  name: 'Weekly review',
  view: 'workspace',
  range: { preset: 'last30' },
  bucket: 'week',
  projectFilter: { kind: 'unattributed' },
  applicationId: 'photoshop',
};

describe('preferences: reading', () => {
  it('keys them per person and workspace', () => {
    expect(preferencesKey(ME, WS)).toBe('studio-pulse:analytics:u-me:00000000-0000-4000-8000-000000000001');
  });

  it('starts from My work, the last 7 days, automatic buckets and the browser’s zone', () => {
    expect(DEFAULT_PREFERENCES).toEqual(DEFAULTS);
    expect(MAX_SAVED_VIEWS).toBe(20);
  });

  it('gives the defaults for anything that is not an object', () => {
    for (const value of [null, undefined, 'text', 42, true, [], [DEFAULTS]]) {
      expect(validatePreferences(value)).toEqual(DEFAULTS);
    }
  });

  it('drops each invalid field and keeps the valid ones', () => {
    expect(
      validatePreferences({
        version: 7,
        view: 'workspace',
        range: { preset: 'bogus' },
        bucket: 'week',
        timeZone: 'Mars/Olympus',
        projectFilter: { kind: 'project', id: 'not-a-uuid' },
        applicationId: 'photoshop',
        projectInsightsRange: 'last90',
        presets: 'nope',
      }),
    ).toEqual({
      version: 1,
      view: 'workspace',
      range: { preset: 'last7' },
      bucket: 'week',
      timeZone: null,
      projectFilter: { kind: 'all' },
      applicationId: 'photoshop',
      projectInsightsRange: 'last90',
      presets: [],
    });
    expect(
      validatePreferences({
        view: 'everyone',
        range: { preset: 'custom', customFrom: '2026-01-01', customTo: '2026-03-31' },
        bucket: 'hour',
        timeZone: 'America/Los_Angeles',
        projectFilter: { kind: 'project', id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
        applicationId: 'Bad Id!',
        projectInsightsRange: 'last365',
      }),
    ).toEqual({
      version: 1,
      view: 'mine',
      range: { preset: 'custom', customFrom: '2026-01-01', customTo: '2026-03-31' },
      bucket: 'auto',
      timeZone: 'America/Los_Angeles',
      projectFilter: { kind: 'project', id: PROJECT_UUID },
      applicationId: null,
      projectInsightsRange: 'all',
      presets: [],
    });
    expect(validatePreferences({})).toEqual(DEFAULTS);
  });

  it('keeps a saved range only if the report would accept it', () => {
    const range = (value: unknown) => validatePreferences({ range: value }).range;
    const fallback = { preset: 'last7' };
    expect(range({ preset: 'today' })).toEqual({ preset: 'today' });
    expect(range({ preset: 'yesterday', customFrom: '2026-01-01', customTo: '2026-01-02' })).toEqual({ preset: 'yesterday' });
    expect(range({ preset: 'last30' })).toEqual({ preset: 'last30' });
    expect(range({ preset: 'custom', customFrom: '2020-01-01', customTo: '2020-01-05' })).toEqual({
      preset: 'custom',
      customFrom: '2020-01-01',
      customTo: '2020-01-05',
    });
    // 1 January 2025 to 1 January 2026 is 366 days; one more is too many.
    expect(range({ preset: 'custom', customFrom: '2025-01-01', customTo: '2026-01-01' })).toEqual({
      preset: 'custom',
      customFrom: '2025-01-01',
      customTo: '2026-01-01',
    });
    expect(range({ preset: 'custom', customFrom: '2025-01-01', customTo: '2026-01-02' })).toEqual(fallback);
    expect(range({ preset: 'custom' })).toEqual(fallback);
    expect(range({ preset: 'custom', customFrom: '2026-02-30', customTo: '2026-03-01' })).toEqual(fallback);
    expect(range({ preset: 'custom', customFrom: '2026-03-02', customTo: '2026-03-01' })).toEqual(fallback);
    expect(range({ preset: 'custom', customFrom: '2019-12-31', customTo: '2020-01-05' })).toEqual(fallback);
    expect(range({ preset: 'custom', customFrom: '2099-12-30', customTo: '2100-01-01' })).toEqual(fallback);
    expect(range({ preset: 'custom', customFrom: 20260101, customTo: 20260102 })).toEqual(fallback);
    expect(range('last30')).toEqual(fallback);
    expect(range(null)).toEqual(fallback);
  });

  it('keeps a reporting zone only if it is an IANA zone or UTC', () => {
    const zone = (value: unknown) => validatePreferences({ timeZone: value }).timeZone;
    expect(zone('Europe/London')).toBe('Europe/London');
    expect(zone('UTC')).toBe('UTC');
    expect(zone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(zone('UTC+3')).toBeNull();
    expect(zone('CET')).toBeNull();
    expect(zone('Mars/Olympus')).toBeNull();
    expect(zone('')).toBeNull();
    expect(zone(60)).toBeNull();
    expect(zone(null)).toBeNull();
    expect(isReportTimeZone('Europe/London')).toBe(true);
    expect(isReportTimeZone('UTC')).toBe(true);
    expect(isReportTimeZone('UTC+3')).toBe(false);
    expect(isReportTimeZone('CET')).toBe(false);
    expect(isReportTimeZone('Mars/Olympus')).toBe(false);
    expect(isReportTimeZone(null)).toBe(false);
  });

  it('keeps the project filter kinds, and a project only by a real id', () => {
    const filter = (value: unknown) => validatePreferences({ projectFilter: value }).projectFilter;
    expect(filter({ kind: 'all' })).toEqual({ kind: 'all' });
    expect(filter({ kind: 'unattributed' })).toEqual({ kind: 'unattributed' });
    expect(filter({ kind: 'project', id: PROJECT_UUID })).toEqual({ kind: 'project', id: PROJECT_UUID });
    expect(filter({ kind: 'project' })).toEqual({ kind: 'all' });
    expect(filter({ kind: 'project', id: 7 })).toEqual({ kind: 'all' });
    expect(filter({ kind: 'person', id: PROJECT_UUID })).toEqual({ kind: 'all' });
    expect(filter('unattributed')).toEqual({ kind: 'all' });
  });

  it('never carries a person: unknown members are left behind at every level', () => {
    const stored = {
      ...DEFAULTS,
      view: 'workspace',
      personId: YOU,
      person: YOU,
      memberId: YOU,
      userIds: [YOU],
      timeOf: { kind: 'person', userId: YOU },
      range: { preset: 'last30', personId: YOU },
      projectFilter: { kind: 'unattributed', userId: YOU },
      presets: [storedView('v1', 'Carol’s week', { view: 'workspace', personId: YOU, userIds: [YOU], timeOf: YOU })],
    };
    const result = validatePreferences(stored);
    expect(Object.keys(result)).toEqual([
      'version',
      'view',
      'range',
      'bucket',
      'timeZone',
      'projectFilter',
      'applicationId',
      'projectInsightsRange',
      'presets',
    ]);
    expect(result.range).toEqual({ preset: 'last30' });
    expect(result.projectFilter).toEqual({ kind: 'unattributed' });
    expect(result.presets).toEqual([
      { id: 'v1', name: 'Carol’s week', view: 'workspace', range: { preset: 'last7' }, bucket: 'auto', projectFilter: { kind: 'all' }, applicationId: null },
    ]);
    expect(JSON.stringify(result)).not.toContain('u-you');
    expect(serializePreferences(stored as unknown as AnalyticsPreferences)).not.toContain('u-you');
    expect(serializePreferences(stored as unknown as AnalyticsPreferences)).not.toMatch(/person|member|userId|timeOf/);
  });

  it('drops invalid saved views and keeps the valid ones, names trimmed', () => {
    const result = validatePreferences({
      presets: [
        storedView('a', '  Week  '),
        storedView('b', ''),
        storedView('c', '   '),
        storedView('d', 'x'.repeat(61)),
        storedView('e', 'y'.repeat(60)),
        storedView('', 'No id'),
        storedView('f', 'Bad view', { view: 'team' }),
        storedView('g', 'Bad range', { range: { preset: 'custom', customFrom: '2026-03-02', customTo: '2026-03-01' } }),
        storedView('h', 'Bad bucket', { bucket: 'hour' }),
        storedView('i', 'Bad filter', { projectFilter: { kind: 'project', id: 'x' } }),
        storedView('j', 'Bad application', { applicationId: 'Bad Id!' }),
        storedView('a', 'Same id again'),
        { id: 'k', name: 42 },
        'text',
        null,
        42,
        storedView('l', 'Custom', {
          view: 'workspace',
          range: { preset: 'custom', customFrom: '2026-01-01', customTo: '2026-01-31' },
          bucket: 'week',
          projectFilter: { kind: 'project', id: PROJECT_UUID },
          applicationId: 'photoshop',
        }),
      ],
    });
    expect(result.presets).toEqual([
      { id: 'a', name: 'Week', view: 'mine', range: { preset: 'last7' }, bucket: 'auto', projectFilter: { kind: 'all' }, applicationId: null },
      { id: 'e', name: 'y'.repeat(60), view: 'mine', range: { preset: 'last7' }, bucket: 'auto', projectFilter: { kind: 'all' }, applicationId: null },
      {
        id: 'l',
        name: 'Custom',
        view: 'workspace',
        range: { preset: 'custom', customFrom: '2026-01-01', customTo: '2026-01-31' },
        bucket: 'week',
        projectFilter: { kind: 'project', id: PROJECT_UUID },
        applicationId: 'photoshop',
      },
    ]);
  });

  it('keeps at most 20 saved views: the first 20', () => {
    const many = Array.from({ length: 25 }, (_unused, index) => storedView(`v${index + 1}`, `View ${index + 1}`));
    const result = validatePreferences({ presets: many });
    expect(result.presets).toHaveLength(20);
    expect(result.presets[0]?.id).toBe('v1');
    expect(result.presets[19]?.id).toBe('v20');
  });

  it('reads stored text, and gives the defaults for text it cannot read', () => {
    expect(parsePreferences(null)).toEqual(DEFAULTS);
    for (const text of ['', 'not json', '{oops', '[]', '"text"', 'null', '42']) {
      expect(parsePreferences(text)).toEqual(DEFAULTS);
    }
    expect(parsePreferences('{"view":"workspace","bucket":"month","timeZone":"UTC","extra":1}')).toEqual({
      ...DEFAULTS,
      view: 'workspace',
      bucket: 'month',
      timeZone: 'UTC',
    });
  });
});

describe('preferences: writing', () => {
  const preferences: AnalyticsPreferences = {
    version: 1,
    view: 'workspace',
    range: { preset: 'custom', customFrom: '2026-10-01', customTo: '2026-10-31' },
    bucket: 'week',
    timeZone: 'Europe/London',
    projectFilter: { kind: 'project', id: PROJECT_UUID },
    applicationId: 'photoshop',
    projectInsightsRange: 'last30',
    presets: [WEEKLY],
  };
  const preferencesJson =
    '{"version":1,"view":"workspace","range":{"preset":"custom","customFrom":"2026-10-01","customTo":"2026-10-31"},"bucket":"week","timeZone":"Europe/London","projectFilter":{"kind":"project","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},"applicationId":"photoshop","projectInsightsRange":"last30","presets":[{"id":"v1","name":"Weekly review","view":"workspace","range":{"preset":"last30"},"bucket":"week","projectFilter":{"kind":"unattributed"},"applicationId":"photoshop"}]}';
  const KEY = 'studio-pulse:analytics:u-me:00000000-0000-4000-8000-000000000001';

  it('serialises to JSON and reads back the same', () => {
    expect(serializePreferences(DEFAULT_PREFERENCES)).toBe(DEFAULTS_JSON);
    expect(serializePreferences(preferences)).toBe(preferencesJson);
    expect(parsePreferences(preferencesJson)).toEqual(preferences);
  });

  it('validates on the way out too', () => {
    const broken = { ...preferences, bucket: 'hour', presets: [WEEKLY, { ...WEEKLY, id: 'v2', name: '' }] } as unknown as AnalyticsPreferences;
    expect(JSON.parse(serializePreferences(broken))).toEqual({ ...preferences, bucket: 'auto' });
  });

  it('stores under the person’s and workspace’s key and reads back', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(readPreferences(storage, ME, WS)).toEqual(DEFAULTS);
    expect(writePreferences(storage, ME, WS, preferences)).toBe(true);
    expect([...store.entries()]).toEqual([[KEY, preferencesJson]]);
    expect(readPreferences(storage, ME, WS)).toEqual(preferences);
    // Another person on this browser, or another workspace, has their own.
    expect(readPreferences(storage, YOU, WS)).toEqual(DEFAULTS);
    expect(readPreferences(storage, ME, 'other-workspace')).toEqual(DEFAULTS);
    store.set(KEY, '{oops');
    expect(readPreferences(storage, ME, WS)).toEqual(DEFAULTS);
  });

  it('survives a storage that throws, and no storage at all', () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
      setItem: (): void => {
        throw new Error('quota exceeded');
      },
    };
    expect(readPreferences(throwing, ME, WS)).toEqual(DEFAULTS);
    expect(writePreferences(throwing, ME, WS, preferences)).toBe(false);
    expect(readPreferences(null, ME, WS)).toEqual(DEFAULTS);
    expect(writePreferences(null, ME, WS, preferences)).toBe(false);
  });
});

describe('saved views', () => {
  const fields = {
    view: 'workspace',
    range: { preset: 'last30' },
    bucket: 'week',
    projectFilter: { kind: 'unattributed' },
    applicationId: 'photoshop',
  } as const;

  function mustSave(preferences: AnalyticsPreferences, input: Parameters<typeof saveView>[1]): AnalyticsPreferences {
    const result = saveView(preferences, input);
    if (!result.ok) throw new Error(result.message);
    return result.preferences;
  }

  const full = Array.from({ length: 20 }, (_unused, index) => ({ ...WEEKLY, id: `v${index + 1}`, name: `View ${index + 1}` }));

  it('accepts names of 1 to 60 characters, trimmed', () => {
    expect(validateSavedViewName('a')).toEqual({ ok: true, value: 'a' });
    expect(validateSavedViewName('  Weekly review ')).toEqual({ ok: true, value: 'Weekly review' });
    expect(validateSavedViewName('x'.repeat(60))).toEqual({ ok: true, value: 'x'.repeat(60) });
    expect(validateSavedViewName(` ${'x'.repeat(60)} `)).toEqual({ ok: true, value: 'x'.repeat(60) });
    expect(validateSavedViewName('x'.repeat(61))).toEqual({ ok: false, message: 'Use at most 60 characters.' });
    expect(validateSavedViewName('')).toEqual({ ok: false, message: 'Name the view.' });
    expect(validateSavedViewName('   ')).toEqual({ ok: false, message: 'Name the view.' });
  });

  it('saves the current filters under a name', () => {
    expect(saveView(DEFAULT_PREFERENCES, { ...fields, id: 'v1', name: '  Weekly review ' })).toEqual({
      ok: true,
      preferences: {
        ...DEFAULTS,
        presets: [
          {
            id: 'v1',
            name: 'Weekly review',
            view: 'workspace',
            range: { preset: 'last30' },
            bucket: 'week',
            projectFilter: { kind: 'unattributed' },
            applicationId: 'photoshop',
          },
        ],
      },
    });
  });

  it('saves the filters only: nothing else passed along is kept, a person least of all', () => {
    const input = { ...fields, id: 'v1', name: 'Carol', personId: YOU, userIds: [YOU] } as Parameters<typeof saveView>[1];
    const saved = mustSave(DEFAULT_PREFERENCES, input);
    expect(Object.keys(saved.presets[0] ?? {}).sort()).toEqual(['applicationId', 'bucket', 'id', 'name', 'projectFilter', 'range', 'view']);
    expect(JSON.stringify(saved)).not.toContain('u-you');
  });

  it('replaces a view of the same name, whatever its case, and keeps its id', () => {
    const first = mustSave(DEFAULT_PREFERENCES, { ...fields, id: 'v1', name: 'Weekly review' });
    const second = mustSave(first, { view: 'mine', range: { preset: 'today' }, bucket: 'auto', projectFilter: ALL_PROJECTS, applicationId: null, id: 'v2', name: 'WEEKLY REVIEW' });
    expect(second.presets).toEqual([
      { id: 'v1', name: 'WEEKLY REVIEW', view: 'mine', range: { preset: 'today' }, bucket: 'auto', projectFilter: { kind: 'all' }, applicationId: null },
    ]);
  });

  it('refuses a name that is empty or too long', () => {
    expect(saveView(DEFAULT_PREFERENCES, { ...fields, id: 'v1', name: '  ' })).toEqual({ ok: false, message: 'Name the view.' });
    expect(saveView(DEFAULT_PREFERENCES, { ...fields, id: 'v1', name: 'x'.repeat(61) })).toEqual({ ok: false, message: 'Use at most 60 characters.' });
  });

  it('refuses an incomplete or invalid custom range, so a listed view is always a stored one', () => {
    const refused = { ok: false, message: 'Fix the custom range before saving this view.' };
    // The To date cleared, or never picked.
    expect(saveView(DEFAULT_PREFERENCES, { ...fields, range: { preset: 'custom', customFrom: '2026-11-01' }, id: 'v1', name: 'Sprint review' })).toEqual(refused);
    expect(saveView(DEFAULT_PREFERENCES, { ...fields, range: { preset: 'custom' }, id: 'v1', name: 'Sprint review' })).toEqual(refused);
    // More than 366 days, or the days the wrong way round.
    expect(
      saveView(DEFAULT_PREFERENCES, { ...fields, range: { preset: 'custom', customFrom: '2025-01-01', customTo: '2026-11-01' }, id: 'v1', name: 'Sprint review' }),
    ).toEqual(refused);
    expect(
      saveView(DEFAULT_PREFERENCES, { ...fields, range: { preset: 'custom', customFrom: '2026-11-09', customTo: '2026-11-03' }, id: 'v1', name: 'Sprint review' }),
    ).toEqual(refused);
    expect(SAVE_VIEW_RANGE_MESSAGE).toBe(refused.message);

    // A refused range never replaces a valid view of the same name.
    const kept = mustSave(DEFAULT_PREFERENCES, { ...fields, id: 'v1', name: 'Sprint review' });
    expect(saveView(kept, { ...fields, range: { preset: 'custom', customTo: '2026-11-09' }, id: 'v2', name: 'sprint review' })).toEqual(refused);

    // A whole custom range is saved, and the stored list equals the one in memory.
    const custom = mustSave(kept, { ...fields, range: { preset: 'custom', customFrom: '2026-11-03', customTo: '2026-11-09' }, id: 'v2', name: 'Sprint 2' });
    expect(custom.presets[1]).toMatchObject({ id: 'v2', range: { preset: 'custom', customFrom: '2026-11-03', customTo: '2026-11-09' } });
    expect(parsePreferences(serializePreferences(custom)).presets).toEqual(custom.presets);
  });

  it('every view it accepts survives storage unchanged', () => {
    let preferences: AnalyticsPreferences = DEFAULT_PREFERENCES;
    const ranges: RangeChoice[] = [
      { preset: 'today' },
      { preset: 'yesterday' },
      { preset: 'last7' },
      { preset: 'last30' },
      { preset: 'custom', customFrom: '2026-01-01', customTo: '2026-12-31' },
    ];
    for (const [index, range] of ranges.entries()) {
      const result = saveView(preferences, { ...fields, range, id: `v${index}`, name: `View ${index}` });
      if (result.ok) preferences = result.preferences;
    }
    expect(preferences.presets).toHaveLength(5);
    expect(parsePreferences(serializePreferences(preferences)).presets).toEqual(preferences.presets);
  });

  it('keeps at most 20: a 21st is refused, replacing one is not', () => {
    const preferences: AnalyticsPreferences = { ...DEFAULT_PREFERENCES, presets: full };
    expect(saveView(preferences, { ...fields, id: 'v21', name: 'One more' })).toEqual({
      ok: false,
      message: 'You can keep up to 20 saved views. Delete one first.',
    });
    const replaced = mustSave(preferences, { ...fields, id: 'v21', name: 'view 20', bucket: 'month' });
    expect(replaced.presets).toHaveLength(20);
    expect(replaced.presets[19]).toMatchObject({ id: 'v20', name: 'view 20', bucket: 'month' });
    const nineteen: AnalyticsPreferences = { ...DEFAULT_PREFERENCES, presets: full.slice(0, 19) };
    expect(mustSave(nineteen, { ...fields, id: 'v21', name: 'One more' }).presets).toHaveLength(20);
  });

  it('deletes a view by id', () => {
    const preferences: AnalyticsPreferences = { ...DEFAULT_PREFERENCES, presets: full.slice(0, 3) };
    expect(deleteView(preferences, 'v2').presets.map((preset) => preset.id)).toEqual(['v1', 'v3']);
    expect(deleteView(preferences, 'missing').presets.map((preset) => preset.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it('applies a view’s filters and leaves the zone, the insights range and the list alone', () => {
    const preferences: AnalyticsPreferences = {
      ...DEFAULT_PREFERENCES,
      timeZone: 'Europe/London',
      projectInsightsRange: 'last90',
      presets: [WEEKLY],
    };
    expect(applySavedView(preferences, 'v1')).toEqual({
      version: 1,
      view: 'workspace',
      range: { preset: 'last30' },
      bucket: 'week',
      timeZone: 'Europe/London',
      projectFilter: { kind: 'unattributed' },
      applicationId: 'photoshop',
      projectInsightsRange: 'last90',
      presets: [WEEKLY],
    });
    expect(applySavedView(preferences, 'missing')).toBeNull();
  });
});
