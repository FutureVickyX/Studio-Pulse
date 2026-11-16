/**
 * The Analytics cards that show recorded time: tiles, activity, applications, projects, tasks and
 * members. Plain view-model props (from `lib/analytics.ts` and `./models`), no data fetching.
 * Figures are neutral: no scores, no ranking of people, no signed changes.
 */

import { memo, useMemo } from 'react';
import {
  AreaChart,
  BarList,
  Card,
  Disclosure,
  IconApps,
  IconChart,
  IconClock,
  IconInfo,
  Legend,
  Select,
  StatGrid,
  StatTile,
  TOTAL_COLOR,
  TimelineStrip,
  Tooltip,
} from '@studio-pulse/ui';
import type { BarListRow, LegendItem } from '@studio-pulse/ui';

import { MEASUREMENTS, activityChartData, periodTitle, scopedLabel } from '../../lib/analytics';
import type {
  ApplicationItem,
  BucketChoice,
  MemberItem,
  PeriodPoint,
  ProjectItem,
  ProjectProgressRow,
  ReportBucket,
  TaskItem,
  TimeFigures,
} from '../../lib/analytics';
import { formatDuration } from '../../lib/format';

import type { DayTimeline, SourceState } from './models';
import { CardBody, DataTable } from './shared';
import type { TableColumn } from './shared';

const DASH = '—';
const SESSIONS_NOTE = 'A session spanning two days counts in each';

const ACTIVE_IDLE_LEGEND: ReadonlyArray<LegendItem> = [
  { id: 'active', label: 'Active', color: TOTAL_COLOR, variant: 'solid' },
  { id: 'idle', label: 'Idle', color: TOTAL_COLOR, variant: 'hatched' },
];

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

/** The neutral reference line under Active: the previous period's total, never a change. */
export type PreviousReference =
  | { readonly status: 'hidden' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; /** `previousReferenceText(range, activeMs)` */ readonly text: string }
  | { readonly status: 'error'; readonly onRetry?: (() => void) | undefined };

export interface SummaryTilesProps {
  /** Whose time this is when it is not the viewer's own (`whoseTime`), else null. */
  who: string | null;
  loading: boolean;
  stale?: boolean;
  /** The report's totals, or null while there is none. */
  totals: TimeFigures | null;
  /** Time with no project and no task (`unattributedTime`). */
  unattributed: TimeFigures | null;
  /** A project filter is set: the third tile shows Idle instead of Unattributed. */
  projectFiltered: boolean;
  previous: PreviousReference;
}

function PreviousLine({ previous }: { previous: PreviousReference }) {
  switch (previous.status) {
    case 'hidden':
      return null;
    case 'loading':
      return <span className="web-analytics-ref">Previous period: loading…</span>;
    case 'ready':
      return <span className="web-analytics-ref">{previous.text}</span>;
    case 'error':
      return (
        <span className="web-analytics-ref">
          Previous period unavailable.{' '}
          {previous.onRetry ? (
            <button type="button" className="web-link" onClick={previous.onRetry}>
              Retry
            </button>
          ) : null}
        </span>
      );
  }
}

export const SummaryTiles = memo(function SummaryTiles({
  who,
  loading,
  stale = false,
  totals,
  unattributed,
  projectFiltered,
  previous,
}: SummaryTilesProps) {
  const time = (ms: number | undefined) => (ms === undefined ? DASH : formatDuration(ms));
  return (
    <StatGrid className="web-analytics-tiles">
      <StatTile
        label={scopedLabel(who, 'Active')}
        value={time(totals?.activeMs)}
        loading={loading}
        stale={stale}
        meta={
          <>
            <span>{MEASUREMENTS.activeTime}</span>
            <PreviousLine previous={previous} />
          </>
        }
      />
      <StatTile
        label={scopedLabel(who, 'In foreground')}
        value={time(totals?.foregroundMs)}
        loading={loading}
        stale={stale}
        meta={totals ? `Active + idle · ${formatDuration(totals.idleMs)} idle` : 'Active + idle'}
      />
      {projectFiltered ? (
        <StatTile label={scopedLabel(who, 'Idle')} value={time(totals?.idleMs)} loading={loading} stale={stale} meta={MEASUREMENTS.idleTime} />
      ) : (
        <StatTile
          label={scopedLabel(who, 'Unattributed')}
          value={time(unattributed?.activeMs)}
          loading={loading}
          stale={stale}
          meta="Active time with no project or task"
        />
      )}
      <StatTile
        label={
          <>
            {scopedLabel(who, 'Sessions')}
            <Tooltip content={SESSIONS_NOTE}>
              <button type="button" className="web-analytics-info" aria-label={SESSIONS_NOTE}>
                <IconInfo size={12} />
              </button>
            </Tooltip>
          </>
        }
        value={totals ? totals.sessions.toLocaleString('en-GB') : DASH}
        loading={loading}
        stale={stale}
        meta="Synced sessions with time in this range"
      />
    </StatGrid>
  );
});

