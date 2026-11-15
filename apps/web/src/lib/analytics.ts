/**
 * Analytics: the pure rules behind the Analytics page and Project Insights. No I/O, no clock and
 * no ambient time zone: callers pass `now` or `today` and the reporting zone. Unit-tested in
 * tests/unit/web/analytics.test.ts. Definitions follow docs/analytics.md:
 *   - active time: an enabled application in front, with input within the idle threshold;
 *   - idle time: a tracked application in front, without input past the threshold;
 *   - in foreground: active + idle; sessions: distinct time entries contributing to a figure;
 *   - unattributed: no project and no task. None of it is billable time.
 *
 * - scope        resolveScope, predictTeammatesVisible, whoseTime, scopedLabel, privacyNote
 * - ranges       resolveAnalyticsRange, formatDayRange, showsPreviousReference, previousReferenceText
 * - buckets      autoBucket, allowedBuckets, resolveBucket
 * - requests     summaryParams, withoutApplicationFilter, previousPeriodParams, analyticsSummaryKey,
 *                mySessionsKey, stableJson
 * - view models  splitReport, reportTotals, periodSeries, activityChartData, createReportLabels,
 *                applicationItems, projectItems, taskItems, memberItems
 * - filters      timeOfOptions, applicationOptions, projectFilterOptions, encodeProjectFilter,
 *                decodeProjectFilter
 * - colours      applicationColors, APPLICATION_REGISTRY_ORDER (the shared assignApplicationColors)
 * - tasks        reportingToday, selectTasks, summarizeTaskProgress, upcomingDeadlines,
 *                projectProgressRows, assignedProjects
 * - exports      toCsv, csvCell, summaryRecords, buildSummaryCsv, buildSummaryJson, sessionRecords,
 *                buildSessionsCsv, buildSessionsJson, formatLocalIso, workspaceSlug, exportFileName
 * - preferences  preferencesKey, validatePreferences, parsePreferences, serializePreferences,
 *                readPreferences, writePreferences, browserStorage, saveView, deleteView,
 *                applySavedView, isReportTimeZone, timeZoneOptions
 * - copy         MEASUREMENTS, RECONCILIATION, analyticsFootnote, overlapClause
 */

import { DEFAULT_APPLICATIONS } from '@studio-pulse/shared-types';
import {
  addDays,
  bucketKeyFor,
  daysBetween,
  formatDuration,
  localDayKey,
  monthStart,
  startOfLocalDay,
} from '@studio-pulse/time-engine';
import type { RangePreset, ReportBucket, ReportRow } from '@studio-pulse/time-engine';
import { APPLICATION_ID_PATTERN, validateCustomRange } from '@studio-pulse/validation';

// The colour module alone, not the package entry (which also loads the React components): this
// file stays free of JSX, so the unit tests and the root type check can import it.
import { OTHER_COLOR, assignApplicationColors } from '@studio-pulse/ui/seriesColors';

import type { AnalyticsSummaryParams, MySession, MySessionsQuery } from './api';
import { daysUntil, isOpenTask } from './model';
import type { Member, Project, Task, TaskStatus, WorkspaceInfo } from './model';

export type { ReportBucket, ReportRow } from '@studio-pulse/time-engine';

const LOCALE = 'en-GB';

/** Code-point order (uuids, ids): like the database's `collate "C"`, never locale-dependent. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** People's and projects' names, the way the member list sorts them. */
function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day `YYYY-MM-DD`. */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

// ---------------------------------------------------------------------------------------------
// Scope: whose time, whose tasks
// ---------------------------------------------------------------------------------------------

/** My work: the viewer's own time and tasks. Workspace: the team, as far as the viewer may see it. */
export type AnalyticsView = 'mine' | 'workspace';

export interface AnalyticsScope {
  readonly view: AnalyticsView;
  /** False in Workspace view while teammates' time is not visible: no time call, tasks only. */
  readonly showsTime: boolean;
  /** `p_user_ids`: null means everyone whose time the viewer can read. */
  readonly userIds: readonly string[] | null;
  /** Task cards count tasks assigned to this person, or every task when null. */
  readonly taskAssigneeId: string | null;
  /** The person picked under "Time of" (Workspace view), or null for everyone / the viewer's own. */
  readonly personId: string | null;
}

/**
 * - `mine`: `p_user_ids = [me]`, tasks assigned to me.
 * - `workspace`, teammates visible: `p_user_ids = person ? [person] : null`; every task, or the
 *   person's assigned tasks.
 * - `workspace`, teammates not visible: no time (`showsTime` false; `[me]` if anything asks), and
 *   every task. A "Time of" choice is ignored.
 */
export function resolveScope(input: {
  readonly view: AnalyticsView;
  readonly me: string;
  readonly personId?: string | null;
  readonly teammatesVisible: boolean;
}): AnalyticsScope {
  const { view, me } = input;
  if (view === 'mine') return { view, showsTime: true, userIds: [me], taskAssigneeId: me, personId: null };
  if (!input.teammatesVisible) return { view, showsTime: false, userIds: [me], taskAssigneeId: null, personId: null };
  const person = input.personId ?? null;
  return { view, showsTime: true, userIds: person ? [person] : null, taskAssigneeId: person, personId: person };
}

/**
 * The UI's guess of the server's `teammates_visible`, from the cached workspace: an owner or admin
 * where the owner chose 'admins' visibility. The report's total row is authoritative.
 */
export function predictTeammatesVisible(workspace: Pick<WorkspaceInfo, 'role' | 'timeEntryVisibility'>): boolean {
  return (workspace.role === 'owner' || workspace.role === 'admin') && workspace.timeEntryVisibility === 'admins';
}

/**
 * The server's word on `teammates_visible` (a report's total row) and the cached workspace state
 * (role, visibility) it was given in.
 */
export interface VisibilityVerdict {
  readonly role: string;
  readonly visibility: string;
  readonly value: boolean;
}

/**
 * The verdict while the cached workspace is still in the state it was given in, else null. Once
 * the role or visibility moves on it is dropped for good, so a later return to that state is
 * predicted (and asked of the server) afresh instead of answered by an old verdict.
 */
export function standingVerdict(
  verdict: VisibilityVerdict | null,
  workspace: Pick<WorkspaceInfo, 'role' | 'timeEntryVisibility'>,
): VisibilityVerdict | null {
  return verdict !== null && verdict.role === workspace.role && verdict.visibility === workspace.timeEntryVisibility ? verdict : null;
}

/** Whether teammates' time is shown: the standing verdict, else the prediction. */
export function teammatesVisibleNow(
  verdict: VisibilityVerdict | null,
  workspace: Pick<WorkspaceInfo, 'role' | 'timeEntryVisibility'>,
): boolean {
  return standingVerdict(verdict, workspace)?.value ?? predictTeammatesVisible(workspace);
}

const EVERYONE_NOTE = 'Includes the time of everyone in this workspace, including former members.';

/**
 * The privacy note shown in Workspace view. `teammatesVisible` (default: the prediction) is what
 * the page shows: where the server's verdict differs from the cached workspace, the note follows
 * the verdict, never "Includes the time of everyone" over a panel with no time.
 */
export function privacyNote(
  workspace: Pick<WorkspaceInfo, 'role' | 'timeEntryVisibility'>,
  teammatesVisible: boolean = predictTeammatesVisible(workspace),
): string {
  if (teammatesVisible !== predictTeammatesVisible(workspace)) {
    return teammatesVisible ? EVERYONE_NOTE : 'Teammates’ time isn’t available to you right now. You see only your own.';
  }
  if (workspace.timeEntryVisibility !== 'admins') {
    return 'Time in this workspace is private to each person. You see only your own. Only the workspace owner can change this.';
  }
  if (workspace.role === 'owner' || workspace.role === 'admin') {
    return EVERYONE_NOTE;
  }
  return 'Owners and admins can see members’ time in this workspace, including yours. You see only your own.';
}

/**
 * Whose time a figure shows when it is not only the viewer's own: "Everyone you can see", the
 * person's name, or null (the viewer's own time).
 */
export function whoseTime(scope: AnalyticsScope, me: string, labels: Pick<ReportLabels, 'member'>): string | null {
  if (!scope.showsTime) return null;
  if (scope.userIds === null) return 'Everyone you can see';
  if (scope.personId !== null && scope.personId !== me) return labels.member(scope.personId).name;
  return null;
}

/** "Carol · Active", or just "Active" for the viewer's own time. */
export function scopedLabel(who: string | null, label: string): string {
  return who ? `${who} · ${label}` : label;
}

// ---------------------------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------------------------

/** The database keeps no reports before this day, nor from 2100 on. */
export const MIN_REPORT_DAY = '2020-01-01';
export const MAX_REPORT_DAY = '2099-12-31';

/** A range as chosen (and saved): a preset, or a custom first and last day. */
export interface RangeChoice {
  readonly preset: RangePreset;
  /** Custom ranges: the first local day, inclusive. */
  readonly customFrom?: string;
  /** Custom ranges: the last local day, inclusive. */
  readonly customTo?: string;
}

