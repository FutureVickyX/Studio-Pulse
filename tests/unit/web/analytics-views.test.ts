/// <reference types="vite/client" />
// The presentational components import the '@studio-pulse/ui' entry, which loads an SVG asset; the
// reference above gives the root type check the asset module types the web app's tsconfig has.

/**
 * The presentational Analytics components (`apps/web/src/views/analytics`), rendered to static
 * markup with fixture view models. The view models are built by the real `lib/analytics.ts`
 * functions from fixture report rows, so what is rendered here is what the container renders.
 */

import { createElement } from 'react';
import type { FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ALL,
  EVERYONE,
  allowedBuckets,
  analyticsFootnote,
  applicationColors,
  applicationItems,
  applicationOptions,
  assignedProjects,
  createReportLabels,
  encodeProjectFilter,
  memberItems,
  periodSeries,
  previousReferenceText,
  privacyNote,
  projectFilterOptions,
  projectItems,
  projectProgressRows,
  reportTotals,
  resolveAnalyticsRange,
  splitReport,
  summarizeTaskProgress,
  taskItems,
  timeOfOptions,
  unattributedTime,
  upcomingDeadlines,
} from '../../../apps/web/src/lib/analytics';
import type { MemberItem, ReportRange, ReportRow } from '../../../apps/web/src/lib/analytics';
import type { MySession } from '../../../apps/web/src/lib/api';
import type { Problem } from '../../../apps/web/src/lib/errors';
import type { Project, Task } from '../../../apps/web/src/lib/model';
import {
  ActivityCard,
  AnalyticsFootnote,
  AnalyticsHeaderActions,
  AnalyticsToolbar,
  ApplicationsCard,
  AssignedProjectsCard,
  CardBody,
  LiveRegion,
  MembersCard,
  PrivacyNote,
  ProjectInsights,
  ProjectsCard,
  RecentSessionsCard,
  SummaryTiles,
  TaskProgressCard,
  TimeByTaskCard,
  TimeZoneNotice,
  UpcomingDeadlinesCard,
  WorkspacePrivatePanel,
  dayTimeline,
  focusAfterDelete,
  sessionRows,
  sessionsDescription,
  taskListItems,
} from '../../../apps/web/src/views/analytics';
import type {
  ActivityCardProps,
  AnalyticsToolbarProps,
  ProjectInsightsProps,
  ProjectsCardProps,
  RecentSessionsCardProps,
  SummaryTilesProps,
  WorkspacePrivatePanelProps,
} from '../../../apps/web/src/views/analytics';

// ---------------------------------------------------------------------------------------------
// Rendering and markup helpers
// ---------------------------------------------------------------------------------------------

/** Every markup rendered by this file: the wording and structure checks at the end read it all. */
const RENDERED: string[] = [];