// ---------------------------------------------------------------------------------------------
// Activity over time
// ---------------------------------------------------------------------------------------------

const BUCKET_NOUN: Readonly<Record<ReportBucket, string>> = { day: 'day', week: 'week', month: 'month' };
const BUCKET_LABEL: Readonly<Record<ReportBucket, string>> = { day: 'Day', week: 'Week', month: 'Month' };

/** The viewer's single day, drawn as a timeline instead of the area chart (My work only). */
export interface ActivityTimelineState extends SourceState {
  /** `dayTimeline(...)`, or null while loading. */
  timeline: DayTimeline | null;
  /** More sessions that day than were loaded (the cap). */
  truncated?: boolean;
}

export interface ActivityCardProps {
  who: string | null;
  loading: boolean;
  stale?: boolean;
  /** `periodSeries(...)`: one point per bucket. */
  points: ReadonlyArray<PeriodPoint>;
  /** The bucket the points use (`resolveBucket`). */
  bucket: ReportBucket;
  bucketChoice: BucketChoice;
  /** `allowedBuckets(range.days)`. */
  bucketOptions: ReadonlyArray<ReportBucket>;
  onBucketChange: (choice: BucketChoice) => void;
  /** Today in the reporting zone, for labels. */
  today: string;
  /** "3–9 Nov" / "Last 7 days": named in the chart's and table's accessible names. */
  rangeLabel: string;
  /** Set for a single-day range in My work: the day's timeline replaces the chart. */
  timeline?: ActivityTimelineState | null;
}

const ACTIVITY_COLUMNS = (bucket: ReportBucket, today: string): ReadonlyArray<TableColumn<PeriodPoint>> => [
  {
    id: 'period',
    header: BUCKET_LABEL[bucket],
    rowHeader: true,
    cell: (point) => `${periodTitle(point.bucketStart, bucket, today)}${point.partial ? ' (partial)' : ''}`,
  },
  { id: 'active', header: 'Active', align: 'end', cell: (point) => formatDuration(point.activeMs) },
  { id: 'idle', header: 'Idle', align: 'end', cell: (point) => formatDuration(point.idleMs) },
  { id: 'foreground', header: 'In foreground', align: 'end', cell: (point) => formatDuration(point.foregroundMs) },
  { id: 'sessions', header: 'Sessions', title: SESSIONS_NOTE, align: 'end', cell: (point) => point.sessions },
];