export interface PeriodDays {
  /** First and last local day, inclusive (`YYYY-MM-DD`). */
  readonly fromDay: string;
  readonly toDay: string;
  /** Days covered, inclusive. */
  readonly days: number;
  /** [startMs, endMs): from the start of `fromDay` to the start of the day after `toDay`, in the zone. */
  readonly startMs: number;
  readonly endMs: number;
  /** "Last 7 days", "3–9 Nov"; the previous period's reads "Previous 7 days (27 Oct – 2 Nov)". */
  readonly label: string;
}

export interface ReportRange extends PeriodDays {
  readonly preset: RangePreset;
  readonly timeZone: string;
  /** Today (in the zone) is one of the days: its time is still being recorded and synced. */
  readonly includesToday: boolean;
  /** The period of the same length just before this one. */
  readonly previous: PeriodDays;
}

export type RangeResult = { readonly ok: true; readonly range: ReportRange } | { readonly ok: false; readonly message: string };

const PRESET_LABEL: Readonly<Record<Exclude<RangePreset, 'custom'>, string>> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
};

function presetDays(preset: Exclude<RangePreset, 'custom'>, today: string): { fromDay: string; toDay: string } {
  switch (preset) {
    case 'today':
      return { fromDay: today, toDay: today };
    case 'yesterday':
      return { fromDay: addDays(today, -1), toDay: addDays(today, -1) };
    case 'last7':
      return { fromDay: addDays(today, -6), toDay: today };
    case 'last30':
      return { fromDay: addDays(today, -29), toDay: today };
  }
}

/** A custom range's problem as a sentence, from `validateCustomRange`'s issues. */
function customRangeMessage(issues: readonly string[]): string {
  const text = issues.join(' ');
  if (/calendar date/.test(text)) return 'Choose a start and an end date.';
  if (/on or after/.test(text)) return 'The end date is before the start date.';
  if (/at most/.test(text)) return 'A custom range covers at most 366 days.';
  return 'Choose a valid date range.';
}

/**
 * Local calendar days for a preset or a custom range, in the reporting zone. Custom ranges are
 * checked with `validateCustomRange` (real dates, start ≤ end, at most 366 days) and must lie
 * between 1 January 2020 and 31 December 2099, as the database requires.
 */
export function resolveAnalyticsRange(choice: RangeChoice, options: { readonly now: number; readonly timeZone: string }): RangeResult {
  const { timeZone } = options;
  const today = localDayKey(options.now, timeZone);
  let fromDay: string;
  let toDay: string;
  let label: string;
  if (choice.preset === 'custom') {
    const checked = validateCustomRange(choice.customFrom ?? '', choice.customTo ?? '');
    if (!checked.ok) return { ok: false, message: customRangeMessage(checked.issues) };
    fromDay = checked.value.start;
    toDay = checked.value.end;
    if (fromDay < MIN_REPORT_DAY) return { ok: false, message: 'Reports cover days from 1 January 2020.' };
    if (toDay > MAX_REPORT_DAY) return { ok: false, message: 'Reports cover days before 1 January 2100.' };
    label = formatDayRange(fromDay, toDay, today);
  } else {
    ({ fromDay, toDay } = presetDays(choice.preset, today));
    label = PRESET_LABEL[choice.preset];
  }
  const days = daysBetween(fromDay, toDay) + 1;
  const previousTo = addDays(fromDay, -1);
  const previousFrom = addDays(previousTo, -(days - 1));
  return {
    ok: true,
    range: {
      preset: choice.preset,
      timeZone,
      fromDay,
      toDay,
      days,
      startMs: startOfLocalDay(fromDay, timeZone),
      endMs: startOfLocalDay(addDays(toDay, 1), timeZone),
      label,
      includesToday: fromDay <= today && today <= toDay,
      previous: {
        fromDay: previousFrom,
        toDay: previousTo,
        days,
        startMs: startOfLocalDay(previousFrom, timeZone),
        endMs: startOfLocalDay(fromDay, timeZone),
        label: `Previous ${days === 1 ? 'day' : `${days} days`} (${formatDayRange(previousFrom, previousTo, today)})`,
      },
    },
  };
}

interface DayText {
  readonly day: string;
  readonly month: string;
  readonly year: string;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let format = dayFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: 'UTC' });
    dayFormats.set(key, format);
  }
  return format;
}

/** A calendar day at UTC noon: formatting it in UTC shows that day whatever the host's zone. */
function dayNoon(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 12);
}

function dayText(day: string): DayText {
  const parts = dayFormat({ day: 'numeric', month: 'short' }).formatToParts(dayNoon(day));
  return {
    day: parts.find((part) => part.type === 'day')?.value ?? day.slice(8, 10),
    month: parts.find((part) => part.type === 'month')?.value ?? day.slice(5, 7),
    year: day.slice(0, 4),
  };
}

/**
 * "12 Nov", "3–9 Nov", "28 Oct – 3 Nov"; years are added when a day is outside `today`'s year
 * ("28 Dec 2025 – 3 Jan 2026").
 */
export function formatDayRange(fromDay: string, toDay: string, today: string): string {
  const from = dayText(fromDay);
  const to = dayText(toDay);
  const withYear = from.year !== today.slice(0, 4) || to.year !== today.slice(0, 4);
  const full = (text: DayText) => `${text.day} ${text.month}${withYear ? ` ${text.year}` : ''}`;
  if (fromDay === toDay) return full(from);
  if (from.year === to.year && from.month === to.month) return `${from.day}–${full(to)}`;
  return `${full(from)} – ${full(to)}`;
}

/**
 * Whether the Active tile gets the neutral reference line for the previous period (and so whether
 * the previous period is requested at all): not for a range of just today, not for a teammate's
 * time (that would be per-person trend tracking), not when the previous period would start before
 * the first day reports cover, and only where time is shown.
 */
export function showsPreviousReference(
  range: Pick<ReportRange, 'preset' | 'days' | 'includesToday' | 'previous'>,
  scope: AnalyticsScope,
  me: string,
): boolean {
  if (!scope.showsTime) return false;
  if (range.preset === 'today' || (range.days === 1 && range.includesToday)) return false;
  if (range.previous.fromDay < MIN_REPORT_DAY) return false;
  return scope.personId === null || scope.personId === me;
}

/** "Previous 7 days (3–9 Nov): 31h 10m", plus "(today still in progress)" when the range includes today. Never a delta. */
export function previousReferenceText(range: Pick<ReportRange, 'previous' | 'includesToday'>, previousActiveMs: number): string {
  const text = `${range.previous.label}: ${formatDuration(previousActiveMs)}`;
  return range.includesToday ? `${text} (today still in progress)` : text;
}

// ---------------------------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------------------------

export type BucketChoice = 'auto' | ReportBucket;

/** Day buckets only up to this many days: more columns than that do not fit a narrow screen. */
export const DAY_BUCKET_MAX_DAYS = 92;

/** Day up to 31 days, week up to 120, month beyond. */
export function autoBucket(days: number): ReportBucket {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

/** The buckets the Bucket control offers for a range of `days` days. */
export function allowedBuckets(days: number): ReportBucket[] {
  return days <= DAY_BUCKET_MAX_DAYS ? ['day', 'week', 'month'] : ['week', 'month'];
}

/** The bucket a choice resolves to: Auto by length, and Day falls back to Auto past 92 days. */
export function resolveBucket(choice: BucketChoice, days: number): ReportBucket {
  if (choice === 'auto' || !allowedBuckets(days).includes(choice)) return autoBucket(days);
  return choice;
}

// ---------------------------------------------------------------------------------------------
// Requests and cache keys
// ---------------------------------------------------------------------------------------------

export type ProjectFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'unattributed' }
  | { readonly kind: 'project'; readonly id: string };

export const ALL_PROJECTS: ProjectFilter = { kind: 'all' };

/** The report request for a range, scope and filters (`api.analyticsSummary`). */
export function summaryParams(input: {
  readonly workspaceId: string;
  readonly range: Pick<ReportRange, 'fromDay' | 'toDay' | 'timeZone'>;
  readonly bucket: ReportBucket;
  readonly scope: Pick<AnalyticsScope, 'userIds'>;
  readonly projectFilter: ProjectFilter;
  readonly applicationId: string | null;
}): AnalyticsSummaryParams {
  return {
    workspaceId: input.workspaceId,
    fromDay: input.range.fromDay,
    toDay: input.range.toDay,
    timeZone: input.range.timeZone,
    bucket: input.bucket,
    userIds: input.scope.userIds,
    projectId: input.projectFilter.kind === 'project' ? input.projectFilter.id : null,
    unattributed: input.projectFilter.kind === 'unattributed',
    applicationId: input.applicationId,
  };
}

/** The same report without the application filter: the source of the Application and "Time of" options. */
export function withoutApplicationFilter(params: AnalyticsSummaryParams): AnalyticsSummaryParams {
  return { ...params, applicationId: null };
}

/** The same report over the previous period (only its total is used: month buckets keep it small). */
export function previousPeriodParams(params: AnalyticsSummaryParams, previous: Pick<PeriodDays, 'fromDay' | 'toDay'>): AnalyticsSummaryParams {
  return { ...params, fromDay: previous.fromDay, toDay: previous.toDay, bucket: 'month' };
}

