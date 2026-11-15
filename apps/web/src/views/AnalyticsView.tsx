/**
 * Analytics (Phase 3A): the page's container. It owns the filters (saved in this browser, never
 * in the URL), asks for the report and hands plain view models to the components in ./analytics.
 *
 * - My work: the viewer's own time and tasks. Workspace: the team, as far as the viewer may see it.
 * - The database decides whose time a report holds (security invoker + RLS). The page predicts
 *   `teammates_visible` from the cached workspace, and the report's total row has the last word.
 * - Workspace view without visible teammates asks for no time at all: tasks only.
 * - Sessions are listed and exported for the viewer only; teammates appear as aggregates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addDays, startOfLocalDay } from '@studio-pulse/time-engine';

import * as api from '../lib/api';
import type { MySession, MySessionsQuery } from '../lib/api';
import {
  ALL,
  ALL_PROJECTS,
  DEFAULT_PREFERENCES,
  EVERYONE,
  PREFERENCES_WRITE_DELAY_MS,
  allowedBuckets,
  analyticsSummaryKey,
  applicationColors,
  applicationItems,
  applicationOptions,
  applySavedView,
  assignedProjects,
  browserStorage,
  buildSessionsCsv,
  buildSessionsJson,
  buildSummaryCsv,
  buildSummaryJson,
  createReportLabels,
  decodeProjectFilter,
  deleteView,
  encodeProjectFilter,
  exportFileName,
  exportReady,
  formatDayRange,
  isReportTimeZone,
  memberItems,
  mySessionsKey,
  periodSeries,
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
  saveView,
  sessionQueryFilters,
  showsPreviousReference,
  splitReport,
  standingVerdict,
  summarizeTaskProgress,
  summaryParams,
  taskItems,
  teammatesVisibleNow,
  timeOfOptions,
  timeZoneOptions,
  unattributedTime,
  upcomingDeadlines,
  whoseTime,
  withoutApplicationFilter,
  writePreferences,
} from '../lib/analytics';
import type {
  AnalyticsPreferences,
  AnalyticsView as ViewKind,
  BucketChoice,
  PeriodPoint,
  ProjectFilter,
  ProjectFilterMeta,
  RangeChoice,
  ReportBucket,
  ReportRange,
  ReportRow,
  SummaryExportInput,
  SummaryExportMeta,
  TimeOfMeta,
  VisibilityVerdict,
} from '../lib/analytics';
import { downloadFile } from '../lib/download';
import { asProblem, isTimeZoneProblem } from '../lib/errors';
import type { Problem } from '../lib/errors';
import { TIME_ZONE } from '../lib/format';
import { formatRoute } from '../lib/router';
import type { Route } from '../lib/router';
import { useQuery } from '../lib/store';
import { PageHeader, ProblemBanner } from '../components/common';
import { useFormerNames, useProjects, useRefresh, useTasks, useWorkspace } from '../app/workspace';

import {
  ActivityCard,
  AnalyticsFootnote,
  AnalyticsHeaderActions,
  AnalyticsToolbar,
  ApplicationsCard,
  AssignedProjectsCard,
  LiveRegion,
  MembersCard,
  PrivacyNote,
  ProjectsCard,
  RecentSessionsCard,
  ReportSettingsDialog,
  SummaryTiles,
  TaskProgressCard,
  TimeByTaskCard,
  TimeZoneNotice,
  UpcomingDeadlinesCard,
  WorkspacePrivatePanel,
  dayTimeline,
  sessionRows,
  taskListItems,
} from './analytics';
import type { ActivityTimelineState, ExportKind, PreviousReference, SourceState, TimeOfFilter } from './analytics';

/** Sessions per page of the Recent sessions list. */
const SESSIONS_PAGE = 20;
/** A single day's timeline reads at most this many sessions. */
const TIMELINE_MAX = 2_000;

const ANALYTICS_ROUTE: Route = { name: 'analytics' };
const TIME_HREF = formatRoute({ name: 'time' });
/** This browser's zone, or UTC where the database would not take its name. */
const BROWSER_ZONE = isReportTimeZone(TIME_ZONE) ? TIME_ZONE : 'UTC';

const NO_ROWS: readonly ReportRow[] = [];
const NO_POINTS: readonly PeriodPoint[] = [];
const NO_SESSIONS: readonly MySession[] = [];
const MY_WORK_EXPORTS: readonly ExportKind[] = ['summary-csv', 'summary-json', 'sessions-csv', 'sessions-json'];
const WORKSPACE_EXPORTS: readonly ExportKind[] = ['summary-csv', 'summary-json'];
const EXPORT_NAME: Readonly<Record<ExportKind, string>> = {
  'summary-csv': 'Summary CSV',
  'summary-json': 'Summary JSON',
  'sessions-csv': 'My sessions CSV',
  'sessions-json': 'My sessions JSON',
};

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

/**
 * Today in the reporting zone, re-rendering when that zone's day turns: a timer for its midnight,
 * and a check when the tab is shown again (background tabs and a sleeping computer delay timers).
 */