export const ActivityCard = memo(function ActivityCard({
  who,
  loading,
  stale = false,
  points,
  bucket,
  bucketChoice,
  bucketOptions,
  onBucketChange,
  today,
  rangeLabel,
  timeline = null,
}: ActivityCardProps) {
  const data = useMemo(() => activityChartData(points, bucket, { today, who }), [points, bucket, today, who]);
  const columns = useMemo(() => ACTIVITY_COLUMNS(bucket, today), [bucket, today]);
  const hasTime = points.some((point) => point.foregroundMs > 0);
  const options = [
    { value: 'auto' as BucketChoice, label: bucketChoice === 'auto' ? `Auto (${BUCKET_NOUN[bucket]})` : 'Auto' },
    ...bucketOptions.map((option) => ({ value: option as BucketChoice, label: BUCKET_LABEL[option] })),
  ];
  const title = scopedLabel(who, 'Activity over time');

  return (
    <Card
      title={title}
      description={timeline ? 'Your sessions through the day. Idle is hatched.' : `Active time per ${BUCKET_NOUN[bucket]}.`}
      headingLevel={2}
      actions={
        timeline ? null : <Select aria-label="Bucket" selectSize="sm" value={bucketChoice} onChange={onBucketChange} options={options} />
      }
    >
      {timeline ? (
        <CardBody
          loading={timeline.loading}
          loadingLabel="Loading the day’s sessions"
          skeletonLines={3}
          problem={timeline.problem}
          onRetry={timeline.onRetry}
          empty={timeline.timeline === null || timeline.timeline.items.length === 0}
          emptyTitle="No sessions on this day"
          emptyText="Sessions appear here after they end and sync from the desktop app."
          emptyIcon={<IconClock size={20} />}
        >
          {timeline.timeline ? (
            <>
              <TimelineStrip
                startMs={timeline.timeline.startMs}
                endMs={timeline.timeline.endMs}
                items={timeline.timeline.items}
                ticks={timeline.timeline.ticks}
                nowMs={timeline.timeline.nowMs}
                stale={stale}
                aria-label={`Your sessions, ${rangeLabel}`}
              />
              <Legend
                items={[
                  ...timeline.timeline.applications.map((application) => ({
                    id: application.id,
                    label: application.label,
                    color: application.color,
                  })),
                  { id: 'idle', label: 'Idle', color: TOTAL_COLOR, variant: 'hatched' as const },
                ]}
              />
              {timeline.truncated ? (
                <p className="web-footnote">This day has more sessions than the timeline loads; the totals above count all of them.</p>
              ) : null}
            </>
          ) : null}
        </CardBody>
      ) : (
        <CardBody
          loading={loading}
          loadingLabel="Loading activity"
          skeletonLines={5}
          empty={!hasTime}
          emptyTitle="No recorded time in this range"
          emptyText="Try a longer range or other filters. Sessions appear after they end and sync."
          emptyIcon={<IconChart size={20} />}
        >
          <AreaChart data={data} stale={stale} aria-label={`${scopedLabel(who, 'Active time')} per ${BUCKET_NOUN[bucket]}, ${rangeLabel}`} />
        </CardBody>
      )}
      {!loading && points.length > 0 && hasTime ? (
        <Disclosure summary="Show as a table">
          <DataTable
            caption={`${scopedLabel(who, 'Recorded time')} per ${BUCKET_NOUN[bucket]}, ${rangeLabel}`}
            columns={columns}
            rows={points}
            rowKey={(point) => point.bucketStart}
            stale={stale}
          />
        </Disclosure>
      ) : null}
    </Card>
  );
});

// ---------------------------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------------------------

export interface ApplicationsCardProps {
  who: string | null;
  loading: boolean;
  stale?: boolean;
  /** `applicationItems(...)`, by active time. */
  items: ReadonlyArray<ApplicationItem>;
  headingLevel?: 2 | 3;
}

export const ApplicationsCard = memo(function ApplicationsCard({ who, loading, stale = false, items, headingLevel = 2 }: ApplicationsCardProps) {
  const rows = useMemo<BarListRow[]>(
    () =>
      items.map((item) => ({
        id: item.key,
        label: item.label,
        color: item.color,
        segments: [
          { value: item.activeMs, variant: 'solid' },
          { value: item.idleMs, variant: 'hatched' },
        ],
        primary: formatDuration(item.activeMs),
        secondary: item.idleMs > 0 ? `+ ${formatDuration(item.idleMs)} idle` : null,
        tooltip: {
          title: item.label,
          ...(who ? { subtitle: who } : {}),
          rows: [
            { id: 'active', label: 'Active', value: formatDuration(item.activeMs), color: item.color, variant: 'solid' },
            { id: 'idle', label: 'Idle', value: formatDuration(item.idleMs), color: item.color, variant: 'hatched' },
            { id: 'foreground', label: 'In foreground', value: formatDuration(item.foregroundMs) },
            { id: 'sessions', label: 'Sessions', value: item.sessions },
          ],
        },
        ariaLabel: `${item.label}: ${formatDuration(item.activeMs)} active, ${formatDuration(item.idleMs)} idle`,
      })),
    [items, who],
  );
  return (
    <Card title={scopedLabel(who, 'Applications')} description="Active time per application. Idle is hatched." headingLevel={headingLevel}>
      <CardBody
        loading={loading}
        loadingLabel="Loading applications"
        empty={items.length === 0}
        emptyTitle="No application time in this range"
        emptyText="Applications appear once a tracked application has synced sessions here."
        emptyIcon={<IconApps size={20} />}
      >
        <BarList className="web-analytics-bars" rows={rows} stale={stale} aria-label={`${scopedLabel(who, 'Time')} per application`} />
        <Legend items={ACTIVE_IDLE_LEGEND} />
      </CardBody>
    </Card>
  );
});

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