/**
 * JSON with object keys sorted and null or undefined members left out, so equal requests give
 * equal strings (cache keys).
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(raw).sort()) {
      const member = (raw as Record<string, unknown>)[key];
      if (member !== null && member !== undefined) sorted[key] = member;
    }
    return sorted;
  });
}

/**
 * The cache key of a report: under `ws:<id>:time:`, so `refresh('time')`, a task move, sign-out
 * (`clearQueries`) and switching workspaces all cover it. Equal requests give equal keys: the
 * order of `userIds` does not matter, and `unattributed: false` (the database default) is the same
 * as leaving it out.
 */
export function analyticsSummaryKey(params: AnalyticsSummaryParams): string {
  const userIds = params.userIds ? [...params.userIds].sort(byCodePoint) : null;
  const unattributed = params.unattributed === true ? true : null;
  return `ws:${params.workspaceId}:time:analytics:summary:${stableJson({ ...params, workspaceId: undefined, userIds, unattributed })}`;
}

/**
 * The page's filters as a session-list query, applied as the report applies them: a project, an
 * application, and "unattributed" (the page's Unattributed filter, or the Recent sessions card's
 * "Only unattributed" while no project filter is set; with a project it could only empty the list).
 */
export function sessionQueryFilters(
  projectFilter: ProjectFilter,
  applicationId: string | null,
  onlyUnattributed: boolean,
): Pick<MySessionsQuery, 'projectId' | 'applicationId' | 'unattributedOnly'> {
  return {
    ...(projectFilter.kind === 'project' ? { projectId: projectFilter.id } : {}),
    ...(applicationId !== null ? { applicationId } : {}),
    ...(projectFilter.kind === 'unattributed' || (projectFilter.kind === 'all' && onlyUnattributed) ? { unattributedOnly: true } : {}),
  };
}

/** The cache key of the first page of the session list (later pages are component state). */
export function mySessionsKey(query: MySessionsQuery & { readonly limit?: number }): string {
  return `ws:${query.workspaceId}:time:analytics:sessions:${stableJson({ ...query, workspaceId: undefined })}`;
}

// ---------------------------------------------------------------------------------------------
// Report rows → view models
// ---------------------------------------------------------------------------------------------

export interface TimeFigures {
  readonly activeMs: number;
  readonly idleMs: number;
  /** Active + idle. */
  readonly foregroundMs: number;
  /** Distinct sessions contributing: one spanning two days counts in each. */
  readonly sessions: number;
}

export interface ReportTotals extends TimeFigures {
  /** Time recorded more than once (several devices) and counted once. */
  readonly overlapMs: number;
  /** The server's word on whether teammates' time is included; null before a report arrived. */
  readonly teammatesVisible: boolean | null;
}

export interface ReportParts {
  readonly total: ReportRow;
  readonly periods: readonly ReportRow[];
  readonly members: readonly ReportRow[];
  readonly projects: readonly ReportRow[];
  readonly tasks: readonly ReportRow[];
  readonly applications: readonly ReportRow[];
}

const ZERO_TOTAL: ReportRow = {
  dimension: 'total',
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
};

/** The report's rows by dimension, each in the server's order. */
export function splitReport(rows: readonly ReportRow[]): ReportParts {
  const of = (dimension: ReportRow['dimension']) => rows.filter((row) => row.dimension === dimension);
  return {
    total: rows.find((row) => row.dimension === 'total') ?? ZERO_TOTAL,
    periods: of('period'),
    members: of('member'),
    projects: of('project'),
    tasks: of('task'),
    applications: of('application'),
  };
}

const NO_FIGURES: TimeFigures = { activeMs: 0, idleMs: 0, foregroundMs: 0, sessions: 0 };

function figures(row: Pick<ReportRow, 'activeMs' | 'idleMs' | 'entryCount'>): TimeFigures {
  return { activeMs: row.activeMs, idleMs: row.idleMs, foregroundMs: row.activeMs + row.idleMs, sessions: row.entryCount };
}

export function reportTotals(total: ReportRow): ReportTotals {
  return { ...figures(total), overlapMs: total.overlapMs, teammatesVisible: total.teammatesVisible };
}

export interface PeriodPoint extends TimeFigures {
  /** The bucket's first day: the day, the ISO week's Monday or the 1st. */
  readonly bucketStart: string;
  /** The bucket's last calendar day. */
  readonly lastDay: string;
  /** The range covers only part of this bucket (a first or last week or month). */
  readonly partial: boolean;
}

function nextBucket(start: string, bucket: ReportBucket): string {
  switch (bucket) {
    case 'day':
      return addDays(start, 1);
    case 'week':
      return addDays(start, 7);
    case 'month':
      return monthStart(addDays(start, 31));
  }
}

/**
 * One point per bucket from the first to the last day, buckets without time filled with zeros.
 * `fromDay` null (a report "from the first session") starts at the first period row and marks no
 * first bucket partial; without period rows there are no points.
 */
export function periodSeries(
  periodRows: readonly ReportRow[],
  options: { readonly fromDay: string | null; readonly toDay: string; readonly bucket: ReportBucket },
): PeriodPoint[] {
  const { fromDay, toDay, bucket } = options;
  const byStart = new Map<string, ReportRow>();
  for (const row of periodRows) if (row.bucketStart) byStart.set(row.bucketStart, row);
  const firstDay = fromDay ?? [...byStart.keys()].sort(byCodePoint)[0];
  if (firstDay === undefined) return [];

  const points: PeriodPoint[] = [];
  const last = bucketKeyFor(toDay, bucket);
  for (let start = bucketKeyFor(firstDay, bucket); start <= last; start = nextBucket(start, bucket)) {
    const lastDay = addDays(nextBucket(start, bucket), -1);
    const row = byStart.get(start);
    points.push({
      bucketStart: start,
      lastDay,
      partial: (fromDay !== null && start < fromDay) || lastDay > toDay,
      ...(row ? figures(row) : NO_FIGURES),
    });
  }
  return points;
}

/** Plain data for the Activity `AreaChart` (structurally an `AreaDatum`). */
export interface ActivityDatum {
  readonly key: string;
  readonly label: string;
  /** Active time, ms. */
  readonly value: number;
  readonly tooltip: {
    readonly title: string;
    readonly subtitle?: string;
    readonly rows: ReadonlyArray<{ readonly id: string; readonly label: string; readonly value: string }>;
  };
}

/** Axis label of a bucket: "3 Nov" (day, week), "Nov" or "Nov 2025" (month, outside `today`'s year). */
export function periodLabel(bucketStart: string, bucket: ReportBucket, today: string): string {
  const text = dayText(bucketStart);
  if (bucket === 'month') return text.year === today.slice(0, 4) ? text.month : `${text.month} ${text.year}`;
  return `${text.day} ${text.month}`;
}

/** Readout title of a bucket: "Tue 3 Nov", "Week of 3 Nov", "November 2026" (years outside `today`'s year). */
export function periodTitle(bucketStart: string, bucket: ReportBucket, today: string): string {
  const text = dayText(bucketStart);
  const year = text.year === today.slice(0, 4) ? '' : ` ${text.year}`;
  switch (bucket) {
    case 'day':
      return `${dayFormat({ weekday: 'short' }).format(dayNoon(bucketStart))} ${text.day} ${text.month}${year}`;
    case 'week':
      return `Week of ${text.day} ${text.month}${year}`;
    case 'month':
      return dayFormat({ month: 'long', year: 'numeric' }).format(dayNoon(bucketStart));
  }
}

/**
 * The Activity chart's points: Active per bucket, with Active, Idle and In foreground in the
 * readout. `who` (from `whoseTime`) names whose time it is when it is not the viewer's own.
 */
