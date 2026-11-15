/** One project: details, its tasks, its notes and Insights (the recorded time attributed to it). */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StudioPulseClient } from '@studio-pulse/database';
import { addDays } from '@studio-pulse/time-engine';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  IconChevronLeft,
  IconNotes,
  IconPencil,
  IconPlus,
  IconTasks,
  IconTrash,
  SegmentedControl,
  Tooltip,
} from '@studio-pulse/ui';

import * as api from '../lib/api';
import type { AnalyticsSummaryParams } from '../lib/api';
import {
  analyticsSummaryKey,
  applicationColors,
  applicationItems,
  browserStorage,
  createReportLabels,
  overlapClause,
  periodSeries,
  predictTeammatesVisible,
  readPreferences,
  reportTotals,
  reportingToday,
  selectTasks,
  splitReport,
  taskItems,
  upcomingDeadlines,
  writePreferences,
} from '../lib/analytics';
import type { ProjectInsightsRange, ReportBucket, ReportRow, TaskSelection } from '../lib/analytics';
import { ProblemError, isTimeZoneProblem, toReportProblem } from '../lib/errors';
import { canEditProject, canManageProjects, filterNotes, filterTasks, noteTitle, sortTasks, taskProgress } from '../lib/model';
import type { Project, Task } from '../lib/model';
import type { Route } from '../lib/router';
import { useQuery } from '../lib/store';
import { TIME_ZONE, formatDay, formatRelative, todayKey } from '../lib/format';
import { ConfirmDialog, LoadingRows, PageHeader, ProblemBanner, ProjectStatusBadge, useAction, useDraftId } from '../components/common';
import { notifyProblem, notifySuccess } from '../components/notices';
import { ProjectDialog } from '../components/ProjectForm';
import { NewTaskDialog } from '../components/TaskForm';
import { TaskRow } from '../components/TaskRow';
import { cacheCreatedNote, useAttributedTime, useNotes, useProjects, useRefresh, useTasks, useWorkspace } from '../app/workspace';

import { ProjectInsights, taskListItems } from './analytics';

export function ProjectDetailView({ projectId }: { projectId: string }) {
  const { nav } = useWorkspace();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === projectId);

  if (projects.data === undefined) {
    return (
      <div className="web-page">
        {projects.problem ? <ProblemBanner problem={projects.problem} onRetry={() => void projects.reload()} /> : <LoadingRows rows={6} />}
      </div>
    );
  }
  if (!project) {
    return (
      <div className="web-page">
        <Card>
          <EmptyState
            title="Project not found"
            action={
              <Button onClick={() => nav.navigate({ name: 'projects' })} icon={<IconChevronLeft size={14} />}>
                All projects
              </Button>
            }
          >
            It was deleted, or it belongs to a workspace you’re not a member of.
          </EmptyState>
        </Card>
      </div>
    );
  }
  return <ProjectDetail project={project} />;
}