function tasksDone(row: ProjectProgressRow): string {
  return row.tasksTotal === 0 ? DASH : `${row.tasksDone} of ${row.tasksTotal}`;
}

const figure = (row: ProjectProgressRow, pick: (time: TimeFigures) => string | number) => (row.time ? pick(row.time) : DASH);

function progressColumns(showTime: boolean): ReadonlyArray<TableColumn<ProjectProgressRow>> {
  const time: ReadonlyArray<TableColumn<ProjectProgressRow>> = [
    { id: 'active', header: 'Active', align: 'end', cell: (row) => figure(row, (t) => formatDuration(t.activeMs)) },
    { id: 'foreground', header: 'In foreground', align: 'end', cell: (row) => figure(row, (t) => formatDuration(t.foregroundMs)) },
    { id: 'sessions', header: 'Sessions', title: SESSIONS_NOTE, align: 'end', cell: (row) => figure(row, (t) => t.sessions) },
  ];
  return [
    { id: 'project', header: 'Project', rowHeader: true, cell: (row) => row.label },
    ...(showTime ? time : []),
    { id: 'done', header: 'Tasks done', title: 'Done of all tasks, current status', align: 'end', cell: tasksDone },
    { id: 'review', header: 'In review', align: 'end', cell: (row) => row.inReview },
    { id: 'overdue', header: 'Overdue', title: 'Not done, due before today', align: 'end', cell: (row) => row.overdue },
  ];
}

export interface ProjectProgressTableProps {
  /** `projectProgressRows(...)`. */
  rows: ReadonlyArray<ProjectProgressRow>;
  /** False for the tasks-only table (teammates' time not visible): no time columns at all. */
  showTime: boolean;
  caption: string;
  captionHidden?: boolean;
  stale?: boolean;
}

/** "Projects: time and progress", or tasks only. Task counts are the current status. */
export function ProjectProgressTable({ rows, showTime, caption, captionHidden = false, stale = false }: ProjectProgressTableProps) {
  const columns = useMemo(() => progressColumns(showTime), [showTime]);
  return <DataTable caption={caption} captionHidden={captionHidden} columns={columns} rows={rows} rowKey={(row) => row.key} stale={stale} />;
}

export interface ProjectsCardProps {
  who: string | null;
  loading: boolean;
  stale?: boolean;
  /** `projectItems(...)`: projects by active time, "No project (task time)", then "Unattributed" last. */
  items: ReadonlyArray<ProjectItem>;
  /** `projectProgressRows(...)` for the table view. */
  progressRows: ReadonlyArray<ProjectProgressRow>;
  /** The task list behind the table's task columns (an independent source). */
  tasks: SourceState;
  /** Caption of the table view: "Projects: time and progress". */
  tableCaption?: string;
  /** `#/time`, or null to leave the link out (time that is not the viewer's own). */
  attributeHref?: string | null;
}

