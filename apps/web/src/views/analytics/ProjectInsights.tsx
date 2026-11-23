/**
 * Project Insights: the full-width section on a project's page that replaces the "Tracked time"
 * card and keeps what it showed (active, in foreground, sessions, time per task, the visibility
 * footnote). Recorded time and task counts only: no budgets, no efficiency conclusions.
 */

import { memo, useId, useMemo } from 'react';
import { AreaChart, Card, IconCheckCircle, IconClock, Select, StatGrid, StatTile } from '@studio-pulse/ui';

import { MEASUREMENTS, activityChartData } from '../../lib/analytics';
import type { ApplicationItem, PeriodPoint, ProjectInsightsRange, ReportBucket, TaskItem, TimeFigures } from '../../lib/analytics';
import type { Problem } from '../../lib/errors';
import { formatDuration } from '../../lib/format';
import { ProblemBanner } from '../../components/common';

import type { SourceState, TaskListItem } from './models';
import { CardBody } from './shared';
import { TaskList } from './TaskCards';
import { ApplicationsCard, TimeByTaskCard } from './TimeCards';

const DASH = '—';

export const INSIGHTS_RANGE_OPTIONS: ReadonlyArray<{ value: ProjectInsightsRange; label: string }> = [
  { value: 'all', label: 'All time' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'last30', label: 'Last 30 days' },
];

const BUCKET_NOUN: Readonly<Record<ReportBucket, string>> = { day: 'day', week: 'week', month: 'month' };

interface InsightsActivityProps {
  loading: boolean;
  stale: boolean;
  points: ReadonlyArray<PeriodPoint>;
  bucket: ReportBucket;
  today: string;
  rangeLabel: string;
}

const InsightsActivity = memo(function InsightsActivity({ loading, stale, points, bucket, today, rangeLabel }: InsightsActivityProps) {
  const data = useMemo(() => activityChartData(points, bucket, { today }), [points, bucket, today]);
  return (
    <Card title="Activity over time" description={`Active time per ${BUCKET_NOUN[bucket]}.`} headingLevel={3}>
      <CardBody
        loading={loading}
        loadingLabel="Loading activity"
        skeletonLines={5}
        empty={!points.some((point) => point.foregroundMs > 0)}
        emptyTitle="No time attributed yet"
        emptyText="Attribute tracked sessions to this project on the Time page."
        emptyIcon={<IconClock size={20} />}
      >
        <AreaChart data={data} stale={stale} aria-label={`Active time on this project per ${BUCKET_NOUN[bucket]}, ${rangeLabel.toLowerCase()}`} />
      </CardBody>
    </Card>
  );
});

export interface ProjectInsightsProps {
  range: ProjectInsightsRange;
  onRangeChange: (range: ProjectInsightsRange) => void;
  /** The report's `teammates_visible` (the prediction until it arrives): picks the label. */
  teammatesVisible: boolean;
  /** The time report: first load, refresh, failure. */
  loading: boolean;
  stale?: boolean;
  problem?: Problem | null;
  onRetry?: () => void;
  /** The report's totals for this project, or null while there is none. */
  totals: TimeFigures | null;
  /** `periodSeries(...)` and its bucket: month (all time), week (90 days), day (30 days). */
  points: ReadonlyArray<PeriodPoint>;
  bucket: ReportBucket;
  /** Today in the reporting zone. */
  today: string;
  /** `applicationItems(...)`. */
  applications: ReadonlyArray<ApplicationItem>;
  /** `taskItems(...)`: this project's time per task, with each task's own estimate. */
  taskTime: ReadonlyArray<TaskItem>;
  /** The project's task list (an independent source) and what is read from it. */
  tasks: SourceState;
  tasksDone: number;
  tasksTotal: number;
  awaitingReview: ReadonlyArray<TaskListItem>;
  overdue: ReadonlyArray<TaskListItem>;
  /** Whose time is included: the visibility footnote the "Tracked time" card showed. */
  footnote: string;
}