function render<P extends object>(component: FunctionComponent<P>, props: P): string {
  const html = renderToStaticMarkup(createElement(component, props));
  RENDERED.push(html);
  return html;
}

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };
const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity] ?? entity);
/** The text a reader gets: tags dropped (with a space, so neighbouring cells stay apart). */
const text = (html: string) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
/** Every element of one tag as its opening tag's text. */
const tags = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
const attribute = (tag: string, name: string) => {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? null : decode(value);
};
/** The text of every `<tag ...attr...>…</tag>` whose opening tag contains `marker`. */
function inner(html: string, tag: string, marker = ''): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>(.*?)</${tag}>`, 'gs'))) {
    if ((match[1] ?? '').includes(marker)) found.push(text(match[2] ?? ''));
  }
  return found;
}
const columnHeaders = (html: string) => inner(html, 'th', 'scope="col"');
const rowHeaders = (html: string) => inner(html, 'th', 'scope="row"');
const captions = (html: string) => inner(html, 'caption');
/** The `aria-label` of every loading placeholder (`SkeletonLines`). */
const loadingLabels = (html: string) =>
  tags(html, 'div')
    .filter((tag) => attribute(tag, 'role') === 'status' && attribute(tag, 'aria-label') !== null)
    .map((tag) => attribute(tag, 'aria-label'));
const emptyTitles = (html: string) => inner(html, 'p', 'sp-empty__title');
const ariaLabels = (html: string, tag: string, className: string) =>
  tags(html, tag)
    .filter((candidate) => (attribute(candidate, 'class') ?? '').split(' ').includes(className))
    .map((candidate) => attribute(candidate, 'aria-label'));

/** A duration as `formatDuration` writes it: "3h 05m", "45m", "30s". */
const DURATION = /\b\d+h \d{2}m\b|\b\d+m\b|\b\d+s\b/;

// ---------------------------------------------------------------------------------------------
// Fixtures: one workspace, three people, a week of recorded time
// ---------------------------------------------------------------------------------------------

const H = 3_600_000;
const M = 60_000;
const WS = 'ws-1';
const ME = 'u-mira';
const ANA = 'u-ana';
const ZOE = 'u-zoe';
const ZONE = 'UTC';
const NOW = Date.parse('2026-11-12T15:00:00Z');
const TODAY = '2026-11-12';
const noop = () => {};

const MEMBERS = [
  { userId: ZOE, displayName: 'Zoe' },
  { userId: ME, displayName: 'Mira' },
  { userId: ANA, displayName: 'Ana' },
];

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

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    workspace_id: WS,
    project_id: null,
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

const PROJECTS: readonly Project[] = [
  project({ id: 'p1', name: 'Brand refresh', lead_id: ME }),
  project({ id: 'p2', name: 'Annual report' }),
];

const TASKS: readonly Task[] = [
  task({ id: 't1', title: 'Logo set', project_id: 'p1', status: 'in_progress', assignee_id: ME, due_date: '2026-11-10', estimated_minutes: 180 }),
  task({ id: 't2', title: 'Colour tokens', project_id: 'p1', status: 'in_review', assignee_id: ME, due_date: '2026-11-14' }),
  task({ id: 't3', title: 'Cover layout', project_id: 'p2', status: 'done', assignee_id: ANA, completed_at: '2026-11-09T10:00:00Z' }),
  task({ id: 't4', title: 'Font licences', status: 'todo', assignee_id: ME }),
];

const LABELS = createReportLabels({ projects: PROJECTS, tasks: TASKS, members: MEMBERS });

function row(dimension: ReportRow['dimension'], overrides: Partial<ReportRow>): ReportRow {
  return {
    dimension,
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

/** Rows shared by both reports; the Workspace report adds member rows and its own total. */
const BREAKDOWN: readonly ReportRow[] = [
  row('period', { bucketStart: '2026-11-10', activeMs: 2 * H, idleMs: 20 * M, entryCount: 4 }),
  row('period', { bucketStart: '2026-11-11', activeMs: 90 * M, idleMs: 10 * M, entryCount: 3 }),
  row('period', { bucketStart: '2026-11-12', activeMs: 90 * M, idleMs: 30 * M, entryCount: 3 }),
  row('project', { projectId: null, unattributed: true, activeMs: 30 * M, idleMs: 20 * M, entryCount: 1 }),
  row('project', { projectId: null, unattributed: false, activeMs: 30 * M, entryCount: 1 }),
  row('project', { projectId: 'p2', unattributed: false, activeMs: 1 * H, idleMs: 10 * M, entryCount: 2 }),
  row('project', { projectId: 'p1', unattributed: false, activeMs: 3 * H, idleMs: 30 * M, entryCount: 5 }),
  row('task', { taskId: 't1', projectId: 'p1', activeMs: 2 * H, idleMs: 20 * M, entryCount: 3 }),
  row('task', { taskId: 't2', projectId: 'p1', activeMs: 1 * H, idleMs: 10 * M, entryCount: 2 }),
  row('task', { taskId: 't3', projectId: 'p2', activeMs: 1 * H, idleMs: 10 * M, entryCount: 2 }),
  row('task', { taskId: 't4', projectId: null, activeMs: 30 * M, entryCount: 1 }),
  row('task', { taskId: null, projectId: null, activeMs: 30 * M, idleMs: 20 * M, entryCount: 1 }),
  row('application', { applicationId: 'figma', applicationName: 'Figma', activeMs: 3 * H, idleMs: 40 * M, entryCount: 5 }),
  row('application', { applicationId: 'adobe-photoshop', applicationName: 'Adobe Photoshop', activeMs: 2 * H, idleMs: 20 * M, entryCount: 4 }),
];

const MINE = splitReport([row('total', { activeMs: 5 * H, idleMs: 1 * H, entryCount: 9, overlapMs: 10 * M, teammatesVisible: false }), ...BREAKDOWN]);

/** Zoe, last in the alphabet, has by far the most time; Ana, first, the least. */
const TEAM = splitReport([
  row('total', { activeMs: 15 * H, idleMs: 2 * H, entryCount: 30, teammatesVisible: true }),
  row('member', { userId: ZOE, activeMs: 9 * H, idleMs: 30 * M, entryCount: 14 }),
  row('member', { userId: ME, activeMs: 5 * H, idleMs: 1 * H, entryCount: 9 }),
  row('member', { userId: ANA, activeMs: 1 * H, idleMs: 30 * M, entryCount: 7 }),
  ...BREAKDOWN,
]);

function rangeOf(preset: 'today' | 'yesterday' | 'last7'): ReportRange {
  const result = resolveAnalyticsRange({ preset }, { now: NOW, timeZone: ZONE });
  if (!result.ok) throw new Error(result.message);
  return result.range;
}

const WEEK = rangeOf('last7');
const POINTS = periodSeries(MINE.periods, { fromDay: WEEK.fromDay, toDay: WEEK.toDay, bucket: 'day' });
const COLORS = applicationColors(MINE.applications);
const APPLICATIONS = applicationItems(MINE.applications, COLORS);
const PROJECT_ITEMS = projectItems(MINE.projects, LABELS);
const TASK_ITEMS = taskItems(MINE.tasks, LABELS);
const MY_SELECTION = { projectFilter: { kind: 'all' as const }, assigneeId: ME };
const ALL_SELECTION = { projectFilter: { kind: 'all' as const }, assigneeId: null };
const PROGRESS_ROWS = projectProgressRows({ projects: PROJECTS, tasks: TASKS, selection: MY_SELECTION, projectRows: MINE.projects, labels: LABELS, today: TODAY });

const NETWORK: Problem = { kind: 'network', message: 'You appear to be offline. Check the connection and try again.' };
const READY = { loading: false, problem: null };
const LOADING = { loading: true, problem: null };
const FAILED = { loading: false, problem: NETWORK, onRetry: noop };

const SESSIONS: readonly MySession[] = [
  {
    id: 's2',
    started_at: '2026-11-12T09:05:00Z',
    ended_at: '2026-11-12T10:35:00Z',
    application_id: 'figma',
    application_name: 'Figma',
    kind: 'active',
    active_ms: 90 * M,
    idle_ms: 0,
    project_id: 'p1',
    task_id: 't1',
  },
  {
    id: 's1',
    started_at: '2026-11-11T23:50:00Z',
    ended_at: '2026-11-12T00:20:00Z',
    application_id: 'adobe-photoshop',
    application_name: 'Adobe Photoshop',
    kind: 'idle',
    active_ms: 0,
    idle_ms: 30 * M,
    project_id: null,
    task_id: null,
  },
];

// ---------------------------------------------------------------------------------------------
// Card frame
// ---------------------------------------------------------------------------------------------

describe('CardBody', () => {
  const base = { loadingLabel: 'Loading things', emptyTitle: 'Nothing here', emptyText: 'Add something.', children: createElement('p', null, 'The data') };

  it('shows a labelled skeleton while loading and nothing else', () => {
    const html = render(CardBody, { ...base, loading: true, empty: false });
    expect(loadingLabels(html)).toEqual(['Loading things']);
    expect(text(html)).toBe('');
  });

  it('shows the specific empty message, or the data', () => {
    const empty = render(CardBody, { ...base, loading: false, empty: true });
    expect(emptyTitles(empty)).toEqual(['Nothing here']);
    expect(text(empty)).toBe('Nothing here Add something.');
    expect(text(render(CardBody, { ...base, loading: false, empty: false }))).toBe('The data');
  });

  it('shows a failed read as a banner with Retry, above the data it still has', () => {
    const html = render(CardBody, { ...base, loading: false, empty: false, problem: NETWORK, onRetry: noop, problemTitle: 'Couldn’t load the tasks' });
    expect(text(html)).toContain('Couldn’t load the tasks');
    expect(text(html)).toContain(NETWORK.message);
    expect(inner(html, 'button')).toEqual(['Retry']);
    expect(text(html)).toContain('The data');
    // A failure with nothing loaded shows the banner, not the empty message or a skeleton.
    const nothing = render(CardBody, { ...base, loading: true, empty: true, problem: NETWORK });
    expect(text(nothing)).toContain(NETWORK.message);
    expect(loadingLabels(nothing)).toEqual([]);
    expect(emptyTitles(nothing)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

describe('SummaryTiles', () => {
  const base: SummaryTilesProps = {
    who: null,
    loading: false,
    totals: reportTotals(MINE.total),
    unattributed: unattributedTime(MINE.projects),
    projectFiltered: false,
    previous: { status: 'hidden' },
  };
  const tileLabels = (html: string) => inner(html, 'span', 'sp-stat__label');
  const tileValues = (html: string) => inner(html, 'span', 'sp-stat__value');

  it('shows Active, In foreground, Unattributed and Sessions', () => {
    const html = render(SummaryTiles, base);
    expect(tileLabels(html)).toEqual(['Active', 'In foreground', 'Unattributed', 'Sessions']);
    expect(tileValues(html)).toEqual(['5h 00m', '6h 00m', '30m', '9']);
    expect(text(html)).toContain('Active + idle · 1h 00m idle');
    expect(text(html)).toContain('Active time with no project or task');
  });

  it('shows no previous-period line when told not to', () => {
    const html = render(SummaryTiles, base);
    expect(html).not.toContain('web-analytics-ref');
    expect(text(html)).not.toMatch(/previous/i);
  });

  it('adds "(today still in progress)" when the range includes today, and not otherwise', () => {
    expect(WEEK.includesToday).toBe(true);
    const withToday = render(SummaryTiles, { ...base, previous: { status: 'ready', text: previousReferenceText(WEEK, 31 * H + 10 * M) } });
    const line = inner(withToday, 'span', 'web-analytics-ref');
    expect(line).toHaveLength(1);
    expect(line[0]).toMatch(/^Previous 7 days \(.+\): 31h 10m \(today still in progress\)$/);

    const yesterday = rangeOf('yesterday');
    expect(yesterday.includesToday).toBe(false);
    const closed = render(SummaryTiles, { ...base, previous: { status: 'ready', text: previousReferenceText(yesterday, 4 * H) } });
    expect(inner(closed, 'span', 'web-analytics-ref')[0]).toMatch(/: 4h 00m$/);
    expect(text(closed)).not.toContain('still in progress');
  });

  it('states the previous total as a plain figure: no change, no arrow, no percentage', () => {
    const html = render(SummaryTiles, { ...base, previous: { status: 'ready', text: previousReferenceText(WEEK, 2 * H) } });
    expect(text(html)).not.toMatch(/[↑↓▲▼▴▾%]|[+−]\s?\d|-\d/);
    expect(text(html)).not.toMatch(/\b(up|down|more|less|increase|decrease)\b/i);
  });

  it('has its own loading and failed states for the previous period', () => {
    expect(inner(render(SummaryTiles, { ...base, previous: { status: 'loading' } }), 'span', 'web-analytics-ref')).toEqual(['Previous period: loading…']);
    const failed = render(SummaryTiles, { ...base, previous: { status: 'error', onRetry: noop } });
    expect(inner(failed, 'span', 'web-analytics-ref')).toEqual(['Previous period unavailable. Retry']);
  });

  it('marks every tile busy and shows no figures while loading', () => {
    const html = render(SummaryTiles, { ...base, loading: true, totals: null, unattributed: null });
    const tiles = tags(html, 'div').filter((tag) => attribute(tag, 'class') === 'sp-stat');
    expect(tiles).toHaveLength(4);
    expect(tiles.every((tag) => attribute(tag, 'aria-busy') === 'true')).toBe(true);
    expect(tileValues(html)).toEqual([]);
    expect(text(html)).not.toMatch(DURATION);
  });

  it('replaces Unattributed with Idle under a project filter', () => {
    const html = render(SummaryTiles, { ...base, projectFiltered: true });
    expect(tileLabels(html)).toEqual(['Active', 'In foreground', 'Idle', 'Sessions']);
    expect(tileValues(html)).toEqual(['5h 00m', '6h 00m', '1h 00m', '9']);
  });

  it('names whose time it is when it is not the viewer’s own', () => {
    const html = render(SummaryTiles, { ...base, who: 'Everyone you can see', totals: reportTotals(TEAM.total) });
    expect(tileLabels(html)).toEqual([
      'Everyone you can see · Active',
      'Everyone you can see · In foreground',
      'Everyone you can see · Unattributed',
      'Everyone you can see · Sessions',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Activity over time
// ---------------------------------------------------------------------------------------------

describe('ActivityCard', () => {
  const base: ActivityCardProps = {
    who: null,
    loading: false,
    points: POINTS,
    bucket: 'day',
    bucketChoice: 'auto',
    bucketOptions: allowedBuckets(WEEK.days),
    onBucketChange: noop,
    today: TODAY,
    rangeLabel: WEEK.label,
  };

  it('draws the area chart with an accessible name, and offers the same figures as a table', () => {
    const html = render(ActivityCard, base);
    expect(ariaLabels(html, 'div', 'sp-area')).toEqual([`Active time per day, ${WEEK.label}. Use the arrow keys to step through the points.`]);
    expect(inner(html, 'summary')).toEqual(['Show as a table']);
    expect(captions(html)).toEqual([`Recorded time per day, ${WEEK.label}`]);
    expect(columnHeaders(html)).toEqual(['Day', 'Active', 'Idle', 'In foreground', 'Sessions']);
    expect(rowHeaders(html)).toHaveLength(7);
    expect(tags(html, 'select').map((tag) => attribute(tag, 'aria-label'))).toEqual(['Bucket']);
    expect(loadingLabels(html)).toEqual([]);
    expect(emptyTitles(html)).toEqual([]);
  });

  it('shows a skeleton while loading: no chart, no table', () => {
    const html = render(ActivityCard, { ...base, loading: true, points: [] });
    expect(loadingLabels(html)).toEqual(['Loading activity']);
    expect(html).not.toContain('sp-area');
    expect(html).not.toContain('<table');
  });

  it('says so when the range has no recorded time', () => {
    const html = render(ActivityCard, { ...base, points: periodSeries([], { fromDay: WEEK.fromDay, toDay: WEEK.toDay, bucket: 'day' }) });
    expect(emptyTitles(html)).toEqual(['No recorded time in this range']);
    expect(html).not.toContain('sp-area');
    expect(html).not.toContain('<table');
  });

  it('names the group in the title, the chart and the table when the time is not the viewer’s', () => {
    const html = render(ActivityCard, { ...base, who: 'Everyone you can see' });
    expect(inner(html, 'h2')).toEqual(['Everyone you can see · Activity over time']);
    expect(ariaLabels(html, 'div', 'sp-area')[0]).toContain('Everyone you can see · Active time per day');
    expect(captions(html)[0]).toContain('Everyone you can see · Recorded time per day');
  });

  describe('single day (the viewer’s timeline)', () => {
    const dayStartMs = Date.parse('2026-11-12T00:00:00Z');
    const timeline = dayTimeline(SESSIONS, { dayStartMs, dayEndMs: dayStartMs + 24 * H, timeZone: ZONE, nowMs: NOW, colors: COLORS });
    const day = { ...base, points: POINTS.slice(-1), rangeLabel: '12 Nov' };

    it('draws the day’s sessions as a labelled timeline instead of the chart', () => {
      const html = render(ActivityCard, { ...day, timeline: { ...READY, timeline } });
      expect(timeline.items).toHaveLength(2);
      expect(html).not.toContain('sp-area');
      const groups = tags(html, 'div').filter((tag) => attribute(tag, 'role') === 'group');
      expect(groups.map((tag) => attribute(tag, 'aria-label'))).toEqual(['Your sessions, 12 Nov. Use the arrow keys to step through intervals.']);
      expect(tags(html, 'select')).toEqual([]);
      expect(text(html)).toContain('Figma');
      expect(text(html)).toContain('Idle');
    });

    it('has loading, failed and empty states of its own', () => {
      expect(loadingLabels(render(ActivityCard, { ...day, timeline: { ...LOADING, timeline: null } }))).toEqual(['Loading the day’s sessions']);
      const failed = render(ActivityCard, { ...day, timeline: { ...FAILED, timeline: null } });
      expect(text(failed)).toContain(NETWORK.message);
      expect(inner(failed, 'button')).toContain('Retry');
      const none = dayTimeline([], { dayStartMs, dayEndMs: dayStartMs + 24 * H, timeZone: ZONE, nowMs: NOW, colors: COLORS });
      expect(emptyTitles(render(ActivityCard, { ...day, timeline: { ...READY, timeline: none } }))).toEqual(['No sessions on this day']);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Applications, projects, tasks
// ---------------------------------------------------------------------------------------------

describe('ApplicationsCard', () => {
  it('lists applications as labelled bars with idle named separately', () => {
    const html = render(ApplicationsCard, { who: null, loading: false, items: APPLICATIONS });
    expect(ariaLabels(html, 'ul', 'sp-barlist')).toEqual(['Time per application']);
    expect(html).toContain('aria-label="Figma: 3h 00m active, 40m idle"');
    expect(html).toContain('aria-label="Adobe Photoshop: 2h 00m active, 20m idle"');
    expect(text(html)).toContain('+ 40m idle');
  });

  it('has loading and empty states', () => {
    const loading = render(ApplicationsCard, { who: null, loading: true, items: [] });
    expect(loadingLabels(loading)).toEqual(['Loading applications']);
    expect(loading).not.toContain('sp-barlist');
    const empty = render(ApplicationsCard, { who: null, loading: false, items: [] });
    expect(emptyTitles(empty)).toEqual(['No application time in this range']);
    expect(empty).not.toContain('sp-barlist');
  });
});

describe('ProjectsCard', () => {
  const base: ProjectsCardProps = { who: null, loading: false, items: PROJECT_ITEMS, progressRows: PROGRESS_ROWS, tasks: READY, attributeHref: '#/time' };

  it('lists projects by active time with "No project (task time)" then "Unattributed" last', () => {
    const html = render(ProjectsCard, base);
    expect(PROJECT_ITEMS.map((item) => item.label)).toEqual(['Brand refresh', 'Annual report', 'No project (task time)', 'Unattributed']);
    expect(ariaLabels(html, 'ul', 'sp-barlist')).toEqual(['Active time per project']);
    const order = PROJECT_ITEMS.map((item) => html.indexOf(`aria-label="${item.label}: `));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('links to the Time page and says its ranges differ', () => {
    const html = render(ProjectsCard, base);
    const links = tags(html, 'a');
    expect(links).toHaveLength(1);
    expect(attribute(links[0] ?? '', 'href')).toBe('#/time');
    expect(attribute(links[0] ?? '', 'title')).toBe('The Time page uses its own fixed ranges, not this report’s range');
    expect(inner(html, 'a')).toEqual(['Attribute on the Time page →']);
    // Not offered for time that is not the viewer's own.
    expect(tags(render(ProjectsCard, { ...base, who: 'Everyone you can see', attributeHref: null }), 'a')).toEqual([]);
  });

  it('offers "Projects: time and progress" as a table', () => {
    const html = render(ProjectsCard, base);
    expect(captions(html)).toEqual(['Projects: time and progress']);
    expect(columnHeaders(html)).toEqual(['Project', 'Active', 'In foreground', 'Sessions', 'Tasks done', 'In review', 'Overdue']);
    expect(rowHeaders(html)).toEqual(['Brand refresh', 'Annual report', 'No project (task time)', 'Unattributed']);
    expect(text(html)).toContain('Task counts: Current status — not limited by dates or application.');
  });

  it('has loading and empty states, and the table has its own for the task list', () => {
    const loading = render(ProjectsCard, { ...base, loading: true, items: [], progressRows: [] });
    expect(loadingLabels(loading)).toEqual(['Loading projects']);
    expect(loading).not.toContain('<details');
    const empty = render(ProjectsCard, { ...base, items: [], progressRows: [] });
    expect(emptyTitles(empty)).toEqual(['No time in this range', 'No projects with time or tasks']);
    const tasksLoading = render(ProjectsCard, { ...base, tasks: LOADING });
    expect(loadingLabels(tasksLoading)).toEqual(['Loading task progress']);
    expect(tasksLoading).toContain('sp-barlist');
    const tasksFailed = render(ProjectsCard, { ...base, tasks: FAILED });
    expect(text(tasksFailed)).toContain('Couldn’t load the tasks');
    expect(inner(tasksFailed, 'button')).toContain('Retry');
  });
});