export function activityChartData(
  points: readonly PeriodPoint[],
  bucket: ReportBucket,
  options: { readonly today: string; readonly who?: string | null },
): ActivityDatum[] {
  const partial = bucket === 'week' ? 'Partial week' : 'Partial month';
  return points.map((point) => {
    const subtitle = [options.who ?? null, point.partial ? partial : null].filter((part): part is string => part !== null).join(' · ');
    return {
      key: point.bucketStart,
      label: periodLabel(point.bucketStart, bucket, options.today),
      value: point.activeMs,
      tooltip: {
        title: periodTitle(point.bucketStart, bucket, options.today),
        ...(subtitle ? { subtitle } : {}),
        rows: [
          { id: 'active', label: 'Active', value: formatDuration(point.activeMs) },
          { id: 'idle', label: 'Idle', value: formatDuration(point.idleMs) },
          { id: 'foreground', label: 'In foreground', value: formatDuration(point.foregroundMs) },
        ],
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Labels for people, projects and tasks (views and exports)
// ---------------------------------------------------------------------------------------------

export const UNATTRIBUTED_LABEL = 'Unattributed';
export const NO_PROJECT_LABEL = 'No project (task time)';
/** Tasks without a project, where no time is shown next to them. */
export const NO_PROJECT_TASKS_LABEL = 'No project';
export const NO_TASK_LABEL = 'No task';
export const FORMER_MEMBER_LABEL = 'Former member';
export const ARCHIVED_SUFFIX = ' (archived)';

export interface ReportLabels {
  /** An active member's name; a former member's "Name (former member)", or "Former member" when unknown. */
  member(userId: string): { readonly name: string; readonly former: boolean };
  /**
   * A project's name (with "(archived)"), or for no project: "Unattributed" when there is no task
   * either, "No project (task time)" for time on tasks without a project.
   */
  project(projectId: string | null, unattributed: boolean): { readonly label: string; readonly archived: boolean };
  /** A task's title (with "(archived)"), "No task" in a project, or "Unattributed". */
  task(
    taskId: string | null,
    projectId: string | null,
  ): { readonly label: string; readonly archived: boolean; readonly status: TaskStatus | null; readonly estimateMinutes: number | null };
}

/**
 * Labels from the cached lists. `formerNames` holds names of people who left (`useFormerNames`);
 * removed members' profiles are often unreadable, hence "Former member".
 */
export function createReportLabels(input: {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly members: readonly Pick<Member, 'userId' | 'displayName'>[];
  readonly formerNames?: ReadonlyMap<string, string>;
}): ReportLabels {
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const members = new Map(input.members.map((member) => [member.userId, member.displayName]));
  return {
    member(userId) {
      const active = members.get(userId);
      if (active !== undefined) return { name: active, former: false };
      const known = input.formerNames?.get(userId);
      return { name: known ? `${known} (former member)` : FORMER_MEMBER_LABEL, former: true };
    },
    project(projectId, unattributed) {
      if (projectId === null) return { label: unattributed ? UNATTRIBUTED_LABEL : NO_PROJECT_LABEL, archived: false };
      const project = projects.get(projectId);
      if (!project) return { label: 'Unknown project', archived: false };
      const archived = project.status === 'archived';
      return { label: archived ? `${project.name}${ARCHIVED_SUFFIX}` : project.name, archived };
    },
    task(taskId, projectId) {
      if (taskId === null) {
        return { label: projectId === null ? UNATTRIBUTED_LABEL : NO_TASK_LABEL, archived: false, status: null, estimateMinutes: null };
      }
      const task = tasks.get(taskId);
      if (!task) return { label: 'Unknown task', archived: false, status: null, estimateMinutes: null };
      const archived = task.status === 'archived';
      return {
        label: archived ? `${task.title}${ARCHIVED_SUFFIX}` : task.title,
        archived,
        status: task.status,
        estimateMinutes: task.estimated_minutes,
      };
    },
  };
}

/** Larger active time first, then larger foreground time, then the label, then the key. */
function byTime<T extends TimeFigures & { readonly label: string; readonly key: string }>(a: T, b: T): number {
  return b.activeMs - a.activeMs || b.foregroundMs - a.foregroundMs || byName(a.label, b.label) || byCodePoint(a.key, b.key);
}

export interface ApplicationItem extends TimeFigures {
  readonly key: string;
  readonly applicationId: string;
  readonly label: string;
  readonly color: string;
}

/** Built-in applications first, in the registry's order: the colour slots follow it. */
export const APPLICATION_REGISTRY_ORDER: ReadonlyMap<string, number> = new Map(
  DEFAULT_APPLICATIONS.map((application, index) => [application.id, index]),
);

/**
 * Colours by application id: the shared rule (`assignApplicationColors`). Colour is identity:
 * pass the application rows of the report without the application filter, so filtering does
 * not repaint.
 */
export function applicationColors(applicationRows: readonly ReportRow[]): Map<string, string> {
  return assignApplicationColors(
    applicationRows
      .filter((row) => row.applicationId !== null)
      .map((row) => ({ applicationId: row.applicationId ?? '', activeMs: row.activeMs, foregroundMs: row.activeMs + row.idleMs })),
    APPLICATION_REGISTRY_ORDER,
  );
}

/** Applications by active time (the largest first). */
export function applicationItems(applicationRows: readonly ReportRow[], colors: ReadonlyMap<string, string>): ApplicationItem[] {
  return applicationRows
    .filter((row) => row.applicationId !== null)
    .map((row) => {
      const applicationId = row.applicationId ?? '';
      return {
        key: applicationId,
        applicationId,
        label: row.applicationName ?? applicationId,
        color: colors.get(applicationId) ?? OTHER_COLOR,
        ...figures(row),
      };
    })
    .sort(byTime);
}

/** `project`: a project; `noProject`: time on tasks without a project; `unattributed`: no project, no task. */
export type ProjectItemKind = 'project' | 'noProject' | 'unattributed';

export interface ProjectItem extends TimeFigures {
  /** The project id, or `no-project` / `unattributed`. */
  readonly key: string;
  readonly kind: ProjectItemKind;
  readonly projectId: string | null;
  readonly label: string;
  readonly archived: boolean;
}

const KIND_RANK: Readonly<Record<ProjectItemKind, number>> = { project: 0, noProject: 1, unattributed: 2 };

function projectKind(projectId: string | null, unattributed: boolean): ProjectItemKind {
  return projectId !== null ? 'project' : unattributed ? 'unattributed' : 'noProject';
}

function projectKey(kind: ProjectItemKind, projectId: string | null): string {
  return kind === 'project' ? (projectId ?? '') : kind === 'noProject' ? 'no-project' : 'unattributed';
}

/** Projects by active time, then "No project (task time)", then "Unattributed" last. */
export function projectItems(projectRows: readonly ReportRow[], labels: ReportLabels): ProjectItem[] {
  return projectRows
    .map((row) => {
      const kind = projectKind(row.projectId, row.unattributed === true);
      const { label, archived } = labels.project(row.projectId, row.unattributed === true);
      return { key: projectKey(kind, row.projectId), kind, projectId: row.projectId, label, archived, ...figures(row) };
    })
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || byTime(a, b));
}

/** The Unattributed tile: time with no project and no task (zeros when the report has none). */
export function unattributedTime(projectRows: readonly ReportRow[]): TimeFigures {
  const row = projectRows.find((candidate) => candidate.projectId === null && candidate.unattributed === true);
  return row ? figures(row) : NO_FIGURES;
}

/** `task`: a task; `noTask`: a project's time without a task; `unattributed`: no project, no task. */
export type TaskItemKind = 'task' | 'noTask' | 'unattributed';

export interface TaskItem extends TimeFigures {
  /** `<project id or ->:<task id or ->`. */
  readonly key: string;
  readonly kind: TaskItemKind;
  readonly taskId: string | null;
  readonly projectId: string | null;
  readonly label: string;
  readonly projectLabel: string;
  readonly archived: boolean;
  /** The task's current status. */
  readonly status: TaskStatus | null;
  /** The task's own estimate ("Estimate (task)"), in minutes. Never a project budget. */
  readonly estimateMinutes: number | null;
}

const TASK_KIND_RANK: Readonly<Record<TaskItemKind, number>> = { task: 0, noTask: 1, unattributed: 2 };

/** Tasks by active time, then each project's time without a task, then "Unattributed" last. */
export function taskItems(taskRows: readonly ReportRow[], labels: ReportLabels): TaskItem[] {
  return taskRows
    .map((row) => {
      const kind: TaskItemKind = row.taskId !== null ? 'task' : row.projectId !== null ? 'noTask' : 'unattributed';
      const task = labels.task(row.taskId, row.projectId);
      return {
        key: `${row.projectId ?? '-'}:${row.taskId ?? '-'}`,
        kind,
        taskId: row.taskId,
        projectId: row.projectId,
        label: task.label,
        projectLabel: labels.project(row.projectId, kind === 'unattributed').label,
        archived: task.archived,
        status: task.status,
        estimateMinutes: task.estimateMinutes,
        ...figures(row),
      };
    })
    .sort((a, b) => TASK_KIND_RANK[a.kind] - TASK_KIND_RANK[b.kind] || byTime(a, b));
}

export interface MemberItem extends TimeFigures {
  readonly userId: string;
  readonly name: string;
  /** No longer an active member (their time stays readable under 'admins' visibility). */
  readonly former: boolean;
}

function byPerson(a: { name: string; former: boolean; userId: string }, b: { name: string; former: boolean; userId: string }): number {
  return Number(a.former) - Number(b.former) || byName(a.name, b.name) || byCodePoint(a.userId, b.userId);
}

/** People alphabetically by name, then id, former members last. Never ordered by time. */
export function memberItems(memberRows: readonly ReportRow[], labels: ReportLabels): MemberItem[] {
  return memberRows
    .filter((row) => row.userId !== null)
    .map((row) => {
      const userId = row.userId ?? '';
      return { userId, ...labels.member(userId), ...figures(row) };
    })
    .sort(byPerson);
}

// ---------------------------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------------------------

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/** "All" in the Application and Project selects (`*` is never an application or project id). */
export const ALL = '*';
/** "Everyone you can see" in the "Time of" select. */
export const EVERYONE = '*';
export const UNATTRIBUTED_FILTER = 'unattributed';

/**
 * "Time of": everyone, then active members alphabetically, then former members who appear in the
 * report without the application filter, labelled "Former member" (numbered when several are
 * unnamed). Never persisted.
 */
export function timeOfOptions(
  members: readonly Pick<Member, 'userId' | 'displayName'>[],
  memberRows: readonly ReportRow[],
  labels: ReportLabels,
): FilterOption[] {
  const active = [...members]
    .sort((a, b) => byName(a.displayName, b.displayName) || byCodePoint(a.userId, b.userId))
    .map((member) => ({ value: member.userId, label: member.displayName }));
  const activeIds = new Set(members.map((member) => member.userId));
  const former = memberRows
    .map((row) => row.userId)
    .filter((userId): userId is string => userId !== null && !activeIds.has(userId))
    .map((userId) => ({ userId, ...labels.member(userId) }))
    .sort(byPerson);
  const unnamed = former.filter((person) => person.name === FORMER_MEMBER_LABEL).length;
  let counter = 0;
  const formerOptions = former.map((person) => {
    if (person.name !== FORMER_MEMBER_LABEL || unnamed < 2) return { value: person.userId, label: person.name };
    counter += 1;
    return { value: person.userId, label: `${FORMER_MEMBER_LABEL} ${counter}` };
  });
  return [{ value: EVERYONE, label: 'Everyone you can see' }, ...active, ...formerOptions];
}

/**
 * "All applications", then the applications in the report without the application filter (by
 * name), and the selected one even when that report has no time for it.
 */
export function applicationOptions(
  unfilteredApplicationRows: readonly ReportRow[],
  selected: { readonly id: string; readonly name?: string | null } | null,
): FilterOption[] {
  const options = unfilteredApplicationRows
    .filter((row) => row.applicationId !== null)
    .map((row) => ({ value: row.applicationId ?? '', label: row.applicationName ?? row.applicationId ?? '' }));
  if (selected && !options.some((option) => option.value === selected.id)) {
    options.push({ value: selected.id, label: selected.name ?? selected.id });
  }
  options.sort((a, b) => byName(a.label, b.label) || byCodePoint(a.value, b.value));
  return [{ value: ALL, label: 'All applications' }, ...options];
}

/** "All projects", "Unattributed", then every project in the given order, archived ones marked. */
export function projectFilterOptions(projects: readonly Pick<Project, 'id' | 'name' | 'status'>[]): FilterOption[] {
  return [
    { value: ALL, label: 'All projects' },
    { value: UNATTRIBUTED_FILTER, label: UNATTRIBUTED_LABEL },
    ...projects.map((project) => ({
      value: project.id,
      label: project.status === 'archived' ? `${project.name}${ARCHIVED_SUFFIX}` : project.name,
    })),
  ];
}

export function encodeProjectFilter(filter: ProjectFilter): string {
  return filter.kind === 'project' ? filter.id : filter.kind === 'unattributed' ? UNATTRIBUTED_FILTER : ALL;
}

export function decodeProjectFilter(value: string): ProjectFilter {
  if (value === UNATTRIBUTED_FILTER) return { kind: 'unattributed' };
  if (UUID.test(value)) return { kind: 'project', id: value.toLowerCase() };
  return ALL_PROJECTS;
}

// ---------------------------------------------------------------------------------------------
// Tasks (current state from the cached task list, not limited by dates or application)
// ---------------------------------------------------------------------------------------------

/** "Due soon": due today or within this many days. */
export const DUE_SOON_DAYS = 7;

/** Today in the reporting zone: overdue and due-soon are counted against it. */
export function reportingToday(now: number, timeZone: string): string {
  return localDayKey(now, timeZone);
}

export interface TaskSelection {
  /** A project; "Unattributed" selects tasks without a project. */
  readonly projectFilter: ProjectFilter;
  /** Tasks assigned to this person, or every task when null. */
  readonly assigneeId: string | null;
}

/** The tasks a task card counts, archived ones excluded. */
export function selectTasks(tasks: readonly Task[], selection: TaskSelection): Task[] {
  const { projectFilter, assigneeId } = selection;
  return tasks.filter((task) => {
    if (task.status === 'archived') return false;
    if (assigneeId !== null && task.assignee_id !== assigneeId) return false;
    if (projectFilter.kind === 'unattributed') return task.project_id === null;
    if (projectFilter.kind === 'project') return task.project_id === projectFilter.id;
    return true;
  });
}

export const PROGRESS_STATUSES = ['inbox', 'todo', 'in_progress', 'in_review', 'done'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export interface TaskProgressSummary {
  /** Tasks per status (archived excluded). */
  readonly counts: Readonly<Record<ProgressStatus, number>>;
  readonly total: number;
  /** Not done, with a due date before today. */
  readonly overdue: number;
  /** Not done, due today or within the next 7 days. */
  readonly dueSoon: number;
  /** In review. */
  readonly awaitingReview: number;
}

function isOverdue(task: Pick<Task, 'status' | 'due_date'>, today: string): boolean {
  return isOpenTask(task) && task.due_date !== null && task.due_date < today;
}

function isDueSoon(task: Pick<Task, 'status' | 'due_date'>, today: string): boolean {
  if (!isOpenTask(task) || task.due_date === null) return false;
  const days = daysUntil(task.due_date, today);
  return days >= 0 && days <= DUE_SOON_DAYS;
}

/**
 * Task progress for a selection: "Current status — not limited by dates or application". `today`
 * is the reporting zone's (`reportingToday`). Named apart from `model.taskProgress` (done / total).
 */
export function summarizeTaskProgress(tasks: readonly Task[], options: TaskSelection & { readonly today: string }): TaskProgressSummary {
  const counts: Record<ProgressStatus, number> = { inbox: 0, todo: 0, in_progress: 0, in_review: 0, done: 0 };
  let overdue = 0;
  let dueSoon = 0;
  const selected = selectTasks(tasks, options);
  for (const task of selected) {
    if (task.status !== 'archived') counts[task.status] += 1;
    if (isOverdue(task, options.today)) overdue += 1;
    if (isDueSoon(task, options.today)) dueSoon += 1;
  }
  return { counts, total: selected.length, overdue, dueSoon, awaitingReview: counts.in_review };
}

/** Open tasks that are overdue or due within 7 days, by due date (then title). */
export function upcomingDeadlines(tasks: readonly Task[], options: TaskSelection & { readonly today: string }): Task[] {
  return selectTasks(tasks, options)
    .filter((task) => isOverdue(task, options.today) || isDueSoon(task, options.today))
    .sort((a, b) => byCodePoint(a.due_date ?? '', b.due_date ?? '') || byName(a.title, b.title) || byCodePoint(a.id, b.id));
}

export interface ProjectProgressRow {
  /** The project id, or `no-project` / `unattributed`. */
  readonly key: string;
  readonly kind: ProjectItemKind;
  readonly projectId: string | null;
  readonly label: string;
  readonly archived: boolean;
  /** Recorded time in the range; null where time is not shown. */
  readonly time: TimeFigures | null;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly inReview: number;
  readonly overdue: number;
}

/**
 * "Projects: time and progress": every project with time in the range or with tasks in the
 * selection, plus "No project (task time)" (tasks without a project, and their time) and
 * "Unattributed" (time only). By active time when time is shown, else by name; those two last.
 * Pass `projectRows: null` for the tasks-only table (teammates' time not visible).
 */
export function projectProgressRows(input: {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly selection: TaskSelection;
  readonly projectRows: readonly ReportRow[] | null;
  readonly labels: ReportLabels;
  readonly today: string;
}): ProjectProgressRow[] {
  const { projectRows, labels, today, selection } = input;
  const timeOf = new Map<string, TimeFigures>();
  for (const row of projectRows ?? []) {
    timeOf.set(projectKey(projectKind(row.projectId, row.unattributed === true), row.projectId), figures(row));
  }
  const taskStats = new Map<string, { done: number; total: number; inReview: number; overdue: number }>();
  for (const task of selectTasks(input.tasks, selection)) {
    const key = task.project_id ?? 'no-project';
    const stats = taskStats.get(key) ?? { done: 0, total: 0, inReview: 0, overdue: 0 };
    stats.total += 1;
    if (task.status === 'done') stats.done += 1;
    if (task.status === 'in_review') stats.inReview += 1;
    if (isOverdue(task, today)) stats.overdue += 1;
    taskStats.set(key, stats);
  }

  const keys = new Set<string>([...timeOf.keys(), ...taskStats.keys()]);
  const rows: ProjectProgressRow[] = [];
  for (const key of keys) {
    const kind: ProjectItemKind = key === 'no-project' ? 'noProject' : key === 'unattributed' ? 'unattributed' : 'project';
    const projectId = kind === 'project' ? key : null;
    if (selection.projectFilter.kind === 'project' && projectId !== selection.projectFilter.id) continue;
    if (selection.projectFilter.kind === 'unattributed' && kind === 'project') continue;
    const time = projectRows === null ? null : (timeOf.get(key) ?? NO_FIGURES);
    const stats = taskStats.get(key) ?? { done: 0, total: 0, inReview: 0, overdue: 0 };
    if (stats.total === 0 && (time === null || time.foregroundMs === 0)) continue;
    const { label, archived } = labels.project(projectId, kind === 'unattributed');
    rows.push({
      key,
      kind,
      projectId,
      // Without a time column the row is only "tasks without a project".
      label: kind === 'noProject' && time === null ? NO_PROJECT_TASKS_LABEL : label,
      archived,
      time,
      tasksDone: stats.done,
      tasksTotal: stats.total,
      inReview: stats.inReview,
      overdue: stats.overdue,
    });
  }
  return rows.sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (b.time?.activeMs ?? 0) - (a.time?.activeMs ?? 0) ||
      byName(a.label, b.label) ||
      byCodePoint(a.key, b.key),
  );
}

export interface AssignedProject {
  readonly projectId: string;
  readonly label: string;
  /** The viewer leads it. */
  readonly lead: boolean;
  /** Open tasks assigned to the viewer. */
  readonly openTasks: number;
  /** The viewer's active time on it in the range; null where time is not shown. */
  readonly activeMs: number | null;
}

/**
 * Projects the viewer leads or has open tasks in (archived projects left out), by name, under the
 * page's project filter as the other cards apply it: a project filter keeps only that project;
 * the Unattributed filter keeps the list but shows no time (no project has time under it), never
 * a false "0m".
 */
export function assignedProjects(input: {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly me: string;
  /** Project rows of the viewer's own report (My work), or null. */
  readonly projectRows: readonly ReportRow[] | null;
  /** The page's project filter (the rows above were read under it). */
  readonly projectFilter: ProjectFilter;
}): AssignedProject[] {
  const filter = input.projectFilter;
  const showsTime = input.projectRows !== null && filter.kind !== 'unattributed';
  const open = new Map<string, number>();
  for (const task of input.tasks) {
    if (task.assignee_id !== input.me || task.project_id === null || !isOpenTask(task)) continue;
    open.set(task.project_id, (open.get(task.project_id) ?? 0) + 1);
  }
  const active = new Map<string, number>();
  for (const row of input.projectRows ?? []) if (row.projectId !== null) active.set(row.projectId, row.activeMs);
  return input.projects
    .filter((project) => project.status !== 'archived' && (project.lead_id === input.me || open.has(project.id)))
    .filter((project) => filter.kind !== 'project' || project.id === filter.id)
    .map((project) => ({
      projectId: project.id,
      label: project.name,
      lead: project.lead_id === input.me,
      openTasks: open.get(project.id) ?? 0,
      activeMs: showsTime ? (active.get(project.id) ?? 0) : null,
    }))
    .sort((a, b) => byName(a.label, b.label) || byCodePoint(a.projectId, b.projectId));
}

// ---------------------------------------------------------------------------------------------
// Copy: measurements and footnotes
// ---------------------------------------------------------------------------------------------

/** The definitions every figure, export and doc uses. */
export const MEASUREMENTS = {
  activeTime: 'An enabled application was in the foreground with input within the idle threshold.',
  idleTime: 'A tracked application was in the foreground with no input past the idle threshold.',
  inForeground: 'Active time plus idle time.',
  sessions:
    'Distinct synced time entries contributing to a figure. A session spanning two days counts once in each day, so per-period counts do not add up to the total.',
  unattributed: 'Time with no project and no task.',
  noProjectTaskTime: 'Time on a task that has no project.',
  notBillable: 'Recorded application time — not billable.',
  manualTime: 'Manual time entries aren’t available yet.',
  estimates: 'Task estimates are the task’s own estimate (“Estimate (task)”). Projects have no budgets.',
  taskProgress: 'Current status — not limited by dates or application.',
  overlap: 'Time recorded on several devices at once is counted once; overlap is the time hidden that way.',
} as const;

export const RECONCILIATION =
  'Within one person, each instant counts once: for the first session (by start, end, id) among their active sessions covering it, else among their idle ones. Different people are never reconciled against each other. Filters apply after this.';

/** " (2h 05m overlapped)", or nothing without overlap. */
export function overlapClause(overlapMs: number): string {
  return overlapMs > 0 ? ` (${formatDuration(overlapMs)} overlapped)` : '';
}

/** The footnote under every view with time. */
export function analyticsFootnote(overlapMs: number): string {
  return (
    'Recorded application time — not billable. Manual time entries aren’t available yet. ' +
    `Overlapping time from several devices is counted once${overlapClause(overlapMs)}. ` +
    'Sessions appear after they end and sync. Applications hidden in a device’s reports still appear here.'
  );
}

// ---------------------------------------------------------------------------------------------
// Exports: CSV and JSON
// ---------------------------------------------------------------------------------------------

/** The CSV files start with a UTF-8 byte order mark, so spreadsheet apps read names correctly. */
export const CSV_BOM = '\uFEFF';

/** A number already formatted (e.g. seconds with three decimals): written as is. */
export interface CsvNumber {
  readonly csvNumber: string;
}

export type CsvValue = string | number | null | undefined | CsvNumber;

/** Text a spreadsheet would run as a formula (or a control character) gets a leading `'`. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180: quoted when needed, quotes doubled. Text is neutralised against formulas; numbers are not. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'object') return value.csvNumber;
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole CSV file: BOM, header and rows, every line ending in CRLF. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [header.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))];
  return `${CSV_BOM}${lines.map((line) => `${line}\r\n`).join('')}`;
}

/** Seconds with exactly three decimals (ms are whole numbers, so this is exact). */
function seconds(ms: number): number {
  return Math.round(ms) / 1000;
}

function csvSeconds(value: number | null): CsvValue {
  return value === null ? null : { csvNumber: value.toFixed(3) };
}

/** Summary CSV columns. Append-only: new columns go at the end. */
export const SUMMARY_COLUMNS = [
  'section',
  'period_start',
  'member_id',
  'member',
  'application_id',
  'application',
  'project_id',
  'project',
  'task_id',
  'task',
  'task_status',
  'task_count',
  'active_seconds',
  'idle_seconds',
  'foreground_seconds',
  'sessions',
  'time_zone',
] as const;

export type SummaryColumn = (typeof SUMMARY_COLUMNS)[number];
export type SummarySection = 'total' | 'period' | 'member' | 'project' | 'task' | 'application' | 'task_status';
export type SummaryRecord = { readonly section: SummarySection } & { readonly [K in Exclude<SummaryColumn, 'section'>]: string | number | null };

export interface SummaryExportInput {
  /** The report's rows; null when the export carries no time (Workspace view, teammates not visible). */
  readonly rows: readonly ReportRow[] | null;
  /** Task progress (`task_status` rows: each status, `overdue`, `due_next_7_days`); null leaves them out. */
  readonly taskProgress: TaskProgressSummary | null;
  readonly labels: ReportLabels;
  readonly timeZone: string;
}

const EMPTY_RECORD: Omit<SummaryRecord, 'section' | 'time_zone'> = {
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
  active_seconds: null,
  idle_seconds: null,
  foreground_seconds: null,
  sessions: null,
};

/**
 * The summary as records: total, periods, members (alphabetical, former members last; never by
 * time), projects, tasks and applications in the report's order, then task progress.
 */
export function summaryRecords(input: SummaryExportInput): SummaryRecord[] {
  const { labels, timeZone } = input;
  const timed = (row: ReportRow) => ({
    active_seconds: seconds(row.activeMs),
    idle_seconds: seconds(row.idleMs),
    foreground_seconds: seconds(row.activeMs + row.idleMs),
    sessions: row.entryCount,
  });
  const records: SummaryRecord[] = [];
  if (input.rows) {
    const parts = splitReport(input.rows);
    records.push({ section: 'total', ...EMPTY_RECORD, ...timed(parts.total), time_zone: timeZone });
    for (const row of parts.periods) {
      records.push({ section: 'period', ...EMPTY_RECORD, period_start: row.bucketStart, ...timed(row), time_zone: timeZone });
    }
    const members = parts.members
      .filter((row) => row.userId !== null)
      .map((row) => ({ row, userId: row.userId ?? '', ...labels.member(row.userId ?? '') }))
      .sort(byPerson);
    for (const { row, userId, name } of members) {
      records.push({ section: 'member', ...EMPTY_RECORD, member_id: userId, member: name, ...timed(row), time_zone: timeZone });
    }
    for (const row of parts.projects) {
      records.push({
        section: 'project',
        ...EMPTY_RECORD,
        project_id: row.projectId,
        project: labels.project(row.projectId, row.unattributed === true).label,
        ...timed(row),
        time_zone: timeZone,
      });
    }
    for (const row of parts.tasks) {
      const task = labels.task(row.taskId, row.projectId);
      records.push({
        section: 'task',
        ...EMPTY_RECORD,
        project_id: row.projectId,
        project: labels.project(row.projectId, row.taskId === null).label,
        task_id: row.taskId,
        task: task.label,
        task_status: task.status,
        ...timed(row),
        time_zone: timeZone,
      });
    }
    for (const row of parts.applications) {
      records.push({
        section: 'application',
        ...EMPTY_RECORD,
        application_id: row.applicationId,
        application: row.applicationName,
        ...timed(row),
        time_zone: timeZone,
      });
    }
  }
  if (input.taskProgress) {
    const progress = input.taskProgress;
    const counts: [string, number][] = [
      ...PROGRESS_STATUSES.map((status): [string, number] => [status, progress.counts[status]]),
      ['overdue', progress.overdue],
      ['due_next_7_days', progress.dueSoon],
    ];
    for (const [status, count] of counts) {
      records.push({ section: 'task_status', ...EMPTY_RECORD, task_status: status, task_count: count, time_zone: timeZone });
    }
  }
  return records;
}

const SECONDS_COLUMNS: ReadonlySet<string> = new Set(['active_seconds', 'idle_seconds', 'foreground_seconds']);

function recordsToCsv<C extends string>(columns: readonly C[], records: readonly { readonly [K in C]: string | number | null }[]): string {
  return toCsv(
    columns,
    records.map((record) =>
      columns.map((column) => {
        const value = record[column];
        return SECONDS_COLUMNS.has(column) && typeof value === 'number' ? csvSeconds(value) : value;
      }),
    ),
  );
}

/** The Summary CSV file (BOM, CRLF). */
export function buildSummaryCsv(input: SummaryExportInput): string {
  return recordsToCsv(SUMMARY_COLUMNS, summaryRecords(input));
}

export type ExportReport = 'my-summary' | 'workspace-summary' | 'my-sessions';

export type TimeOfMeta =
  | { readonly kind: 'me' }
  | { readonly kind: 'everyone' }
  | { readonly kind: 'person'; readonly userId: string; readonly name: string };

export type ProjectFilterMeta = { readonly kind: 'all' } | { readonly kind: 'unattributed' } | { readonly kind: 'project'; readonly id: string; readonly name: string };

export interface SummaryExportMeta {
  readonly report: 'my-summary' | 'workspace-summary';
  readonly workspace: { readonly id: string; readonly name: string };
  readonly view: AnalyticsView;
  readonly timeOf: TimeOfMeta;
  readonly range: { readonly from: string; readonly to: string; readonly timeZone: string };
  readonly filters: {
    readonly project: ProjectFilterMeta;
    readonly applicationId: string | null;
    readonly applicationName: string | null;
  };
  readonly bucket: ReportBucket;
  /** ISO instant. */
  readonly generatedAt: string;
  /** The server's `teammates_visible`; null when no time is exported. */
  readonly teammatesVisible: boolean | null;
}

/** The Summary JSON file: `meta` (formatVersion 1, definitions, filters) and the CSV's records. */
export function buildSummaryJson(input: SummaryExportInput, meta: SummaryExportMeta): string {
  const document = {
    meta: {
      formatVersion: 1,
      ...meta,
      measurements: MEASUREMENTS,
      notBillable: true,
      manualTime: 'not available',
      reconciliation: RECONCILIATION,
    },
    rows: summaryRecords(input),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** "My sessions" columns. Append-only. */
export const SESSION_COLUMNS = [
  'id',
  'started_at_utc',
  'ended_at_utc',
  'local_start',
  'local_end',
  'time_zone',
  'application_id',
  'application',
  'kind',
  'active_seconds',
  'idle_seconds',
  'project_id',
  'project',
  'task_id',
  'task',
] as const;

export type SessionColumn = (typeof SESSION_COLUMNS)[number];
export type SessionRecord = { readonly [K in SessionColumn]: string | number | null };

const localFormats = new Map<string, Intl.DateTimeFormat>();

function localFormat(timeZone: string): Intl.DateTimeFormat {
  let format = localFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    localFormats.set(timeZone, format);
  }
  return format;
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** An instant as ISO 8601 local time with its offset in `timeZone`: `2026-11-03T09:00:00.000+01:00`. */
export function formatLocalIso(ms: number, timeZone: string): string {
  const parts = localFormat(timeZone).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = part('year');
  const month = part('month');
  const day = part('day');
  const hour = part('hour');
  const minute = part('minute');
  const second = part('second');
  const millis = ((ms % 1000) + 1000) % 1000;
  const offsetMinutes = Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - (ms - millis)) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const offset = Math.abs(offsetMinutes);
  return (
    `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(millis, 3)}` +
    `${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`
  );
}

/** Whole sessions (not clipped, not reconciled), in the order given. */
export function sessionRecords(sessions: readonly MySession[], labels: ReportLabels, timeZone: string): SessionRecord[] {
  return sessions.map((session) => {
    const startMs = Date.parse(session.started_at);
    const endMs = Date.parse(session.ended_at);
    const unattributed = session.project_id === null && session.task_id === null;
    return {
      id: session.id,
      started_at_utc: new Date(startMs).toISOString(),
      ended_at_utc: new Date(endMs).toISOString(),
      local_start: formatLocalIso(startMs, timeZone),
      local_end: formatLocalIso(endMs, timeZone),
      time_zone: timeZone,
      application_id: session.application_id,
      application: session.application_name,
      kind: session.kind,
      active_seconds: seconds(session.active_ms),
      idle_seconds: seconds(session.idle_ms),
      project_id: session.project_id,
      project: labels.project(session.project_id, unattributed).label,
      task_id: session.task_id,
      task: labels.task(session.task_id, session.project_id).label,
    };
  });
}

/** The "My sessions" CSV file (BOM, CRLF). */
export function buildSessionsCsv(sessions: readonly MySession[], labels: ReportLabels, timeZone: string): string {
  return recordsToCsv(SESSION_COLUMNS, sessionRecords(sessions, labels, timeZone));
}

export interface SessionsExportMeta {
  readonly workspace: { readonly id: string; readonly name: string };
  readonly range: { readonly from: string; readonly to: string; readonly timeZone: string };
  /** The page's filters the sessions follow (as in the summary), and the card's "Only unattributed". */
  readonly filters: {
    readonly project: ProjectFilterMeta;
    readonly applicationId: string | null;
    readonly applicationName: string | null;
    /** Only sessions with no project and no task (the Unattributed project filter or the card's toggle). */
    readonly unattributedOnly: boolean;
  };
  /** ISO instant. */
  readonly generatedAt: string;
}

/** The "My sessions" JSON file. */
export function buildSessionsJson(sessions: readonly MySession[], labels: ReportLabels, meta: SessionsExportMeta): string {
  const document = {
    meta: {
      formatVersion: 1,
      report: 'my-sessions',
      ...meta,
      sessions:
        'Your own sessions overlapping the range and matching the filters, whole (not clipped to the range) and not reconciled, so they can add up to more than the summary.',
      measurements: MEASUREMENTS,
      notBillable: true,
      manualTime: 'not available',
    },
    rows: sessionRecords(sessions, labels, meta.range.timeZone),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Whether an export can be written now: the report (or, where no time is shown, the task
 * progress) is in, and so is every name the file is labelled with. The project and task lists
 * must have loaded (a file never says "Unknown project" for one that is only still loading, or
 * when the lists failed: their Retry is on the page), and former members' names must not be
 * pending (once they fail, "Former member" is the label).
 */
export function exportReady(input: {
  readonly showsTime: boolean;
  readonly report: boolean;
  readonly taskProgress: boolean;
  readonly projects: boolean;
  readonly tasks: boolean;
  readonly formerNamesPending: boolean;
}): boolean {
  if (!input.projects || !input.tasks || input.formerNamesPending) return false;
  return input.showsTime ? input.report : input.taskProgress;
}

/** `[a-z0-9-]`, at most 40 characters, or `workspace`. */
export function workspaceSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'workspace';
}

/** `studio-pulse_<workspace-slug>_<report>_<from>_to_<to>.<csv|json>`. */
export function exportFileName(input: {
  readonly workspaceName: string;
  readonly report: ExportReport;
  readonly fromDay: string;
  readonly toDay: string;
  readonly format: 'csv' | 'json';
}): string {
  return `studio-pulse_${workspaceSlug(input.workspaceName)}_${input.report}_${input.fromDay}_to_${input.toDay}.${input.format}`;
}

// ---------------------------------------------------------------------------------------------
// Saved preferences (this browser's localStorage; separate from tracking data)
// ---------------------------------------------------------------------------------------------

export type ProjectInsightsRange = 'all' | 'last90' | 'last30';

/** A saved filter preset. No person is ever saved. */
export interface SavedView {
  readonly id: string;
  /** 1 to 60 characters. */
  readonly name: string;
  readonly view: AnalyticsView;
  readonly range: RangeChoice;
  readonly bucket: BucketChoice;
  readonly projectFilter: ProjectFilter;
  readonly applicationId: string | null;
}

export interface AnalyticsPreferences {
  readonly version: 1;
  /** The preferred dashboard view. */
  readonly view: AnalyticsView;
  readonly range: RangeChoice;
  readonly bucket: BucketChoice;
  /** The reporting zone; null follows the browser's. */
  readonly timeZone: string | null;
  readonly projectFilter: ProjectFilter;
  readonly applicationId: string | null;
  readonly projectInsightsRange: ProjectInsightsRange;
  /** At most `MAX_SAVED_VIEWS`. */
  readonly presets: readonly SavedView[];
}

export const MAX_SAVED_VIEWS = 20;
export const SAVED_VIEW_NAME_MAX = 60;
/** Preferences are written this long after the last change. */
export const PREFERENCES_WRITE_DELAY_MS = 500;

export const DEFAULT_PREFERENCES: AnalyticsPreferences = {
  version: 1,
  view: 'mine',
  range: { preset: 'last7' },
  bucket: 'auto',
  timeZone: null,
  projectFilter: ALL_PROJECTS,
  applicationId: null,
  projectInsightsRange: 'all',
  presets: [],
};

/** Per person and workspace. Preferences (preset names too) stay in this browser after sign-out. */
export function preferencesKey(userId: string, workspaceId: string): string {
  return `studio-pulse:analytics:${userId}:${workspaceId}`;
}

/** The database's accepted zone names: IANA `Area/Location` or UTC (not `UTC+3`, not `CET`). */
const ZONE_PATTERN = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+)+)$/;
const PRESETS: readonly RangePreset[] = ['today', 'yesterday', 'last7', 'last30', 'custom'];
const BUCKET_CHOICES: readonly BucketChoice[] = ['auto', 'day', 'week', 'month'];
const INSIGHTS_RANGES: readonly ProjectInsightsRange[] = ['all', 'last90', 'last30'];

/** A zone the report accepts and this browser knows. */
export function isReportTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !ZONE_PATTERN.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Zone choices: this browser's zones, UTC, the browser's own and the saved one, sorted. */
export function timeZoneOptions(browserZone: string, savedZone: string | null, supported?: readonly string[]): string[] {
  let zones = supported;
  if (!zones) {
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch {
      zones = [];
    }
  }
  const all = new Set<string>([...zones, 'UTC', browserZone, ...(savedZone ? [savedZone] : [])]);
  return [...all].filter(isReportTimeZone).sort(byCodePoint);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** A preset, or a custom range the report would accept (real days in order, at most 366, 2020 to 2099). */
function readRange(value: unknown): RangeChoice | undefined {
  if (!isRecord(value)) return undefined;
  const preset = oneOf(PRESETS, value.preset);
  if (!preset) return undefined;
  if (preset !== 'custom') return { preset };
  if (!isDay(value.customFrom) || !isDay(value.customTo)) return undefined;
  if (!validateCustomRange(value.customFrom, value.customTo).ok) return undefined;
  if (value.customFrom < MIN_REPORT_DAY || value.customTo > MAX_REPORT_DAY) return undefined;
  return { preset, customFrom: value.customFrom, customTo: value.customTo };
}

function readProjectFilter(value: unknown): ProjectFilter | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'all') return ALL_PROJECTS;
  if (value.kind === 'unattributed') return { kind: 'unattributed' };
  if (value.kind === 'project' && typeof value.id === 'string' && UUID.test(value.id)) return { kind: 'project', id: value.id.toLowerCase() };
  return undefined;
}

/** `null` is a valid "no application filter"; a malformed id is not. */
function readApplicationId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && APPLICATION_ID_PATTERN.test(value) ? value : undefined;
}

function readSavedView(value: unknown): SavedView | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 64 ? value.id : undefined;
  const name = typeof value.name === 'string' ? validateSavedViewName(value.name) : undefined;
  const view = oneOf<AnalyticsView>(['mine', 'workspace'], value.view);
  const range = readRange(value.range);
  const bucket = oneOf(BUCKET_CHOICES, value.bucket);
  const projectFilter = readProjectFilter(value.projectFilter);
  const applicationId = readApplicationId(value.applicationId);
  if (!id || !name?.ok || !view || !range || !bucket || !projectFilter || applicationId === undefined) return undefined;
  return { id, name: name.value, view, range, bucket, projectFilter, applicationId };
}

/**
 * Preferences from anything (what `JSON.parse` returned): each invalid or missing field falls back
 * to its default and the rest is kept; an invalid saved view is dropped, and at most 20 are kept.
 * Unknown fields (a person filter included) are never carried over.
 */
export function validatePreferences(value: unknown): AnalyticsPreferences {
  if (!isRecord(value)) return DEFAULT_PREFERENCES;
  const presets: SavedView[] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(value.presets) ? value.presets : []) {
    const preset = readSavedView(item);
    if (!preset || ids.has(preset.id) || presets.length >= MAX_SAVED_VIEWS) continue;
    ids.add(preset.id);
    presets.push(preset);
  }
  const applicationId = readApplicationId(value.applicationId);
  return {
    version: 1,
    view: oneOf<AnalyticsView>(['mine', 'workspace'], value.view) ?? DEFAULT_PREFERENCES.view,
    range: readRange(value.range) ?? DEFAULT_PREFERENCES.range,
    bucket: oneOf(BUCKET_CHOICES, value.bucket) ?? DEFAULT_PREFERENCES.bucket,
    timeZone: isReportTimeZone(value.timeZone) ? value.timeZone : null,
    projectFilter: readProjectFilter(value.projectFilter) ?? DEFAULT_PREFERENCES.projectFilter,
    applicationId: applicationId === undefined ? null : applicationId,
    projectInsightsRange: oneOf(INSIGHTS_RANGES, value.projectInsightsRange) ?? DEFAULT_PREFERENCES.projectInsightsRange,
    presets,
  };
}