export function ProjectInsights({
  range,
  onRangeChange,
  teammatesVisible,
  loading,
  stale = false,
  problem = null,
  onRetry,
  totals,
  points,
  bucket,
  today,
  applications,
  taskTime,
  tasks,
  tasksDone,
  tasksTotal,
  awaitingReview,
  overdue,
  footnote,
}: ProjectInsightsProps) {
  const headingId = useId();
  const rangeLabel = INSIGHTS_RANGE_OPTIONS.find((option) => option.value === range)?.label ?? 'All time';
  const time = (ms: number | undefined) => (ms === undefined ? DASH : formatDuration(ms));
  // After a failed first load there is nothing to show under the banner but the task lists.
  const timeMissing = problem !== null && totals === null;

  return (
    <section className="web-insights" aria-labelledby={headingId}>
      <header className="web-insights__header">
        <div className="web-insights__titles">
          <h2 id={headingId} className="web-section__title">
            Insights
          </h2>
          <p className="web-muted">{teammatesVisible ? 'Time you can see on this project' : 'Your time on this project'}</p>
        </div>
        <Select aria-label="Insights range" selectSize="sm" value={range} onChange={onRangeChange} options={INSIGHTS_RANGE_OPTIONS} />
      </header>

      {problem ? <ProblemBanner problem={problem} {...(onRetry ? { onRetry } : {})} title="Couldn’t load the recorded time" /> : null}

      <StatGrid className="web-analytics-tiles">
        <StatTile label="Active" value={time(totals?.activeMs)} loading={loading} stale={stale} meta={MEASUREMENTS.activeTime} />
        <StatTile
          label="In foreground"
          value={time(totals?.foregroundMs)}
          loading={loading}
          stale={stale}
          meta={totals ? `Active + idle · ${formatDuration(totals.idleMs)} idle` : 'Active + idle'}
        />
        <StatTile
          label="Sessions"
          value={totals ? totals.sessions.toLocaleString('en-GB') : DASH}
          loading={loading}
          stale={stale}
          meta="Synced sessions attributed to this project"
        />
        <StatTile
          label="Tasks done"
          value={tasks.problem && tasksTotal === 0 ? DASH : `${tasksDone} of ${tasksTotal}`}
          loading={tasks.loading}
          meta="Current status"
        />
      </StatGrid>

      {timeMissing ? null : (
        <>
          <InsightsActivity loading={loading} stale={stale} points={points} bucket={bucket} today={today} rangeLabel={rangeLabel} />
          <div className="web-grid-2">
            <ApplicationsCard who={null} loading={loading} stale={stale} items={applications} headingLevel={3} />
            <TimeByTaskCard who={null} loading={loading} stale={stale} items={taskTime} hideProject headingLevel={3} />
          </div>
        </>
      )}

      <div className="web-grid-2">
        <Card title="Awaiting review" description="Tasks in review, current status." headingLevel={3}>
          <CardBody
            loading={tasks.loading}
            loadingLabel="Loading tasks"
            skeletonLines={3}
            problem={tasks.problem}
            onRetry={tasks.onRetry}
            problemTitle="Couldn’t load the tasks"
            empty={awaitingReview.length === 0}
            emptyTitle="No tasks awaiting review"
            emptyIcon={<IconCheckCircle size={20} />}
          >
            <TaskList items={awaitingReview} today={today} aria-label="Tasks awaiting review" />
          </CardBody>
        </Card>
        <Card title="Overdue" description="Open tasks with a due date before today." headingLevel={3}>
          <CardBody
            loading={tasks.loading}
            loadingLabel="Loading tasks"
            skeletonLines={3}
            problem={tasks.problem}
            onRetry={tasks.onRetry}
            problemTitle="Couldn’t load the tasks"
            empty={overdue.length === 0}
            emptyTitle="No overdue tasks"
            emptyIcon={<IconCheckCircle size={20} />}
          >
            <TaskList items={overdue} today={today} aria-label="Overdue tasks" />
          </CardBody>
        </Card>
      </div>

      <p className="web-footnote">
        {footnote} {MEASUREMENTS.notBillable} {MEASUREMENTS.manualTime}
      </p>
    </section>
  );
}