describe('TimeByTaskCard', () => {
  it('lists tasks by active time and gives the task’s own estimate in the table', () => {
    const html = render(TimeByTaskCard, { who: null, loading: false, items: TASK_ITEMS });
    expect(ariaLabels(html, 'ul', 'sp-barlist')).toEqual(['Active time per task']);
    expect(html).toContain('aria-label="Logo set: 2h 00m active"');
    expect(captions(html)).toEqual(['Time by task']);
    expect(columnHeaders(html)).toEqual(['Task', 'Project', 'Active', 'In foreground', 'Estimate (task)']);
    expect(rowHeaders(html)[0]).toBe('Logo set');
    expect(rowHeaders(html)).toHaveLength(TASK_ITEMS.length);
    expect(text(html)).toContain('Projects have no budgets.');
  });

  it('has loading and empty states', () => {
    const loading = render(TimeByTaskCard, { who: null, loading: true, items: [] });
    expect(loadingLabels(loading)).toEqual(['Loading time by task']);
    expect(loading).not.toContain('<table');
    const empty = render(TimeByTaskCard, { who: null, loading: false, items: [] });
    expect(emptyTitles(empty)).toEqual(['No time on tasks in this range']);
    expect(empty).not.toContain('<table');
  });
});

// ---------------------------------------------------------------------------------------------
// Members: alphabetical, never ordered by time
// ---------------------------------------------------------------------------------------------