function useReportingToday(timeZone: string): string {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      const now = Date.now();
      // The zone's next midnight (DST-safe), and a second more so the new day has surely begun.
      const midnight = startOfLocalDay(addDays(reportingToday(now, timeZone), 1), timeZone);
      timer = window.setTimeout(check, Math.max(1_000, midnight - now + 1_000));
    };
    const check = () => {
      setTick((current) => current + 1);
      schedule();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [timeZone]);
  // `tick` is the clock: the day is read again whenever it moves.
  return useMemo(() => reportingToday(Date.now(), timeZone), [timeZone, tick]);
}

interface Shown<T, C> {
  readonly data: T;
  /** What `data` was asked for (its range, bucket…): view models are built from this, not from the newer choice. */
  readonly context: C;
  /** `data` answers an earlier request; the current one is still loading. */
  readonly stale: boolean;
}

/**
 * The result to show for a request: its own, or while that loads the last one of the same `group`
 * (shown dimmed) instead of blanking to skeletons. A result of another group is never reused: it
 * would be someone else's time under this view's labels.
 */
function useShown<T, C>(group: string, data: T | undefined, context: C, usable: boolean): Shown<T, C> | null {
  const [kept, setKept] = useState<{ readonly group: string; readonly data: T; readonly context: C } | null>(null);
  useEffect(() => {
    if (data !== undefined) setKept({ group, data, context });
  }, [group, data, context]);
  const fallback = data === undefined && usable && kept !== null && kept.group === group ? kept : null;
  return useMemo(() => {
    if (data !== undefined) return { data, context, stale: false };
    if (fallback) return { data: fallback.data, context: fallback.context, stale: true };
    return null;
  }, [data, context, fallback]);
}

/** What a shown report was asked for. */
interface ReportContext {
  readonly fromDay: string;
  readonly toDay: string;
  readonly bucket: ReportBucket;
  /** "Last 7 days", "3–9 Nov". */
  readonly rangeLabel: string;
}