function ProjectDetail({ project }: { project: Project }) {
  const { client, workspace, user, memberName, nav } = useWorkspace();
  const refresh = useRefresh();
  const tasks = useTasks();
  const notes = useNotes();
  const time = useAttributedTime({ projectId: project.id });
  const projects = useProjects();
  const action = useAction();
  const noteDraftId = useDraftId();
  const [editing, setEditing] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null);
  const [taskScope, setTaskScope] = useState<'open' | 'any'>('open');
  const today = todayKey();

  const editable = canEditProject(project, workspace.role, user.id);
  const projectTasks = (tasks.data ?? []).filter((t) => t.project_id === project.id);
  const shownTasks = sortTasks(filterTasks(projectTasks, { status: taskScope, assignee: null, projectId: project.id, priority: null, search: '' }));
  const progress = taskProgress(projectTasks);
  const projectNotes = filterNotes(notes.data ?? [], { scope: 'all', projectId: project.id, search: '', archived: false }, user.id);
  // The raw time rows feed only the Delete guard below (do any exist?); Insights shows the report.
  const entries = time.data ?? [];
  const hasWork = projectTasks.length > 0 || (notes.data ?? []).some((n) => n.project_id === project.id) || entries.length > 0;
  const archived = project.status === 'archived';

  async function setArchived(next: boolean): Promise<boolean> {
    // No success message for run(): a version-checked update resolves with a conflict too.
    const result = await action.run(() =>
      api.updateProject(client, project.id, project.version, { status: next ? 'archived' : 'active' }),
    );
    refresh('projects');
    if (result?.status === 'conflict') {
      notifyProblem({ kind: 'conflict', message: 'Someone changed this project meanwhile. Review it and try again.' });
      return false;
    }
    if (result?.status !== 'saved') return false;
    notifySuccess(next ? 'Project archived. Its tasks, notes and time are kept.' : 'Project restored.');
    return true;
  }

  async function remove(): Promise<boolean> {
    const done = await action.run(() => api.deleteProject(client, project.id), 'Project deleted.', 'Couldn’t delete:');
    if (done === undefined) return false;
    refresh('projects');
    nav.navigate({ name: 'projects' });
    return true;
  }

  async function newNote() {
    const note = await action.run(
      () =>
        api.createNote(
          client,
          { workspace_id: workspace.id, title: '', body: '', visibility: 'workspace', project_id: project.id },
          user.id,
          noteDraftId.id(),
        ),
      undefined,
      'Couldn’t create the note:',
    );
    if (!note) return;
    noteDraftId.done();
    cacheCreatedNote(workspace.id, note);
    refresh('notes');
    nav.navigate({ name: 'notes', id: note.id });
  }

  return (
    <div className="web-page">
      <button type="button" className="web-back" onClick={() => nav.navigate({ name: 'projects' })}>
        <IconChevronLeft size={14} /> Projects
      </button>
      <PageHeader
        titleCase="content"
        title={
          <span className="web-title-with-badge">
            {project.name}
            <ProjectStatusBadge status={project.status} />
          </span>
        }
        subtitle={[
          project.lead_id ? `Lead: ${memberName(project.lead_id)}` : 'No lead',
          project.start_date ? `Starts ${formatDay(project.start_date)}` : null,
          project.due_date ? `Due ${formatDay(project.due_date)}` : null,
          `Updated ${formatRelative(project.updated_at)}`,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          editable ? (
            <>
              <Button icon={<IconPencil size={14} />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              {archived ? (
                <Button onClick={() => void setArchived(false)} pending={action.pending}>
                  Restore
                </Button>
              ) : (
                <Button onClick={() => setConfirm('archive')}>Archive</Button>
              )}
              {canManageProjects(workspace.role) ? (
                hasWork ? (
                  <Tooltip content="Projects with tasks, notes or time can only be archived">
                    <Button variant="ghost" icon={<IconTrash size={14} />} disabled>
                      Delete
                    </Button>
                  </Tooltip>
                ) : (
                  <Button variant="ghost" icon={<IconTrash size={14} />} onClick={() => setConfirm('delete')}>
                    Delete
                  </Button>
                )
              ) : null}
            </>
          ) : undefined
        }
      />

      {archived ? (
        <Banner tone="neutral" title="Archived">
          This project is archived. Its tasks, notes and tracked time are kept, but it takes no new time.
        </Banner>
      ) : null}
      {project.description ? <p className="web-description">{project.description}</p> : null}

      <div className="web-grid-2">
        <Card
          title="Tasks"
          description={progress.total > 0 ? `${progress.done} of ${progress.total} done` : undefined}
          actions={
            <>
              <SegmentedControl
                aria-label="Which tasks"
                value={taskScope}
                onChange={setTaskScope}
                options={[
                  { value: 'open', label: 'Open' },
                  { value: 'any', label: 'All' },
                ]}
              />
              {!archived ? (
                <Button size="sm" icon={<IconPlus size={14} />} onClick={() => setNewTask(true)}>
                  Add
                </Button>
              ) : null}
            </>
          }
        >
          {progress.total > 0 ? (
            <div className="web-progress web-progress--wide" role="progressbar" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
              <span className="web-progress__bar" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
            </div>
          ) : null}
          {tasks.data === undefined ? (
            <LoadingRows rows={3} />
          ) : shownTasks.length === 0 ? (
            <EmptyState compact icon={<IconTasks size={18} />} title={projectTasks.length === 0 ? 'No tasks in this project yet' : 'No open tasks'} />
          ) : (
            <ul className="web-task-list">
              {shownTasks.map((task) => (
                <TaskRow key={task.id} task={task} today={today} showProject={false} />
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Notes"
          actions={
            <Button size="sm" icon={<IconPlus size={14} />} onClick={() => void newNote()} disabled={action.pending}>
              New note
            </Button>
          }
        >
          {notes.data === undefined ? (
            <LoadingRows rows={2} />
          ) : projectNotes.length === 0 ? (
            <EmptyState compact icon={<IconNotes size={18} />} title="No notes for this project" />
          ) : (
            <ul className="web-rows">
              {projectNotes.map((note) => (
                <li key={note.id}>
                  <button type="button" className="web-row" onClick={() => nav.navigate({ name: 'notes', id: note.id })}>
                    <span className="web-row__main">
                      <span className="web-row__title">{noteTitle(note)}</span>
                    </span>
                    <span className="web-row__aside">
                      {note.visibility === 'private' ? 'Private' : 'Shared'} · {formatRelative(note.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <ProjectInsightsSection project={project} />

      {editing ? <ProjectDialog open onClose={() => setEditing(false)} project={project} /> : null}
      {newTask ? (
        <NewTaskDialog open onClose={() => setNewTask(false)} projects={projects.data ?? []} defaults={{ projectId: project.id }} />
      ) : null}
      <ConfirmDialog
        open={confirm === 'archive'}
        title={`Archive “${project.name}”?`}
        confirmLabel="Archive"
        onClose={() => setConfirm(null)}
        onConfirm={() => setArchived(true)}
      >
        <p className="web-dialog-text">Its tasks, notes and tracked time are kept and stay visible. You can restore it at any time.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'delete'}
        title={`Delete “${project.name}”?`}
        confirmLabel="Delete project"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={remove}
      >
        <p className="web-dialog-text">The project has no tasks, notes or time, so nothing else is affected. This can’t be undone.</p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Insights: the recorded time attributed to this project, and where its tasks stand
// ---------------------------------------------------------------------------------------------

/** All time by month, the last 90 days by ISO week, the last 30 days by day (today included). */
function insightsWindow(range: ProjectInsightsRange, today: string): { fromDay: string | null; bucket: ReportBucket } {
  switch (range) {
    case 'all':
      return { fromDay: null, bucket: 'month' };
    case 'last90':
      return { fromDay: addDays(today, -89), bucket: 'week' };
    case 'last30':
      return { fromDay: addDays(today, -29), bucket: 'day' };
  }
}

/** The report, with anything thrown on the way (not only the function's own errors) explained. */
async function loadReport(client: StudioPulseClient, params: AnalyticsSummaryParams): Promise<ReportRow[]> {
  try {
    return await api.analyticsSummary(client, params);
  } catch (error) {
    throw error instanceof ProblemError ? error : new ProblemError(toReportProblem(error));
  }
}

/** Earliest due date first, tasks without one last, then by title. */
function byDueThenTitle(a: Pick<Task, 'due_date' | 'title'>, b: Pick<Task, 'due_date' | 'title'>): number {
  if (a.due_date !== b.due_date) {
    if (a.due_date === null) return 1;
    if (b.due_date === null) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  }
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
}

/**
 * The data behind `ProjectInsights`: `analytics_time_summary` for this project (everyone whose
 * time the viewer's row-level security lets them read) and the cached task list. The range is
 * remembered with the Analytics preferences in this browser; days follow the reporting zone
 * saved there, or the browser's.
 */
function ProjectInsightsSection({ project }: { project: Project }) {
  const { client, workspace, user, members } = useWorkspace();
  const tasks = useTasks();
  const projects = useProjects();

  const [saved] = useState(() => readPreferences(browserStorage(), user.id, workspace.id));
  const [range, setRange] = useState<ProjectInsightsRange>(saved.projectInsightsRange);
  const changeRange = useCallback(
    (next: ProjectInsightsRange) => {
      setRange(next);
      // Read again before writing: the Analytics page may have saved other fields since this page opened.
      const storage = browserStorage();
      writePreferences(storage, user.id, workspace.id, { ...readPreferences(storage, user.id, workspace.id), projectInsightsRange: next });
    },
    [user.id, workspace.id],
  );

  // A zone this database does not know ("unknown time zone"): count days in UTC on this page.
  const preferredZone = saved.timeZone ?? TIME_ZONE;
  const [refusedZone, setRefusedZone] = useState<string | null>(null);
  const timeZone = refusedZone === preferredZone ? 'UTC' : preferredZone;

  const today = reportingToday(Date.now(), timeZone);
  const { fromDay, bucket } = insightsWindow(range, today);
  const params = useMemo<AnalyticsSummaryParams>(
    () => ({ workspaceId: workspace.id, fromDay, toDay: today, timeZone, bucket, projectId: project.id }),
    [workspace.id, fromDay, today, timeZone, bucket, project.id],
  );
  const report = useQuery(analyticsSummaryKey(params), () => loadReport(client, params));

  const zoneRefused = report.problem !== null && timeZone !== 'UTC' && isTimeZoneProblem(report.problem);
  useEffect(() => {
    if (zoneRefused) setRefusedZone(timeZone);
  }, [zoneRefused, timeZone]);
  const problem = zoneRefused ? null : report.problem;

  const parts = useMemo(() => (report.data ? splitReport(report.data) : null), [report.data]);
  const totals = useMemo(() => (parts ? reportTotals(parts.total) : null), [parts]);
  const points = useMemo(
    () => (parts ? periodSeries(parts.periods, { fromDay, toDay: today, bucket }) : []),
    [parts, fromDay, today, bucket],
  );
  const applications = useMemo(() => (parts ? applicationItems(parts.applications, applicationColors(parts.applications)) : []), [parts]);
  const labels = useMemo(
    () => createReportLabels({ projects: projects.data ?? [], tasks: tasks.data ?? [], members }),
    [projects.data, tasks.data, members],
  );
  const taskTime = useMemo(() => (parts ? taskItems(parts.tasks, labels) : []), [parts, labels]);

  // Tasks: current status from the cached list, archived ones left out; overdue against the reporting zone's today.
  const selection = useMemo<TaskSelection>(() => ({ projectFilter: { kind: 'project', id: project.id }, assigneeId: null }), [project.id]);
  const route = useMemo<Route>(() => ({ name: 'project', id: project.id }), [project.id]);
  const projectTasks = useMemo(() => selectTasks(tasks.data ?? [], selection), [tasks.data, selection]);
  const progress = useMemo(() => taskProgress(projectTasks), [projectTasks]);
  const awaitingReview = useMemo(
    () => taskListItems(projectTasks.filter((task) => task.status === 'in_review').sort(byDueThenTitle), null, route),
    [projectTasks, route],
  );
  const overdue = useMemo(
    () =>
      taskListItems(
        upcomingDeadlines(tasks.data ?? [], { ...selection, today }).filter((task) => task.due_date !== null && task.due_date < today),
        null,
        route,
      ),
    [tasks.data, selection, today, route],
  );

  // Until the task list arrives the report's task rows have no titles: keep the skeleton rather than show "Unknown task".
  const titlesPending = tasks.data === undefined && tasks.problem === null;
  const loading = report.data === undefined ? report.loading || problem === null : titlesPending;
  const teammatesVisible = totals?.teammatesVisible ?? predictTeammatesVisible(workspace);

  const footnote = [
    teammatesVisible
      ? 'Includes the time of everyone whose entries you can see.'
      : workspace.timeEntryVisibility === 'admins'
        ? 'Shows your own time. Owners and admins can see members’ time in this workspace, including yours.'
        : 'Shows your own time. Teammates’ time stays private unless the workspace owner shares it with admins.',
    'Active time excludes idle periods.',
    totals ? `Overlapping time from several devices is counted once${overlapClause(totals.overlapMs)}.` : null,
    timeZone !== preferredZone
      ? `Days are counted in UTC: this database doesn’t know the time zone ${preferredZone}.`
      : timeZone !== TIME_ZONE
        ? `Days follow the reporting time zone saved in Analytics (${timeZone}).`
        : null,
  ]
    .filter((sentence): sentence is string => sentence !== null)
    .join(' ');

  return (
    <ProjectInsights
      range={range}
      onRangeChange={changeRange}
      teammatesVisible={teammatesVisible}
      loading={loading}
      stale={report.data !== undefined && report.loading}
      problem={problem}
      onRetry={() => void report.reload()}
      totals={totals}
      points={points}
      bucket={bucket}
      today={today}
      applications={applications}
      taskTime={taskTime}
      tasks={{ loading: titlesPending, problem: tasks.problem, onRetry: () => void tasks.reload() }}
      tasksDone={progress.done}
      tasksTotal={progress.total}
      awaitingReview={awaitingReview}
      overdue={overdue}
      footnote={footnote}
    />
  );
}