describe('MembersCard', () => {
  const items = memberItems(TEAM.members, LABELS);
  const base = { loading: false, items, rangeLabel: WEEK.label };

  it('keeps the alphabetical order it is given, even when a later member has more time', () => {
    expect(items.map((item) => item.name)).toEqual(['Ana', 'Mira', 'Zoe']);
    expect(items.map((item) => item.activeMs)).toEqual([1 * H, 5 * H, 9 * H]);
    const html = render(MembersCard, base);
    expect(rowHeaders(html)).toEqual(['Ana', 'Mira', 'Zoe']);
    expect(text(html)).toContain('in alphabetical order');
  });

  it('never reorders by itself: the rows are shown exactly as given', () => {
    const given: MemberItem[] = [
      { userId: 'u-1', name: 'Bea', former: false, activeMs: 10 * M, idleMs: 0, foregroundMs: 10 * M, sessions: 1 },
      { userId: 'u-2', name: 'Cy', former: false, activeMs: 8 * H, idleMs: 0, foregroundMs: 8 * H, sessions: 6 },
      { userId: 'u-3', name: 'Dee', former: false, activeMs: 2 * H, idleMs: 0, foregroundMs: 2 * H, sessions: 2 },
    ];
    expect(rowHeaders(render(MembersCard, { ...base, items: given }))).toEqual(['Bea', 'Cy', 'Dee']);
  });

  it('has no sort buttons and no change or trend column', () => {
    const html = render(MembersCard, base);
    expect(columnHeaders(html)).toEqual(['Member', 'Active', 'Idle', 'In foreground', 'Sessions']);
    expect(tags(html, 'button')).toEqual([]);
    expect(html).not.toContain('aria-sort');
    expect(tags(html, 'th').every((tag) => attribute(tag, 'role') === null && attribute(tag, 'tabindex') === null)).toBe(true);
    expect(text(html)).not.toMatch(/change|trend|vs\.?\s|previous|%|[↑↓▲▼]/i);
    expect(captions(html)).toEqual([`Recorded time per member, ${WEEK.label}`]);
  });

  it('has loading and empty states', () => {
    expect(loadingLabels(render(MembersCard, { ...base, loading: true, items: [] }))).toEqual(['Loading members']);
    const empty = render(MembersCard, { ...base, items: [] });
    expect(emptyTitles(empty)).toEqual(['No recorded time in this range']);
    expect(empty).not.toContain('<table');
  });
});