/** Later pages of the session list: they belong to one first page and go when it is read again. */
interface MoreSessions {
  readonly base: readonly MySession[];
  readonly pages: readonly MySession[];
  /** The last page was short: there are no more. */
  readonly done: boolean;
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

export function AnalyticsView() {
  const { user, workspace } = useWorkspace();
  // Filters, saved views and the "Time of" choice belong to one person in one workspace.
  return <AnalyticsPage key={`${user.id}:${workspace.id}`} />;
}

function AnalyticsPage() {
  const { client, user, workspace, members, reloadWorkspaces } = useWorkspace();
  const refresh = useRefresh();
  const projects = useProjects();
  const tasks = useTasks();
  const me = user.id;
  const workspaceId = workspace.id;

  // The cached workspace (role, visibility) may be old: ask again whenever the page opens.
  useEffect(() => {
    void reloadWorkspaces();
  }, [reloadWorkspaces]);

  // --- Preferences: read once, written a moment after each change. The person under "Time of"
  // is deliberately not part of them.
  const [prefs, setPrefs] = useState<AnalyticsPreferences>(() => readPreferences(browserStorage(), me, workspaceId));
  const [personId, setPersonId] = useState<string | null>(null);
  const loadedPrefs = useRef(prefs);
  const unsavedPrefs = useRef<AnalyticsPreferences | null>(null);
  const storePrefs = useCallback(
    (next: AnalyticsPreferences) => {
      const storage = browserStorage();
      // Project Insights keeps its range under the same key: leave what it stored since.
      const projectInsightsRange = readPreferences(storage, me, workspaceId).projectInsightsRange;
      writePreferences(storage, me, workspaceId, { ...next, projectInsightsRange });
    },
    [me, workspaceId],
  );
  useEffect(() => {
    if (prefs === loadedPrefs.current) return undefined;
    unsavedPrefs.current = prefs;
    const timer = window.setTimeout(() => {
      unsavedPrefs.current = null;
      storePrefs(prefs);
    }, PREFERENCES_WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [prefs, storePrefs]);
  useEffect(
    () => () => {
      // Leaving the page within the delay still keeps the last change.
      if (unsavedPrefs.current) storePrefs(unsavedPrefs.current);
    },
    [storePrefs],
  );
  const update = useCallback((patch: Partial<AnalyticsPreferences>) => setPrefs((current) => ({ ...current, ...patch })), []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [onlyUnattributed, setOnlyUnattributed] = useState(false);

  // --- Reporting zone. A zone the database refuses falls back to UTC for this visit.
  const [refusedZone, setRefusedZone] = useState<string | null>(null);
  const timeZone = refusedZone !== null ? 'UTC' : (prefs.timeZone ?? BROWSER_ZONE);
  const today = useReportingToday(timeZone);

  // --- Range. While a custom range is incomplete or invalid the last valid range stays on screen.
  const view = prefs.view;
  const resolved = useMemo(
    () => resolveAnalyticsRange(prefs.range, { now: Date.now(), timeZone }),
    // `today` stands for the clock: presets move when the day turns.
      [prefs.range, timeZone, today],
  );
  const [lastRange, setLastRange] = useState<ReportRange | null>(null);
  useEffect(() => {
    if (resolved.ok) setLastRange(resolved.range);
  }, [resolved]);
  const range = useMemo<ReportRange>(() => {
    if (resolved.ok) return resolved.range;
    if (lastRange && lastRange.timeZone === timeZone) return lastRange;
    const fallback = resolveAnalyticsRange(DEFAULT_PREFERENCES.range, { now: Date.now(), timeZone });
    if (!fallback.ok) throw new Error(fallback.message);
    return fallback.range;
  }, [resolved, lastRange, timeZone]);
  const rangeError = resolved.ok ? null : resolved.message;
  const bucket = resolveBucket(prefs.bucket, range.days);

  // --- Whose time: the prediction from the cached workspace, until a report says otherwise for
  // that same workspace state.
  const [serverSaid, setServerSaid] = useState<VisibilityVerdict | null>(null);
  const teammatesVisible = teammatesVisibleNow(serverSaid, workspace);
  // A verdict holds for the workspace state it was given in. Once the cached role or visibility
  // moves on, it is dropped, so a later return to that state is predicted (and asked) afresh
  // rather than answered by an old verdict. A reload with the same pair keeps it (no loop: keyed
  // on the pair, not on the workspace object, which every reload replaces).
  // A report read before this instant is read again before its verdict is believed: it moves to
  // the page's opening, to each change of the cached (role, visibility) and to each Refresh.
  const verdictsSince = useRef(Date.now());
  const cachedRole = workspace.role;
  const cachedVisibility = workspace.timeEntryVisibility;
  useEffect(() => {
    verdictsSince.current = Date.now();
    setServerSaid((said) => standingVerdict(said, { role: cachedRole, timeEntryVisibility: cachedVisibility }));
  }, [cachedRole, cachedVisibility]);
  const scope = useMemo(() => resolveScope({ view, me, personId, teammatesVisible }), [view, me, personId, teammatesVisible]);

  // A saved project that no longer exists is not asked for.
  const savedProjectFilter = prefs.projectFilter;
  const projectFilter = useMemo<ProjectFilter>(() => {
    if (savedProjectFilter.kind !== 'project' || projects.data === undefined) return savedProjectFilter;
    return projects.data.some((project) => project.id === savedProjectFilter.id) ? savedProjectFilter : ALL_PROJECTS;
  }, [savedProjectFilter, projects.data]);
  const applicationId = prefs.applicationId;

  // --- The report, the same report without the application filter (option lists and colours;
  // the same request when no application is chosen) and the previous period (its total only).
  const params = useMemo(
    () => (scope.showsTime ? summaryParams({ workspaceId, range, bucket, scope, projectFilter, applicationId }) : null),
    [scope, workspaceId, range, bucket, projectFilter, applicationId],
  );
  const summaryKey = params ? analyticsSummaryKey(params) : null;
  // Rows are tagged with their read time where they are read (api.analyticsSummary): Project
  // Insights fills the same keys.
  const summary = useQuery(summaryKey, () => (params ? api.analyticsSummary(client, params) : Promise.resolve([])));

  const optionParams = useMemo(() => (params ? withoutApplicationFilter(params) : null), [params]);
  const options = useQuery(optionParams ? analyticsSummaryKey(optionParams) : null, () =>
    optionParams ? api.analyticsSummary(client, optionParams) : Promise.resolve([]),
  );

  const wantsPrevious = params !== null && showsPreviousReference(range, scope, me);
  const previousParams = useMemo(
    () => (wantsPrevious && params ? previousPeriodParams(params, range.previous) : null),
    [wantsPrevious, params, range],
  );
  const previous = useQuery(previousParams ? analyticsSummaryKey(previousParams) : null, () =>
    previousParams ? api.analyticsSummary(client, previousParams) : Promise.resolve([]),
  );

  const reloadSummary = summary.reload;
  const reloadPrevious = previous.reload;
  const retrySummary = useCallback(() => void reloadSummary(), [reloadSummary]);
  const retryPrevious = useCallback(() => void reloadPrevious(), [reloadPrevious]);

  // "Unknown time zone": show the notice, use UTC and forget the saved zone.
  const zoneRefused = summary.problem !== null && isTimeZoneProblem(summary.problem) && timeZone !== 'UTC';
  useEffect(() => {
    if (!zoneRefused) return;
    setRefusedZone(timeZone);
    update({ timeZone: null });
  }, [zoneRefused, timeZone, update]);

  // The report's own word on visibility wins over the prediction. A report read before this visit
  // or before the workspace's current state is read again first: the setting may have moved since.
  const summaryRows = summary.data;
  const reportedVisible = useMemo(() => (summaryRows ? splitReport(summaryRows).total.teammatesVisible : null), [summaryRows]);
  useEffect(() => {
    if (summaryRows === undefined || reportedVisible === null || reportedVisible === teammatesVisible) return;
    if ((api.reportReadAt(summaryRows) ?? 0) < verdictsSince.current) {
      void reloadSummary();
      return;
    }
    setServerSaid({ role: workspace.role, visibility: workspace.timeEntryVisibility, value: reportedVisible });
    void reloadWorkspaces();
  }, [summaryRows, reportedVisible, teammatesVisible, workspace.role, workspace.timeEntryVisibility, reloadSummary, reloadWorkspaces]);

  // --- What is on screen: this request's report, or the last one of the same view and person
  // (dimmed) while it loads.
  const group = `${view}|${scope.personId ?? ''}`;
  const context = useMemo<ReportContext>(
    () => ({ fromDay: range.fromDay, toDay: range.toDay, bucket, rangeLabel: range.label }),
    [range.fromDay, range.toDay, range.label, bucket],
  );
  const shown = useShown(group, summary.data, context, summary.problem === null);
  const shownOptions = useShown(group, options.data, null, options.problem === null);
  const stale = shown?.stale ?? false;
  const updatedAt = shown ? api.reportReadAt(shown.data) : null;

  const projectsPending = projects.data === undefined && projects.problem === null;
  const tasksPending = tasks.data === undefined && tasks.problem === null;
  // Names come from the project and task lists: wait for them rather than show "Unknown project".
  const timeLoading = scope.showsTime && (shown === null ? summary.problem === null : projectsPending || tasksPending);
  const timeFailed = scope.showsTime && shown === null && summary.problem !== null;

  const parts = useMemo(() => (shown ? splitReport(shown.data) : null), [shown]);
  const optionParts = useMemo(() => (shownOptions ? splitReport(shownOptions.data) : null), [shownOptions]);

  // "Time of" lists former members from the report of everyone; it is remembered while one
  // person is picked (their own report has only their row).
  const [everyoneRows, setEveryoneRows] = useState<readonly ReportRow[]>(NO_ROWS);
  const everyoneNow = view === 'workspace' && scope.showsTime && scope.userIds === null ? (optionParts?.members ?? null) : null;
  useEffect(() => {
    if (everyoneNow) setEveryoneRows(everyoneNow);
  }, [everyoneNow]);
  const memberOptionRows = everyoneNow ?? everyoneRows;

  const formerIds = useMemo(() => {
    const active = new Set(members.map((member) => member.userId));
    const ids = new Set<string>();
    for (const row of [...memberOptionRows, ...(parts?.members ?? NO_ROWS)]) {
      if (row.userId !== null && !active.has(row.userId)) ids.add(row.userId);
    }
    if (scope.personId !== null && !active.has(scope.personId)) ids.add(scope.personId);
    return [...ids];
  }, [members, memberOptionRows, parts, scope.personId]);
  const formerNames = useFormerNames(formerIds);

  const projectList = projects.data;
  const taskList = tasks.data;
  const labels = useMemo(
    () =>
      createReportLabels({
        projects: projectList ?? [],
        tasks: taskList ?? [],
        members,
        ...(formerNames.data ? { formerNames: formerNames.data } : {}),
      }),
    [projectList, taskList, members, formerNames.data],
  );
  const who = useMemo(() => whoseTime(scope, me, labels), [scope, me, labels]);

  // --- Time view models (each memoized: an unrelated change does not redraw the charts).
  const totals = useMemo(() => (parts ? reportTotals(parts.total) : null), [parts]);
  const unattributed = useMemo(() => (parts ? unattributedTime(parts.projects) : null), [parts]);
  const points = useMemo(
    () => (parts && shown ? periodSeries(parts.periods, shown.context) : NO_POINTS),
    [parts, shown],
  );
  const colors = useMemo(() => applicationColors(optionParts?.applications ?? parts?.applications ?? NO_ROWS), [optionParts, parts]);
  const applications = useMemo(() => (parts ? applicationItems(parts.applications, colors) : []), [parts, colors]);
  const projectBars = useMemo(() => (parts ? projectItems(parts.projects, labels) : []), [parts, labels]);
  const taskBars = useMemo(() => (parts ? taskItems(parts.tasks, labels) : []), [parts, labels]);
  const memberRows = useMemo(() => (parts ? memberItems(parts.members, labels) : []), [parts, labels]);
  const bucketOptions = useMemo(() => allowedBuckets(range.days), [range.days]);
  const changeBucket = useCallback((choice: BucketChoice) => update({ bucket: choice }), [update]);

  const previousRows = previous.data;
  const previousProblem = previous.problem;
  const previousReference = useMemo<PreviousReference>(() => {
    if (!wantsPrevious) return { status: 'hidden' };
    if (previousRows) return { status: 'ready', text: previousReferenceText(range, splitReport(previousRows).total.activeMs) };
    if (previousProblem) return { status: 'error', onRetry: retryPrevious };
    return { status: 'loading' };
  }, [wantsPrevious, previousRows, previousProblem, range, retryPrevious]);

  // --- Tasks (current state from the cached lists; not limited by the range or application).
  const reloadTasks = tasks.reload;
  const reloadProjects = projects.reload;
  const retryLists = useCallback(() => {
    void reloadTasks();
    void reloadProjects();
  }, [reloadTasks, reloadProjects]);
  const listsProblem = tasks.problem ?? projects.problem;
  const listsSource = useMemo<SourceState>(
    () => ({ loading: tasksPending || projectsPending, problem: listsProblem, onRetry: retryLists }),
    [tasksPending, projectsPending, listsProblem, retryLists],
  );
  const taskSelection = useMemo(() => ({ projectFilter, assigneeId: scope.taskAssigneeId }), [projectFilter, scope.taskAssigneeId]);
  const progress = useMemo(
    () => (taskList ? summarizeTaskProgress(taskList, { ...taskSelection, today }) : null),
    [taskList, taskSelection, today],
  );
  const timeProjectRows = scope.showsTime ? (parts?.projects ?? NO_ROWS) : null;
  const progressRows = useMemo(
    () =>
      projectProgressRows({
        projects: projectList ?? [],
        tasks: taskList ?? [],
        selection: taskSelection,
        projectRows: timeProjectRows,
        labels,
        today,
      }),
    [projectList, taskList, taskSelection, timeProjectRows, labels, today],
  );
  const deadlines = useMemo(
    () => (view === 'mine' && taskList ? taskListItems(upcomingDeadlines(taskList, { ...taskSelection, today }), projectList ?? null, ANALYTICS_ROUTE) : []),
    [view, taskList, taskSelection, today, projectList],
  );
  const myProjects = useMemo(
    () =>
      view === 'mine' && projectList && taskList
        ? assignedProjects({ projects: projectList, tasks: taskList, me, projectRows: parts ? parts.projects : null, projectFilter })
        : [],
    [view, projectList, taskList, me, parts, projectFilter],
  );

  // --- Recent sessions (My work; the viewer's own rows only). Page 1 is cached; later pages are
  // kept here and go when page 1 is asked again.
  const startIso = useMemo(() => new Date(range.startMs).toISOString(), [range.startMs]);
  const endIso = useMemo(() => new Date(range.endMs).toISOString(), [range.endMs]);
  // The list follows the page's Project and Application filters, like the figures around it;
  // "Only unattributed" narrows it further while no project filter is set.
  const sessionFilters = useMemo(() => sessionQueryFilters(projectFilter, applicationId, onlyUnattributed), [projectFilter, applicationId, onlyUnattributed]);
  const sessionsQuery = useMemo<MySessionsQuery | null>(
    () => (view === 'mine' ? { workspaceId, userId: me, startIso, endIso, ...sessionFilters } : null),
    [view, workspaceId, me, startIso, endIso, sessionFilters],
  );
  const firstPage = useQuery(sessionsQuery ? mySessionsKey({ ...sessionsQuery, limit: SESSIONS_PAGE }) : null, () =>
    sessionsQuery ? api.listMySessions(client, { ...sessionsQuery, limit: SESSIONS_PAGE }) : Promise.resolve([]),
  );
  const shownSessions = useShown('mine', firstPage.data, null, firstPage.problem === null);
  const [more, setMore] = useState<MoreSessions | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreProblem, setMoreProblem] = useState<Problem | null>(null);
  const currentBase = useRef<readonly MySession[] | undefined>(undefined);
  const firstPageRows = firstPage.data;
  useEffect(() => {
    currentBase.current = firstPageRows;
    setLoadingMore(false);
    setMoreProblem(null);
  }, [firstPageRows]);

  const baseSessions = shownSessions?.data ?? NO_SESSIONS;
  const laterSessions = more !== null && more.base === baseSessions ? more : null;
  const sessions = useMemo(
    () => (laterSessions ? [...baseSessions, ...laterSessions.pages] : baseSessions),
    [baseSessions, laterSessions],
  );
  const sessionsStale = shownSessions?.stale ?? false;
  const hasMoreSessions = !sessionsStale && (laterSessions ? !laterSessions.done : baseSessions.length === SESSIONS_PAGE);
  // "Show more" reached the end (not a first page that was short anyway).
  const allSessionsShown = !sessionsStale && laterSessions !== null && laterSessions.done;
  const sessionTable = useMemo(() => sessionRows(sessions, labels, { timeZone, today }), [sessions, labels, timeZone, today]);

  const showMoreSessions = useCallback(async () => {
    const last = sessions[sessions.length - 1];
    if (!sessionsQuery || firstPageRows === undefined || !last) return;
    const base = firstPageRows;
    setLoadingMore(true);
    setMoreProblem(null);
    try {
      const page = await api.listMySessions(client, {
        ...sessionsQuery,
        before: { startedAt: last.started_at, id: last.id },
        limit: SESSIONS_PAGE,
      });
      if (currentBase.current !== base) return;
      setMore({ base, pages: [...sessions.slice(base.length), ...page], done: page.length < SESSIONS_PAGE });
      setAnnouncement(page.length === 0 ? 'No more sessions.' : `${page.length} more ${page.length === 1 ? 'session' : 'sessions'} loaded.`);
    } catch (error) {
      if (currentBase.current === base) setMoreProblem(asProblem(error));
    } finally {
      if (currentBase.current === base) setLoadingMore(false);
    }
  }, [client, sessions, sessionsQuery, firstPageRows]);
  const reloadFirstPage = firstPage.reload;
  const retrySessions = useCallback(() => void reloadFirstPage(), [reloadFirstPage]);
  const onShowMore = useCallback(() => void showMoreSessions(), [showMoreSessions]);

  // --- A single day in My work: that day's timeline instead of a one-point chart. It follows the
  // page's filters, like the figures around it (not the card's "Only unattributed").
  const dayFilters = useMemo(() => sessionQueryFilters(projectFilter, applicationId, false), [projectFilter, applicationId]);
  const dayQuery = useMemo<MySessionsQuery | null>(
    () => (view === 'mine' && range.days === 1 ? { workspaceId, userId: me, startIso, endIso, ...dayFilters } : null),
    [view, range.days, workspaceId, me, startIso, endIso, dayFilters],
  );
  const day = useQuery(dayQuery ? `${mySessionsKey({ ...dayQuery, limit: TIMELINE_MAX })}:day` : null, () =>
    dayQuery ? api.listAllMySessions(client, dayQuery, TIMELINE_MAX) : Promise.resolve({ sessions: [], truncated: false }),
  );
  const reloadDay = day.reload;
  const retryDay = useCallback(() => void reloadDay(), [reloadDay]);
  const dayData = day.data;
  const dayProblem = day.problem;
  const timeline = useMemo<ActivityTimelineState | null>(() => {
    if (!dayQuery) return null;
    return {
      loading: dayData === undefined && dayProblem === null,
      problem: dayProblem,
      onRetry: retryDay,
      timeline: dayData
        ? dayTimeline(dayData.sessions, { dayStartMs: range.startMs, dayEndMs: range.endMs, timeZone, nowMs: Date.now(), colors })
        : null,
      truncated: dayData?.truncated ?? false,
    };
  }, [dayQuery, dayData, dayProblem, retryDay, range.startMs, range.endMs, timeZone, colors]);

  // --- Filter options.
  const projectOptions = useMemo(() => projectFilterOptions(projectList ?? []), [projectList]);
  const selectedApplication = useMemo(() => {
    if (applicationId === null) return null;
    const row = [...(optionParts?.applications ?? NO_ROWS), ...(parts?.applications ?? NO_ROWS)].find(
      (candidate) => candidate.applicationId === applicationId,
    );
    return { id: applicationId, name: row?.applicationName ?? null };
  }, [applicationId, optionParts, parts]);
  const appOptions = useMemo(
    () => applicationOptions(optionParts?.applications ?? NO_ROWS, selectedApplication),
    [optionParts, selectedApplication],
  );
  const changePerson = useCallback((value: string) => setPersonId(value === EVERYONE ? null : value), []);
  const timeOf = useMemo<TimeOfFilter | null>(() => {
    if (view !== 'workspace' || !scope.showsTime) return null;
    const value = scope.personId ?? EVERYONE;
    const listed = timeOfOptions(members, memberOptionRows, labels);
    // The picked person stays in the list even without time in this range.
    const all = listed.some((option) => option.value === value) ? listed : [...listed, { value, label: labels.member(value).name }];
    return { value, options: all, onChange: changePerson };
  }, [view, scope, members, memberOptionRows, labels, changePerson]);
  const zoneOptions = useMemo(() => timeZoneOptions(BROWSER_ZONE, prefs.timeZone), [prefs.timeZone]);

  // --- Announcements and freshness.
  useEffect(() => {
    if (summaryRows !== undefined) setAnnouncement(`Analytics updated: ${context.rangeLabel}.`);
    // Announced when a report arrives, not when the label alone changes.
    }, [summaryRows]);

  function onRefresh() {
    // Ask the server again about teammates' time too: no verdict outlives a Refresh.
    verdictsSince.current = Date.now();
    setServerSaid(null);
    refresh('projects');
    // Also everything under `time:` (reports and sessions): moving a task moves its time.
    refresh('tasks');
    void reloadWorkspaces();
  }
  const refreshing = (scope.showsTime && summary.loading) || tasks.loading || projects.loading;

  // --- Exports: built in this tab from what the viewer may read. Sessions are the viewer's own.
  const [exporting, setExporting] = useState(false);
  const [exportProblem, setExportProblem] = useState<Problem | null>(null);
  useEffect(() => {
    setExportProblem(null);
  }, [summaryKey, view]);
  // Exports are labelled from the project and task lists (and former members' names): wait for
  // them, as the cards do, rather than write "Unknown project" for one that is still loading.
  const formerNamesPending = formerIds.length > 0 && formerNames.data === undefined && formerNames.problem === null;
  const exportDisabled = !exportReady({
    showsTime: scope.showsTime,
    report: summary.data !== undefined,
    taskProgress: progress !== null,
    projects: projectList !== undefined,
    tasks: taskList !== undefined,
    formerNamesPending,
  });

  async function runExport(kind: ExportKind) {
    if (exporting || exportDisabled) return;
    const format = kind === 'summary-csv' || kind === 'sessions-csv' ? 'csv' : 'json';
    const workspaceMeta = { id: workspaceId, name: workspace.name };
    const rangeMeta = { from: range.fromDay, to: range.toDay, timeZone };
    const projectMeta: ProjectFilterMeta =
      projectFilter.kind === 'project' ? { ...projectFilter, name: labels.project(projectFilter.id, false).label } : projectFilter;
    setExportProblem(null);
    setExporting(true);
    try {
      if (kind === 'summary-csv' || kind === 'summary-json') {
        const rows = scope.showsTime ? summary.data : null;
        if (rows === undefined) return;
        const report = view === 'mine' ? 'my-summary' : 'workspace-summary';
        const input: SummaryExportInput = { rows, taskProgress: progress, labels, timeZone };
        const timeOfMeta: TimeOfMeta =
          scope.showsTime && scope.userIds === null
            ? { kind: 'everyone' }
            : scope.personId !== null && scope.personId !== me
              ? { kind: 'person', userId: scope.personId, name: labels.member(scope.personId).name }
              : { kind: 'me' };
        const meta: SummaryExportMeta = {
          report,
          workspace: workspaceMeta,
          view,
          timeOf: timeOfMeta,
          range: rangeMeta,
          filters: {
            project: projectMeta,
            applicationId: scope.showsTime ? applicationId : null,
            applicationName: scope.showsTime ? (selectedApplication?.name ?? null) : null,
          },
          bucket,
          generatedAt: new Date().toISOString(),
          teammatesVisible: rows ? splitReport(rows).total.teammatesVisible : null,
        };
        downloadFile({
          fileName: exportFileName({ workspaceName: workspace.name, report, fromDay: range.fromDay, toDay: range.toDay, format }),
          content: format === 'csv' ? buildSummaryCsv(input) : buildSummaryJson(input, meta),
          format,
        });
      } else {
        // Never anyone else's sessions: this export exists in My work only and asks for `me`.
        if (view !== 'mine') return;
        // The sessions the Recent sessions card lists: the page's filters and "Only unattributed".
        const own = await api.listMySessionsForExport(client, { workspaceId, userId: me, startIso, endIso, ...sessionFilters });
        downloadFile({
          fileName: exportFileName({ workspaceName: workspace.name, report: 'my-sessions', fromDay: range.fromDay, toDay: range.toDay, format }),
          content:
            format === 'csv'
              ? buildSessionsCsv(own, labels, timeZone)
              : buildSessionsJson(own, labels, {
                  workspace: workspaceMeta,
                  range: rangeMeta,
                  filters: {
                    project: projectMeta,
                    applicationId,
                    applicationName: selectedApplication?.name ?? null,
                    unattributedOnly: sessionFilters.unattributedOnly === true,
                  },
                  generatedAt: new Date().toISOString(),
                }),
          format,
        });
      }
      setAnnouncement(`${EXPORT_NAME[kind]} downloaded.`);
    } catch (error) {
      setExportProblem(asProblem(error));
    } finally {
      setExporting(false);
    }
  }

  // --- Toolbar and settings handlers.
  function changeView(next: ViewKind) {
    update({ view: next });
  }
  function changeRange(next: RangeChoice) {
    update({ range: next });
  }
  function changeTimeZone(zone: string) {
    setRefusedZone(null);
    // The browser's own zone is the default: saved as "follow this browser".
    update({ timeZone: zone === BROWSER_ZONE ? null : zone });
  }
  /** Why the view was not saved (shown in the dialog), or null. */
  function onSaveView(name: string): string | null {
    const saved = saveView(prefs, {
      id: crypto.randomUUID(),
      name,
      view,
      range: prefs.range,
      bucket: prefs.bucket,
      projectFilter: prefs.projectFilter,
      applicationId,
    });
    if (!saved.ok) return saved.message;
    // Announced by the dialog: this page's live region is inert behind it.
    setPrefs(saved.preferences);
    return null;
  }
  function onApplyView(id: string) {
    const applied = applySavedView(prefs, id);
    if (!applied) return;
    // A saved view never names a person.
    setPersonId(null);
    setPrefs(applied);
    setSettingsOpen(false);
    setAnnouncement(`View “${prefs.presets.find((preset) => preset.id === id)?.name ?? ''}” applied.`);
  }
  function onDeleteView(id: string) {
    // Announced by the dialog, like a save.
    setPrefs(deleteView(prefs, id));
  }

  const rangeText =
    prefs.range.preset !== 'custom'
      ? formatDayRange(range.fromDay, range.toDay, today)
      : rangeError !== null
        ? `Showing ${range.label}`
        : null;
  const shownBucket = shown?.context.bucket ?? bucket;
  const shownRangeLabel = shown?.context.rangeLabel ?? range.label;
  const showSummaryProblem = scope.showsTime && summary.problem !== null && !zoneRefused;

  return (
    <div className="web-page">
      <PageHeader
        title="Analytics"
        actions={
          <AnalyticsHeaderActions
            updatedAt={updatedAt}
            timeZone={timeZone}
            refreshing={refreshing}
            onRefresh={onRefresh}
            exportKinds={view === 'mine' ? MY_WORK_EXPORTS : WORKSPACE_EXPORTS}
            onExport={(kind) => void runExport(kind)}
            exportDisabled={exportDisabled}
            exporting={exporting}
          />
        }
      />

      <AnalyticsToolbar
        view={view}
        onViewChange={changeView}
        range={prefs.range}
        onRangeChange={changeRange}
        resolvedDays={range}
        rangeText={rangeText}
        rangeError={rangeError}
        projectValue={encodeProjectFilter(projectFilter)}
        projectOptions={projectOptions}
        onProjectChange={(value) => update({ projectFilter: decodeProjectFilter(value) })}
        applicationValue={applicationId ?? ALL}
        applicationOptions={appOptions}
        onApplicationChange={(value) => update({ applicationId: value === ALL ? null : value })}
        timeOf={timeOf}
        timeHidden={!scope.showsTime}
        timeZone={timeZone}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {refusedZone !== null ? <TimeZoneNotice zone={refusedZone} /> : null}
      {exportProblem ? <ProblemBanner problem={exportProblem} title="Couldn’t export" /> : null}
      {showSummaryProblem && summary.problem ? (
        <ProblemBanner problem={summary.problem} onRetry={retrySummary} title="Couldn’t load the report" />
      ) : null}

      {!scope.showsTime ? (
        <WorkspacePrivatePanel
          note={privacyNote(workspace, teammatesVisible)}
          tasks={listsSource}
          progress={progress}
          projectRows={progressRows}
          onShowMyWork={() => changeView('mine')}
        />
      ) : (
        <>
          {view === 'workspace' ? <PrivacyNote text={privacyNote(workspace, teammatesVisible)} /> : null}

          {timeFailed ? null : (
            <>
              <SummaryTiles
                who={who}
                loading={timeLoading}
                stale={stale}
                totals={totals}
                unattributed={unattributed}
                projectFiltered={projectFilter.kind !== 'all'}
                previous={previousReference}
              />
              <ActivityCard
                who={who}
                loading={timeLoading}
                stale={stale}
                points={points}
                bucket={shownBucket}
                bucketChoice={prefs.bucket}
                bucketOptions={bucketOptions}
                onBucketChange={changeBucket}
                today={today}
                rangeLabel={shownRangeLabel}
                timeline={timeline}
              />
              <div className="web-grid-2">
                <ApplicationsCard who={who} loading={timeLoading} stale={stale} items={applications} />
                <ProjectsCard
                  who={who}
                  loading={timeLoading}
                  stale={stale}
                  items={projectBars}
                  progressRows={progressRows}
                  tasks={listsSource}
                  attributeHref={view === 'mine' ? TIME_HREF : null}
                />
              </div>
            </>
          )}

          {view === 'mine' ? (
            <>
              <div className="web-grid-2">
                {timeFailed ? null : <TimeByTaskCard who={who} loading={timeLoading} stale={stale} items={taskBars} />}
                <TaskProgressCard
                  title="My task progress"
                  summary={progress}
                  loading={listsSource.loading}
                  problem={listsSource.problem}
                  onRetry={listsSource.onRetry}
                />
              </div>
              <div className="web-grid-2">
                <UpcomingDeadlinesCard
                  items={deadlines}
                  today={today}
                  loading={listsSource.loading}
                  problem={listsSource.problem}
                  onRetry={listsSource.onRetry}
                />
                <AssignedProjectsCard
                  items={myProjects}
                  applicationName={applicationId === null ? null : (selectedApplication?.name ?? applicationId)}
                  projectFiltered={projectFilter.kind === 'project'}
                  timeLoading={timeLoading}
                  loading={listsSource.loading}
                  problem={listsSource.problem}
                  onRetry={listsSource.onRetry}
                />
              </div>
              <RecentSessionsCard
                rows={sessionTable}
                timeZone={timeZone}
                loading={shownSessions === null && firstPage.problem === null}
                problem={firstPage.problem}
                onRetry={retrySessions}
                onlyUnattributed={sessionFilters.unattributedOnly === true}
                onOnlyUnattributedChange={setOnlyUnattributed}
                showUnattributedToggle={projectFilter.kind === 'all'}
                projectName={projectFilter.kind === 'project' ? labels.project(projectFilter.id, false).label : null}
                applicationName={applicationId === null ? null : (selectedApplication?.name ?? applicationId)}
                hasMore={hasMoreSessions}
                allShown={allSessionsShown}
                loadingMore={loadingMore}
                onShowMore={onShowMore}
                moreProblem={moreProblem}
                stale={sessionsStale}
              />
            </>
          ) : (
            <>
              <TaskProgressCard
                title={
                  scope.personId === null
                    ? 'Task progress'
                    : scope.personId === me
                      ? 'My task progress'
                      : `${labels.member(scope.personId).name} · Task progress`
                }
                summary={progress}
                loading={listsSource.loading}
                problem={listsSource.problem}
                onRetry={listsSource.onRetry}
              />
              {scope.userIds === null && !timeFailed ? (
                <MembersCard loading={timeLoading} stale={stale} items={memberRows} rangeLabel={shownRangeLabel} />
              ) : null}
            </>
          )}

          <AnalyticsFootnote overlapMs={totals?.overlapMs ?? 0} />
        </>
      )}

      <LiveRegion message={announcement} />
      <ReportSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        timeZone={timeZone}
        timeZoneOptions={zoneOptions}
        browserTimeZone={BROWSER_ZONE}
        onTimeZoneChange={changeTimeZone}
        savedViews={prefs.presets}
        onApplyView={onApplyView}
        onDeleteView={onDeleteView}
        onSaveView={onSaveView}
      />
    </div>
  );
}