export const ProjectsCard = memo(function ProjectsCard({
  who,
  loading,
  stale = false,
  items,
  progressRows,
  tasks,
  tableCaption = 'Projects: time and progress',
  attributeHref = null,
}: ProjectsCardProps) {
  const rows = useMemo<BarListRow[]>(
    () =>
      items.map((item) => ({
        id: item.key,
        label: item.label,
        color: TOTAL_COLOR,
        segments: [{ value: item.activeMs, variant: 'solid' }],
        primary: formatDuration(item.activeMs),
        tooltip: {
          title: item.label,
          ...(who ? { subtitle: who } : {}),
          rows: [
            { id: 'active', label: 'Active', value: formatDuration(item.activeMs) },
            { id: 'foreground', label: 'In foreground', value: formatDuration(item.foregroundMs) },
            { id: 'sessions', label: 'Sessions', value: item.sessions },
          ],
        },
        ariaLabel: `${item.label}: ${formatDuration(item.activeMs)} active`,
      })),
    [items, who],
  );
  return (
    <Card title={scopedLabel(who, 'Projects')} description="Active time per project." headingLevel={2}>
      <CardBody
        loading={loading}
        loadingLabel="Loading projects"
        empty={items.length === 0}
        emptyTitle="No time in this range"
        emptyText="Time shows under a project once sessions are attributed to it or to one of its tasks."
        emptyIcon={<IconClock size={20} />}
      >
        <BarList className="web-analytics-bars" rows={rows} stale={stale} aria-label={`${scopedLabel(who, 'Active time')} per project`} />
      </CardBody>
      {attributeHref ? (
        <p className="web-analytics-card-link">
          <a className="web-link" href={attributeHref} title="The Time page uses its own fixed ranges, not this report’s range">
            Attribute on the Time page →
          </a>
        </p>
      ) : null}
      {loading ? null : (
        <Disclosure summary="Show as a table">
          <CardBody
            loading={tasks.loading}
            loadingLabel="Loading task progress"
            skeletonLines={3}
            problem={tasks.problem}
            onRetry={tasks.onRetry}
            problemTitle="Couldn’t load the tasks"
            empty={progressRows.length === 0}
            emptyTitle="No projects with time or tasks"
          >
            <ProjectProgressTable rows={progressRows} showTime caption={tableCaption} stale={stale} />
            <p className="web-footnote">Task counts: {MEASUREMENTS.taskProgress}</p>
          </CardBody>
        </Disclosure>
      )}
    </Card>
  );
});

// ---------------------------------------------------------------------------------------------
// Time by task
// ---------------------------------------------------------------------------------------------

export const TOP_TASKS = 10;

function estimateText(minutes: number | null): string {
  return minutes === null ? DASH : formatDuration(minutes * 60_000);
}

const TASK_COLUMNS: ReadonlyArray<TableColumn<TaskItem>> = [
  { id: 'task', header: 'Task', rowHeader: true, cell: (item) => item.label },
  { id: 'project', header: 'Project', cell: (item) => item.projectLabel },
  { id: 'active', header: 'Active', align: 'end', cell: (item) => formatDuration(item.activeMs) },
  { id: 'foreground', header: 'In foreground', align: 'end', cell: (item) => formatDuration(item.foregroundMs) },
  {
    id: 'estimate',
    header: 'Estimate (task)',
    title: 'The task’s own estimate. Projects have no budgets.',
    align: 'end',
    cell: (item) => estimateText(item.estimateMinutes),
  },
];

export interface TimeByTaskCardProps {
  who: string | null;
  loading: boolean;
  stale?: boolean;
  /** `taskItems(...)`: tasks by active time, then time without a task, then "Unattributed". */
  items: ReadonlyArray<TaskItem>;
  /** Leave the Project column out (Project Insights: every row is this project's). */
  hideProject?: boolean;
  headingLevel?: 2 | 3;
}