/** Preferences from stored text: unreadable text gives the defaults. */
export function parsePreferences(text: string | null): AnalyticsPreferences {
  if (text === null) return DEFAULT_PREFERENCES;
  try {
    return validatePreferences(JSON.parse(text));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function serializePreferences(preferences: AnalyticsPreferences): string {
  return JSON.stringify(validatePreferences(preferences));
}

/** localStorage, or null where the browser refuses it (private modes, blocked storage). */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPreferences(storage: Pick<Storage, 'getItem'> | null, userId: string, workspaceId: string): AnalyticsPreferences {
  if (!storage) return DEFAULT_PREFERENCES;
  try {
    return parsePreferences(storage.getItem(preferencesKey(userId, workspaceId)));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Whether the preferences were stored (storage full or refused: they last for this page only). */
export function writePreferences(
  storage: Pick<Storage, 'setItem'> | null,
  userId: string,
  workspaceId: string,
  preferences: AnalyticsPreferences,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(preferencesKey(userId, workspaceId), serializePreferences(preferences));
    return true;
  } catch {
    return false;
  }
}

export function validateSavedViewName(name: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string } {
  const value = name.trim();
  if (value.length === 0) return { ok: false, message: 'Name the view.' };
  if ([...value].length > SAVED_VIEW_NAME_MAX) return { ok: false, message: `Use at most ${SAVED_VIEW_NAME_MAX} characters.` };
  return { ok: true, value };
}

export type SavedViewFields = Pick<SavedView, 'view' | 'range' | 'bucket' | 'projectFilter' | 'applicationId'>;

/** Why a view cannot be saved while the custom range is incomplete or invalid. */
export const SAVE_VIEW_RANGE_MESSAGE = 'Fix the custom range before saving this view.';

/**
 * Save the current view under a name. A view with the same name (ignoring case) is replaced and
 * keeps its id; otherwise `id` names the new one. At most 20. A view whose range storage would
 * refuse (an incomplete or invalid custom range) is refused here, so what is listed is what is
 * kept: it never vanishes on the next visit, and never replaces a valid view of the same name.
 */
export function saveView(
  preferences: AnalyticsPreferences,
  input: SavedViewFields & { readonly id: string; readonly name: string },
): { readonly ok: true; readonly preferences: AnalyticsPreferences } | { readonly ok: false; readonly message: string } {
  const name = validateSavedViewName(input.name);
  if (!name.ok) return name;
  const range = readRange(input.range);
  if (!range) return { ok: false, message: SAVE_VIEW_RANGE_MESSAGE };
  const fields: SavedViewFields = {
    view: input.view,
    range,
    bucket: input.bucket,
    projectFilter: input.projectFilter,
    applicationId: input.applicationId,
  };
  const same = preferences.presets.find((preset) => preset.name.toLocaleLowerCase() === name.value.toLocaleLowerCase());
  if (same) {
    const presets = preferences.presets.map((preset) => (preset.id === same.id ? { ...fields, id: same.id, name: name.value } : preset));
    return { ok: true, preferences: { ...preferences, presets } };
  }
  if (preferences.presets.length >= MAX_SAVED_VIEWS) {
    return { ok: false, message: `You can keep up to ${MAX_SAVED_VIEWS} saved views. Delete one first.` };
  }
  return { ok: true, preferences: { ...preferences, presets: [...preferences.presets, { ...fields, id: input.id, name: name.value }] } };
}

export function deleteView(preferences: AnalyticsPreferences, id: string): AnalyticsPreferences {
  return { ...preferences, presets: preferences.presets.filter((preset) => preset.id !== id) };
}

/** The preferences with a saved view's filters applied, or null when it no longer exists. */
export function applySavedView(preferences: AnalyticsPreferences, id: string): AnalyticsPreferences | null {
  const preset = preferences.presets.find((item) => item.id === id);
  if (!preset) return null;
  return {
    ...preferences,
    view: preset.view,
    range: preset.range,
    bucket: preset.bucket,
    projectFilter: preset.projectFilter,
    applicationId: preset.applicationId,
  };
}
