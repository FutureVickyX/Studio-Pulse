/**
 * The Analytics cards built from the task list (the current state, not from recorded time): task
 * progress, upcoming deadlines and assigned projects. Counts only, no scores.
 */

import { Badge, Card, IconCalendar, IconProjects, IconTasks } from '@studio-pulse/ui';

import { MEASUREMENTS, PROGRESS_STATUSES } from '../../lib/analytics';
import type { AssignedProject, TaskProgressSummary } from '../../lib/analytics';
import { formatDuration } from '../../lib/format';
import { TASK_STATUS_LABEL } from '../../lib/model';
import { formatRoute } from '../../lib/router';
import { DueTag } from '../../components/common';

import type { SourceState, TaskListItem } from './models';
import { CardBody } from './shared';

// ---------------------------------------------------------------------------------------------
// Task progress
// ---------------------------------------------------------------------------------------------

export interface TaskProgressProps {
  /** `summarizeTaskProgress(...)`, or null while the tasks load. */
  summary: TaskProgressSummary | null;
}

/** The status breakdown with Overdue and Due in the next 7 days, and the definition line. */
export function TaskProgress({ summary }: TaskProgressProps) {
  if (!summary) return null;
  return (
    <>
      <dl className="web-analytics-status">
        {PROGRESS_STATUSES.map((status) => (
          <div key={status}>
            <dt>{TASK_STATUS_LABEL[status]}</dt>
            <dd>{summary.counts[status]}</dd>
          </div>
        ))}
      </dl>
      <dl className="web-analytics-status web-analytics-status--dates">
        <div>
          <dt>Overdue</dt>
          <dd>{summary.overdue}</dd>
        </div>
        <div>
          <dt>Due in the next 7 days</dt>
          <dd>{summary.dueSoon}</dd>
        </div>
      </dl>
      <p className="web-footnote">{MEASUREMENTS.taskProgress}</p>
    </>
  );
}

export interface TaskProgressCardProps extends SourceState {
  /** "My task progress", "Task progress", "Carol · Task progress". */
  title: string;
  summary: TaskProgressSummary | null;
  headingLevel?: 2 | 3;
}

export function TaskProgressCard({ title, summary, loading, problem, onRetry, headingLevel = 2 }: TaskProgressCardProps) {
  return (
    <Card title={title} headingLevel={headingLevel}>
      <CardBody
        loading={loading}
        loadingLabel="Loading task progress"
        problem={problem}
        onRetry={onRetry}
        problemTitle="Couldn’t load the tasks"
        empty={summary === null || summary.total === 0}
        emptyTitle="No tasks for this selection"
        emptyText="Tasks are counted by their current status, whatever the range."
        emptyIcon={<IconTasks size={20} />}
      >
        <TaskProgress summary={summary} />
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Task lists: upcoming deadlines (and, in Project Insights, awaiting review and overdue)
// ---------------------------------------------------------------------------------------------

export interface TaskListProps {
  items: ReadonlyArray<TaskListItem>;
  /** Today in the reporting zone: due dates are described against it. */
  today: string;
  'aria-label': string;
}

export function TaskList({ items, today, 'aria-label': ariaLabel }: TaskListProps) {
  return (
    <ul className="web-rows web-rows--compact" aria-label={ariaLabel}>
      {items.map((item) => (
        <li key={item.id} className="web-row web-row--static">
          <span className="web-row__main">
            <a className="web-row__title web-analytics-task-link" href={item.href}>
              {item.title}
            </a>
            {item.projectLabel ? <span className="web-row__sub">{item.projectLabel}</span> : null}
          </span>
          <span className="web-row__aside">
            <DueTag due={item.due} today={today} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface UpcomingDeadlinesCardProps extends SourceState {
  /** `taskListItems(upcomingDeadlines(...))`: open tasks overdue or due within 7 days, by due date. */
  items: ReadonlyArray<TaskListItem>;
  today: string;
  title?: string;
}

export function UpcomingDeadlinesCard({ items, today, loading, problem, onRetry, title = 'Upcoming deadlines' }: UpcomingDeadlinesCardProps) {
  return (
    <Card title={title} description="Your open tasks that are overdue or due in the next 7 days." headingLevel={2}>
      <CardBody
        loading={loading}
        loadingLabel="Loading deadlines"
        problem={problem}
        onRetry={onRetry}
        problemTitle="Couldn’t load the tasks"
        empty={items.length === 0}
        emptyTitle="Nothing due in the next 7 days"
        emptyText="Open tasks assigned to you show here when they have a due date coming up."
        emptyIcon={<IconCalendar size={20} />}
      >
        <TaskList items={items} today={today} aria-label={title} />
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Assigned projects
// ---------------------------------------------------------------------------------------------

export interface AssignedProjectsCardProps extends SourceState {
  /** `assignedProjects(...)`: projects the viewer leads or has open tasks in, by name. */
  items: ReadonlyArray<AssignedProject>;
  /** The viewer's time in the range is still loading: show the rows without it. */
  timeLoading?: boolean;
  /** The page's application filter, by name: the time shown is in that application only. */
  applicationName?: string | null;
  /** The page filters on one project (`items` holds at most that one): the empty state says so. */
  projectFiltered?: boolean;
}

export function AssignedProjectsCard({
  items,
  loading,
  problem,
  onRetry,
  timeLoading = false,
  applicationName = null,
  projectFiltered = false,
}: AssignedProjectsCardProps) {
  const inApplication = applicationName === null ? '' : ` in ${applicationName}`;
  return (
    <Card
      title="Assigned projects"
      description={`Projects you lead or have open tasks in, with your active time${inApplication} in this range.`}
      headingLevel={2}
    >
      <CardBody
        loading={loading}
        loadingLabel="Loading projects"
        problem={problem}
        onRetry={onRetry}
        problemTitle="Couldn’t load the projects"
        empty={items.length === 0}
        emptyTitle={projectFiltered ? 'Not one of your assigned projects' : 'No assigned projects'}
        emptyText={
          projectFiltered
            ? 'You don’t lead the selected project or have an open task in it. Choose All projects to see yours.'
            : 'Projects appear here when you lead them or have an open task in them.'
        }
        emptyIcon={<IconProjects size={20} />}
      >
        <ul className="web-rows web-rows--compact" aria-label="Assigned projects">
          {items.map((item) => (
            <li key={item.projectId} className="web-row web-row--static">
              <span className="web-row__main">
                <span className="web-analytics-project">
                  <a className="web-row__title web-analytics-task-link" href={formatRoute({ name: 'project', id: item.projectId })}>
                    {item.label}
                  </a>
                  {item.lead ? <Badge tone="subtle">Lead</Badge> : null}
                </span>
                <span className="web-row__sub">
                  {item.openTasks === 1 ? '1 open task' : `${item.openTasks} open tasks`}
                </span>
              </span>
              <span className="web-row__aside web-analytics-num">
                {item.activeMs === null || timeLoading ? null : `${formatDuration(item.activeMs)} active${inApplication}`}
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