export const TimeByTaskCard = memo(function TimeByTaskCard({
  who,
  loading,
  stale = false,
  items,
  hideProject = false,
  headingLevel = 2,
}: TimeByTaskCardProps) {
  const tasks = useMemo(() => items.filter((item) => item.kind === 'task'), [items]);
  const rows = useMemo<BarListRow[]>(
    () =>
      tasks.slice(0, TOP_TASKS).map((item) => ({
        id: item.key,
        label: item.label,
        color: TOTAL_COLOR,
        segments: [{ value: item.activeMs, variant: 'solid' }],
        primary: formatDuration(item.activeMs),
        secondary: hideProject ? null : item.projectLabel,
        tooltip: {
          title: item.label,
          subtitle: [who, hideProject ? null : item.projectLabel].filter(Boolean).join(' · ') || undefined,
          rows: [
            { id: 'active', label: 'Active', value: formatDuration(item.activeMs) },
            { id: 'foreground', label: 'In foreground', value: formatDuration(item.foregroundMs) },
            ...(item.estimateMinutes !== null ? [{ id: 'estimate', label: 'Estimate (task)', value: estimateText(item.estimateMinutes) }] : []),
          ],
        },
        ariaLabel: `${item.label}: ${formatDuration(item.activeMs)} active`,
      })),
    [tasks, who, hideProject],
  );
  const columns = useMemo(() => (hideProject ? TASK_COLUMNS.filter((column) => column.id !== 'project') : TASK_COLUMNS), [hideProject]);
  return (
    <Card
      title={scopedLabel(who, 'Time by task')}
      description={tasks.length > TOP_TASKS ? `The ${TOP_TASKS} tasks with the most active time; the table lists all ${tasks.length}.` : 'Active time per task.'}
      headingLevel={headingLevel}
    >
      <CardBody
        loading={loading}
        loadingLabel="Loading time by task"
        empty={tasks.length === 0}
        emptyTitle="No time on tasks in this range"
        emptyText="Attribute sessions to a task on the Time page to see them here."
        emptyIcon={<IconClock size={20} />}
      >
        <BarList className="web-analytics-bars" rows={rows} stale={stale} aria-label={`${scopedLabel(who, 'Active time')} per task`} />
      </CardBody>
      {!loading && items.length > 0 ? (
        <Disclosure summary="Show as a table">
          <DataTable
            caption={scopedLabel(who, 'Time by task')}
            captionHidden
            columns={columns}
            rows={items}
            rowKey={(item) => item.key}
            stale={stale}
          />
          <p className="web-footnote">{MEASUREMENTS.estimates}</p>
        </Disclosure>
      ) : null}
    </Card>
  );
});

// ---------------------------------------------------------------------------------------------
// Members (alphabetical; no sorting by time, no change column)
// ---------------------------------------------------------------------------------------------

const MEMBER_COLUMNS: ReadonlyArray<TableColumn<MemberItem>> = [
  { id: 'member', header: 'Member', rowHeader: true, cell: (item) => item.name },
  { id: 'active', header: 'Active', align: 'end', cell: (item) => formatDuration(item.activeMs) },
  { id: 'idle', header: 'Idle', align: 'end', cell: (item) => formatDuration(item.idleMs) },
  { id: 'foreground', header: 'In foreground', align: 'end', cell: (item) => formatDuration(item.foregroundMs) },
  { id: 'sessions', header: 'Sessions', title: SESSIONS_NOTE, align: 'end', cell: (item) => item.sessions },
];

export interface MembersCardProps {
  loading: boolean;
  stale?: boolean;
  /** `memberItems(...)`: alphabetical, former members last. Shown in the order given. */
  items: ReadonlyArray<MemberItem>;
  /** "3–9 Nov": named in the table's caption. */
  rangeLabel: string;
}

export const MembersCard = memo(function MembersCard({ loading, stale = false, items, rangeLabel }: MembersCardProps) {
  return (
    <Card title="Members" description="Recorded time per person, in alphabetical order." headingLevel={2}>
      <CardBody
        loading={loading}
        loadingLabel="Loading members"
        empty={items.length === 0}
        emptyTitle="No recorded time in this range"
        emptyText="People appear here once their sessions in this range have synced."
        emptyIcon={<IconClock size={20} />}
      >
        <DataTable
          caption={`Recorded time per member, ${rangeLabel}`}
          captionHidden
          columns={MEMBER_COLUMNS}
          rows={items}
          rowKey={(item) => item.userId}
          stale={stale}
        />
      </CardBody>
    </Card>
  );
});