// ---------------------------------------------------------------------------------------------
// Recent sessions
// ---------------------------------------------------------------------------------------------

describe('RecentSessionsCard', () => {
  const rows = sessionRows(SESSIONS, LABELS, { timeZone: ZONE, today: TODAY });
  const base: RecentSessionsCardProps = {
    ...READY,
    rows,
    timeZone: ZONE,
    onlyUnattributed: false,
    onOnlyUnattributedChange: noop,
    hasMore: true,
    loadingMore: false,
    onShowMore: noop,
  };

  it('lists the sessions as given, with times in the reporting zone', () => {
    const html = render(RecentSessionsCard, base);
    expect(text(html)).toContain('Your own sessions in this range, newest first. Times are in UTC.');
    expect(captions(html)).toEqual(['Your sessions, newest first']);
    expect(columnHeaders(html)).toEqual(['Application', 'Kind', 'Day', 'Start–end', 'Duration', 'Project / task']);
    expect(rowHeaders(html)).toEqual(['Figma', 'Adobe Photoshop']);
    expect(text(html)).toContain('09:05–10:35');
    expect(text(html)).toContain('23:50–00:20 (12 Nov)');
    expect(text(html)).toContain('Brand refresh › Logo set');
    expect(text(html)).toContain('Unattributed');
    expect(inner(html, 'button')).toEqual(['Show more']);
    expect(text(html)).toContain('Only unattributed');
  });

  it('has loading, failed and empty states', () => {
    const loading = render(RecentSessionsCard, { ...base, ...LOADING, rows: [] });
    expect(loadingLabels(loading)).toEqual(['Loading sessions']);
    expect(loading).not.toContain('<table');
    const failed = render(RecentSessionsCard, { ...base, ...FAILED, rows: [] });
    expect(text(failed)).toContain('Couldn’t load your sessions');
    expect(inner(failed, 'button')).toEqual(['Retry']);
    expect(emptyTitles(render(RecentSessionsCard, { ...base, rows: [], hasMore: false }))).toEqual(['No sessions in this range']);
    const filtered = render(RecentSessionsCard, { ...base, rows: [], hasMore: false, onlyUnattributed: true });
    expect(emptyTitles(filtered)).toEqual(['No unattributed sessions in this range']);
  });

  it('keeps the loaded rows when "Show more" fails, and stops offering it at the end', () => {
    const failed = render(RecentSessionsCard, { ...base, moreProblem: NETWORK });
    expect(rowHeaders(failed)).toHaveLength(2);
    expect(text(failed)).toContain('Couldn’t load more sessions');
    // The same button stays (it keeps keyboard focus) and tries again; the banner has no second one.
    expect(inner(failed, 'button')).toEqual(['Try again']);
    expect(inner(render(RecentSessionsCard, { ...base, hasMore: false }), 'button')).toEqual([]);
  });

  it('says every session is shown where "Show more" was, focusable so focus has somewhere to go', () => {
    const end = render(RecentSessionsCard, { ...base, hasMore: false, allShown: true });
    expect(inner(end, 'button')).toEqual([]);
    expect(inner(end, 'p', 'tabindex="-1"')).toEqual(['All sessions shown.']);
    // A first page that was short anyway: nothing changes there.
    expect(text(render(RecentSessionsCard, { ...base, hasMore: false }))).not.toContain('All sessions shown.');
  });

  it('follows the page’s Project and Application filters, and says so', () => {
    const filtered = render(RecentSessionsCard, {
      ...base,
      projectName: 'Brand refresh',
      applicationName: 'Adobe Photoshop',
      showUnattributedToggle: false,
    });
    expect(text(filtered)).toContain('Your own sessions in this range on Brand refresh in Adobe Photoshop, newest first. Times are in UTC.');
    // Under a project filter "Only unattributed" could only empty the list: it is not offered.
    expect(text(filtered)).not.toContain('Only unattributed');
    // The page's Unattributed filter.
    const unattributed = render(RecentSessionsCard, { ...base, onlyUnattributed: true, applicationName: 'Figma', showUnattributedToggle: false });
    expect(text(unattributed)).toContain('Your own unattributed sessions in this range in Figma, newest first.');
    expect(captions(unattributed)).toEqual(['Your sessions, newest first, unattributed only']);
    expect(
      sessionsDescription({ timeZone: 'Europe/London', onlyUnattributed: false, projectName: null, applicationName: null }),
    ).toBe('Your own sessions in this range, newest first. Times are in Europe/London.');
  });
});

// ---------------------------------------------------------------------------------------------
// Task cards (current state)
// ---------------------------------------------------------------------------------------------

describe('TaskProgressCard', () => {
  const summary = summarizeTaskProgress(TASKS, { ...MY_SELECTION, today: TODAY });

  it('shows the status breakdown, overdue and due soon, with the definition', () => {
    const html = render(TaskProgressCard, { ...READY, title: 'My task progress', summary });
    expect(inner(html, 'h2')).toEqual(['My task progress']);
    expect(inner(html, 'dt')).toEqual(['Inbox', 'To do', 'In progress', 'In review', 'Done', 'Overdue', 'Due in the next 7 days']);
    expect(inner(html, 'dd')).toEqual(['0', '1', '1', '1', '0', '1', '1']);
    expect(text(html)).toContain('Current status — not limited by dates or application.');
  });

  it('has loading, failed and empty states', () => {
    expect(loadingLabels(render(TaskProgressCard, { ...LOADING, title: 'Task progress', summary: null }))).toEqual(['Loading task progress']);
    const failed = render(TaskProgressCard, { ...FAILED, title: 'Task progress', summary: null });
    expect(text(failed)).toContain('Couldn’t load the tasks');
    expect(inner(failed, 'button')).toEqual(['Retry']);
    const none = summarizeTaskProgress([], { ...ALL_SELECTION, today: TODAY });
    expect(emptyTitles(render(TaskProgressCard, { ...READY, title: 'Task progress', summary: none }))).toEqual(['No tasks for this selection']);
  });
});

describe('UpcomingDeadlinesCard', () => {
  const items = taskListItems(upcomingDeadlines(TASKS, { ...MY_SELECTION, today: TODAY }), PROJECTS, { name: 'analytics' });

  it('lists the open tasks that are overdue or due soon, by due date, as links to the task', () => {
    const html = render(UpcomingDeadlinesCard, { ...READY, items, today: TODAY });
    expect(inner(html, 'a')).toEqual(['Logo set', 'Colour tokens']);
    expect(tags(html, 'a').map((tag) => attribute(tag, 'href'))).toEqual(['#/analytics?task=t1', '#/analytics?task=t2']);
    expect(ariaLabels(html, 'ul', 'web-rows')).toEqual(['Upcoming deadlines']);
    expect(text(html)).toContain('Brand refresh');
  });

  it('has loading, failed and empty states', () => {
    expect(loadingLabels(render(UpcomingDeadlinesCard, { ...LOADING, items: [], today: TODAY }))).toEqual(['Loading deadlines']);
    expect(text(render(UpcomingDeadlinesCard, { ...FAILED, items: [], today: TODAY }))).toContain('Couldn’t load the tasks');
    expect(emptyTitles(render(UpcomingDeadlinesCard, { ...READY, items: [], today: TODAY }))).toEqual(['Nothing due in the next 7 days']);
  });
});

describe('ReportSettingsDialog: focus after deleting a saved view', () => {
  it('goes to the next view, else the previous one, else "Save current view…" (null)', () => {
    expect(focusAfterDelete(['v1', 'v2', 'v3'], 'v1')).toBe('v2');
    expect(focusAfterDelete(['v1', 'v2', 'v3'], 'v2')).toBe('v3');
    expect(focusAfterDelete(['v1', 'v2', 'v3'], 'v3')).toBe('v2');
    expect(focusAfterDelete(['v1'], 'v1')).toBeNull();
    expect(focusAfterDelete(['v1'], 'missing')).toBeNull();
  });
});

describe('AssignedProjectsCard', () => {
  const items = assignedProjects({ projects: PROJECTS, tasks: TASKS, me: ME, projectRows: MINE.projects, projectFilter: { kind: 'all' } });

  it('lists the projects the viewer leads or has open tasks in, with their active time', () => {
    const html = render(AssignedProjectsCard, { ...READY, items });
    expect(inner(html, 'a')).toEqual(['Brand refresh']);
    expect(attribute(tags(html, 'a')[0] ?? '', 'href')).toBe('#/projects/p1');
    expect(text(html)).toContain('Lead');
    expect(text(html)).toContain('2 open tasks');
    expect(text(html)).toContain('3h 00m active');
    // While the viewer's time loads, the rows show without it.
    expect(text(render(AssignedProjectsCard, { ...READY, items, timeLoading: true }))).not.toMatch(DURATION);
  });

  it('names the application filter: the time shown is in that application only', () => {
    const html = render(AssignedProjectsCard, { ...READY, items, applicationName: 'Figma' });
    expect(text(html)).toContain('Projects you lead or have open tasks in, with your active time in Figma in this range.');
    expect(text(html)).toContain('3h 00m active in Figma');
    expect(text(render(AssignedProjectsCard, { ...READY, items }))).toContain('with your active time in this range.');
  });

  it('shows no figure under the Unattributed filter (no project has time there)', () => {
    const unattributed = assignedProjects({ projects: PROJECTS, tasks: TASKS, me: ME, projectRows: MINE.projects, projectFilter: { kind: 'unattributed' } });
    const html = render(AssignedProjectsCard, { ...READY, items: unattributed });
    expect(inner(html, 'a')).toEqual(['Brand refresh']);
    expect(text(html)).not.toMatch(DURATION);
  });

  it('has loading, failed and empty states', () => {
    expect(loadingLabels(render(AssignedProjectsCard, { ...LOADING, items: [] }))).toEqual(['Loading projects']);
    expect(text(render(AssignedProjectsCard, { ...FAILED, items: [] }))).toContain('Couldn’t load the projects');
    expect(emptyTitles(render(AssignedProjectsCard, { ...READY, items: [] }))).toEqual(['No assigned projects']);
  });

  it('under a project filter that is not one of the viewer’s projects, says the filter hides them', () => {
    const none = assignedProjects({ projects: PROJECTS, tasks: TASKS, me: ME, projectRows: MINE.projects, projectFilter: { kind: 'project', id: 'p2' } });
    expect(none).toEqual([]);
    const html = render(AssignedProjectsCard, { ...READY, items: none, projectFiltered: true });
    expect(emptyTitles(html)).toEqual(['Not one of your assigned projects']);
    expect(text(html)).toContain('You don’t lead the selected project or have an open task in it. Choose All projects to see yours.');
  });
});

// ---------------------------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------------------------

describe('PrivacyNote', () => {
  it('renders the three variants: private, visible to admins (as a member), visible to admins (as owner or admin)', () => {
    const variants = [
      [{ role: 'member', timeEntryVisibility: 'private' }, 'Time in this workspace is private to each person. You see only your own. Only the workspace owner can change this.'],
      [{ role: 'member', timeEntryVisibility: 'admins' }, 'Owners and admins can see members’ time in this workspace, including yours. You see only your own.'],
      [{ role: 'admin', timeEntryVisibility: 'admins' }, 'Includes the time of everyone in this workspace, including former members.'],
    ] as const;
    for (const [workspace, expected] of variants) {
      const html = render(PrivacyNote, { text: privacyNote(workspace) });
      expect(text(html)).toBe(expected);
      expect(attribute(tags(html, 'p')[0] ?? '', 'class')).toBe('web-analytics-note');
    }
    // An owner whose workspace is private sees the private note; the old "owner can share it" copy is gone.
    expect(privacyNote({ role: 'owner', timeEntryVisibility: 'private' })).toBe(variants[0][1]);
    expect(privacyNote({ role: 'owner', timeEntryVisibility: 'admins' })).toBe(variants[2][1]);
    expect(RENDERED.join('')).not.toMatch(/can share/i);
  });
});

describe('WorkspacePrivatePanel (teammates’ time not visible)', () => {
  const base: WorkspacePrivatePanelProps = {
    note: privacyNote({ role: 'member', timeEntryVisibility: 'private' }),
    tasks: READY,
    progress: summarizeTaskProgress(TASKS, { ...ALL_SELECTION, today: TODAY }),
    projectRows: projectProgressRows({ projects: PROJECTS, tasks: TASKS, selection: ALL_SELECTION, projectRows: null, labels: LABELS, today: TODAY }),
    onShowMyWork: noop,
  };

  it('renders no time figures: no tiles, no charts, no time columns, no durations', () => {
    const html = render(WorkspacePrivatePanel, base);
    expect(html).not.toContain('sp-stat');
    expect(html).not.toContain('sp-area');
    expect(html).not.toContain('sp-barlist');
    expect(html).not.toContain('sp-timeline');
    expect(html).not.toContain('<svg class="sp-');
    expect(columnHeaders(html)).toEqual(['Project', 'Tasks done', 'In review', 'Overdue']);
    expect(text(html)).not.toMatch(DURATION);
    expect(text(html)).not.toMatch(/\bActive\b|\bIdle\b|In foreground|Sessions/);
  });

  it('shows the privacy note, task progress, the tasks-only project table and the way to My work', () => {
    const html = render(WorkspacePrivatePanel, base);
    expect(text(html)).toContain('Time in this workspace is private to each person. You see only your own.');
    expect(inner(html, 'button')).toEqual(['See your own time in My work']);
    expect(inner(html, 'h2')).toEqual(['Task progress', 'Projects: progress']);
    expect(captions(html)).toEqual(['Projects: task progress']);
    // By name; tasks without a project are just "No project": there is no "task time" in this view.
    expect(rowHeaders(html)).toEqual(['Annual report', 'Brand refresh', 'No project']);
    expect(inner(html, 'dd').slice(0, 5)).toEqual(['0', '1', '1', '1', '1']);
    expect(text(html)).toContain('No time is shown in this view.');
  });

  it('has loading, failed and empty states, still without any time', () => {
    const loading = render(WorkspacePrivatePanel, { ...base, tasks: LOADING, progress: null, projectRows: [] });
    expect(loadingLabels(loading)).toEqual(['Loading task progress', 'Loading project progress']);
    const failed = render(WorkspacePrivatePanel, { ...base, tasks: FAILED, progress: null, projectRows: [] });
    expect(text(failed)).toContain('Couldn’t load the tasks');
    const empty = render(WorkspacePrivatePanel, { ...base, progress: summarizeTaskProgress([], { ...ALL_SELECTION, today: TODAY }), projectRows: [] });
    expect(emptyTitles(empty)).toEqual(['No tasks for this selection', 'No projects with tasks']);
    for (const html of [loading, failed, empty]) {
      expect(text(html)).not.toMatch(DURATION);
      expect(html).not.toContain('sp-stat');
      expect(text(html)).toContain('See your own time in My work');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Project Insights
// ---------------------------------------------------------------------------------------------

describe('ProjectInsights', () => {
  const report = splitReport([
    row('total', { activeMs: 3 * H, idleMs: 30 * M, entryCount: 5, teammatesVisible: false }),
    row('period', { bucketStart: '2026-10-01', activeMs: 1 * H, idleMs: 10 * M, entryCount: 2 }),
    row('period', { bucketStart: '2026-11-01', activeMs: 2 * H, idleMs: 20 * M, entryCount: 3 }),
    row('task', { taskId: 't1', projectId: 'p1', activeMs: 2 * H, idleMs: 20 * M, entryCount: 3 }),
    row('task', { taskId: 't2', projectId: 'p1', activeMs: 1 * H, idleMs: 10 * M, entryCount: 2 }),
    row('application', { applicationId: 'figma', applicationName: 'Figma', activeMs: 3 * H, idleMs: 30 * M, entryCount: 5 }),
  ]);
  const projectTasks = TASKS.filter((candidate) => candidate.project_id === 'p1');
  const route = { name: 'project', id: 'p1' } as const;
  const base: ProjectInsightsProps = {
    range: 'all',
    onRangeChange: noop,
    teammatesVisible: false,
    loading: false,
    totals: reportTotals(report.total),
    points: periodSeries(report.periods, { fromDay: null, toDay: TODAY, bucket: 'month' }),
    bucket: 'month',
    today: TODAY,
    applications: applicationItems(report.applications, applicationColors(report.applications)),
    taskTime: taskItems(report.tasks, LABELS),
    tasks: READY,
    tasksDone: projectTasks.filter((candidate) => candidate.status === 'done').length,
    tasksTotal: projectTasks.length,
    awaitingReview: taskListItems(projectTasks.filter((candidate) => candidate.status === 'in_review'), null, route),
    overdue: taskListItems(projectTasks.filter((candidate) => candidate.id === 't1'), null, route),
    footnote: 'Only your own time is included.',
  };
  const tiles = (html: string) => {
    const labels = inner(html, 'span', 'sp-stat__label');
    const values = inner(html, 'span', 'sp-stat__value');
    return labels.map((label, index) => `${label}: ${values[index] ?? ''}`);
  };

  it('labels whose time it is from the report’s visibility', () => {
    const own = render(ProjectInsights, base);
    expect(inner(own, 'h2')).toEqual(['Insights']);
    expect(text(own)).toContain('Your time on this project');
    expect(text(own)).not.toContain('Time you can see on this project');
    const visible = render(ProjectInsights, { ...base, teammatesVisible: true });
    expect(text(visible)).toContain('Time you can see on this project');
    expect(text(visible)).not.toContain('Your time on this project');
  });

  it('shows Active, In foreground, Sessions and "Tasks done: X of Y"', () => {
    const html = render(ProjectInsights, base);
    expect(tiles(html)).toEqual(['Active: 3h 00m', 'In foreground: 3h 30m', 'Sessions: 5', 'Tasks done: 0 of 2']);
    expect(tiles(render(ProjectInsights, { ...base, tasksDone: 3, tasksTotal: 7 }))[3]).toBe('Tasks done: 3 of 7');
  });

  it('shows activity, applications, time by task with the task’s estimate, awaiting review and overdue', () => {
    const html = render(ProjectInsights, base);
    expect(inner(html, 'h3')).toEqual(['Activity over time', 'Applications', 'Time by task', 'Awaiting review', 'Overdue']);
    expect(ariaLabels(html, 'div', 'sp-area')).toEqual(['Active time on this project per month, all time. Use the arrow keys to step through the points.']);
    expect(ariaLabels(html, 'ul', 'sp-barlist')).toEqual(['Time per application', 'Active time per task']);
    expect(columnHeaders(html)).toEqual(['Task', 'Active', 'In foreground', 'Estimate (task)']);
    expect(ariaLabels(html, 'ul', 'web-rows')).toEqual(['Tasks awaiting review', 'Overdue tasks']);
    expect(inner(html, 'a')).toEqual(['Colour tokens', 'Logo set']);
    expect(tags(html, 'select').map((tag) => attribute(tag, 'aria-label'))).toEqual(['Insights range']);
    expect(inner(html, 'option')).toEqual(['All time', 'Last 90 days', 'Last 30 days']);
    expect(text(html)).toContain('Only your own time is included. Recorded application time — not billable. Manual time entries aren’t available yet.');
  });

  it('has loading, failed and empty states', () => {
    const loading = render(ProjectInsights, { ...base, loading: true, totals: null, points: [], applications: [], taskTime: [], tasks: LOADING, awaitingReview: [], overdue: [] });
    expect(loadingLabels(loading)).toEqual(['Loading activity', 'Loading applications', 'Loading time by task', 'Loading tasks', 'Loading tasks']);
    expect(tags(loading, 'div').filter((tag) => attribute(tag, 'aria-busy') === 'true')).toHaveLength(4);
    expect(text(loading)).not.toMatch(DURATION);

    // A failed first read: the banner with Retry, no charts, the task lists still there.
    const failed = render(ProjectInsights, { ...base, problem: NETWORK, onRetry: noop, totals: null, points: [], applications: [], taskTime: [] });
    expect(text(failed)).toContain('Couldn’t load the recorded time');
    expect(inner(failed, 'button')).toEqual(['Retry']);
    expect(failed).not.toContain('sp-area');
    expect(inner(failed, 'h3')).toEqual(['Awaiting review', 'Overdue']);
    expect(tiles(failed)).toEqual(['Active: —', 'In foreground: —', 'Sessions: —', 'Tasks done: 0 of 2']);

    // The task list failing leaves the time alone and shows no made-up count.
    const tasksFailed = render(ProjectInsights, { ...base, tasks: FAILED, tasksDone: 0, tasksTotal: 0, awaitingReview: [], overdue: [] });
    expect(tiles(tasksFailed)[3]).toBe('Tasks done: —');
    expect(text(tasksFailed)).toContain('Couldn’t load the tasks');
    expect(tasksFailed).toContain('sp-area');

    const empty = render(ProjectInsights, { ...base, totals: reportTotals(splitReport([]).total), points: [], applications: [], taskTime: [], tasksDone: 0, tasksTotal: 0, awaitingReview: [], overdue: [] });
    expect(emptyTitles(empty)).toEqual([
      'No time attributed yet',
      'No application time in this range',
      'No time on tasks in this range',
      'No tasks awaiting review',
      'No overdue tasks',
    ]);
    expect(tiles(empty)).toEqual(['Active: 0m', 'In foreground: 0m', 'Sessions: 0', 'Tasks done: 0 of 0']);
  });
});

// ---------------------------------------------------------------------------------------------
// Header, toolbar and notes
// ---------------------------------------------------------------------------------------------

describe('AnalyticsHeaderActions and AnalyticsToolbar', () => {
  const toolbar: AnalyticsToolbarProps = {
    view: 'mine',
    onViewChange: noop,
    range: { preset: 'last7' },
    onRangeChange: noop,
    resolvedDays: { fromDay: WEEK.fromDay, toDay: WEEK.toDay },
    rangeText: WEEK.label,
    projectValue: ALL,
    projectOptions: projectFilterOptions(PROJECTS),
    onProjectChange: noop,
    applicationValue: ALL,
    applicationOptions: applicationOptions(MINE.applications, null),
    onApplicationChange: noop,
    timeZone: ZONE,
    onOpenSettings: noop,
  };
  const selects = (html: string) => tags(html, 'select').map((tag) => attribute(tag, 'aria-label'));

  it('shows when the report was read, in the reporting zone, with Refresh and Export', () => {
    const html = render(AnalyticsHeaderActions, { updatedAt: NOW, timeZone: ZONE, refreshing: false, onRefresh: noop, exportKinds: ['summary-csv', 'summary-json'], onExport: noop });
    expect(text(html)).toContain('Updated 15:00');
    expect(html).toContain('aria-label="Refresh"');
    expect(text(html)).toContain('Export');
    const before = render(AnalyticsHeaderActions, { updatedAt: null, timeZone: ZONE, refreshing: false, onRefresh: noop, exportKinds: [], onExport: noop });
    expect(text(before)).not.toContain('Updated');
    expect(text(before)).not.toContain('Export');
  });

  it('offers project and application filters, and "Time of" only when it is given', () => {
    const mine = render(AnalyticsToolbar, toolbar);
    expect(selects(mine)).toEqual(['Project', 'Application']);
    expect(mine).not.toContain('web-filter--active');
    expect(text(mine)).toContain('Report settings');
    expect(text(mine)).toContain(ZONE);

    const timeOf = { value: EVERYONE, options: timeOfOptions(MEMBERS, TEAM.members, LABELS), onChange: noop };
    const workspace = render(AnalyticsToolbar, { ...toolbar, view: 'workspace', timeOf });
    expect(selects(workspace)).toEqual(['Project', 'Application', 'Time of']);
    // People are offered alphabetically after "Everyone you can see", never by time.
    const options = inner(workspace, 'option');
    expect(options.slice(options.indexOf('Everyone you can see'))).toEqual(['Everyone you can see', 'Ana', 'Mira', 'Zoe']);
  });

  it('marks active filters, and hides the range and application where no time is shown', () => {
    const filtered = render(AnalyticsToolbar, { ...toolbar, projectValue: encodeProjectFilter({ kind: 'project', id: 'p1' }), applicationValue: 'figma' });
    expect(filtered.match(/web-filter--active/g)).toHaveLength(2);
    const hidden = render(AnalyticsToolbar, { ...toolbar, view: 'workspace', timeHidden: true, timeOf: { value: EVERYONE, options: [], onChange: noop } });
    expect(selects(hidden)).toEqual(['Project']);
    expect(hidden).not.toContain('aria-label="Range"');
    expect(text(hidden)).not.toContain('Last 7 days');
  });
});

describe('notes', () => {
  it('announces politely, names the unknown time zone, and states what the figures are', () => {
    const live = render(LiveRegion, { message: 'Analytics updated' });
    expect(attribute(tags(live, 'div')[0] ?? '', 'aria-live')).toBe('polite');
    expect(attribute(tags(live, 'div')[0] ?? '', 'role')).toBe('status');
    expect(text(live)).toBe('Analytics updated');
    expect(text(render(TimeZoneNotice, { zone: 'Mars/Olympus' }))).toContain('The reporting time zone “Mars/Olympus” isn’t available, so this report uses UTC.');
    const footnote = text(render(AnalyticsFootnote, { overlapMs: 10 * M }));
    expect(footnote).toBe(analyticsFootnote(10 * M));
    expect(footnote).toContain('Recorded application time — not billable.');
    expect(footnote).toContain('(10m overlapped)');
    expect(text(render(AnalyticsFootnote, { overlapMs: 0 }))).not.toContain('overlapped');
  });
});

// ---------------------------------------------------------------------------------------------
// Everything rendered above: wording and structure
// ---------------------------------------------------------------------------------------------

describe('everything rendered', () => {
  it('covers a meaningful amount of markup', () => {
    expect(RENDERED.length).toBeGreaterThan(60);
  });

  it('never judges: no "better", "worse", "rank", "score" or "productiv" anywhere in the markup', () => {
    for (const html of RENDERED) expect(html).not.toMatch(/better|worse|rank|score|productiv/i);
  });

  it('gives every table a caption, scoped headers and an overflow wrapper it is labelled by', () => {
    const all = RENDERED.join('\n');
    const tables = [...all.matchAll(/<div class="web-table-wrap[^"]*"([^>]*)><table\b[^>]*>(.*?)<\/table>/gs)];
    expect(tables.length).toBeGreaterThan(10);
    expect(tables).toHaveLength(tags(all, 'table').length);
    for (const [, wrapper = '', body = ''] of tables) {
      const caption = /^<caption id="([^"]*)"[^>]*>(.+?)<\/caption>/s.exec(body);
      expect(caption?.[2]).toBeTruthy();
      expect(wrapper).toContain(`aria-labelledby="${caption?.[1] ?? ''}"`);
      const headers = tags(body, 'th');
      expect(headers.length).toBeGreaterThan(0);
      expect(headers.every((tag) => ['col', 'row'].includes(attribute(tag, 'scope') ?? ''))).toBe(true);
    }
  });

  it('gives every chart an accessible name', () => {
    const all = RENDERED.join('\n');
    const areas = ariaLabels(all, 'div', 'sp-area');
    const bars = ariaLabels(all, 'ul', 'sp-barlist');
    const groups = tags(all, 'div').filter((tag) => attribute(tag, 'role') === 'group');
    expect(areas.length).toBeGreaterThan(5);
    expect(bars.length).toBeGreaterThan(10);
    for (const label of [...areas, ...bars, ...groups.map((tag) => attribute(tag, 'aria-label'))]) {
      expect(label).toBeTruthy();
      expect((label ?? '').length).toBeGreaterThan(8);
    }
  });
});
