/** One project: details, its tasks, its notes and the tracked time attributed to it. */

import { useState } from 'react';
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
import { canEditProject, canManageProjects, filterNotes, filterTasks, noteTitle, sortTasks, taskProgress } from '../lib/model';
import type { Project } from '../lib/model';
import { totals, totalsBy } from '../lib/time';
import { formatDay, formatDuration, formatRelative, todayKey } from '../lib/format';
import { ConfirmDialog, LoadingRows, PageHeader, ProblemBanner, ProjectStatusBadge, useAction, useDraftId } from '../components/common';
import { notifyProblem, notifySuccess } from '../components/notices';
import { ProjectDialog } from '../components/ProjectForm';
import { NewTaskDialog } from '../components/TaskForm';
import { TaskRow } from '../components/TaskRow';
import { cacheCreatedNote, useAttributedTime, useNotes, useProjects, useRefresh, useTasks, useWorkspace } from '../app/workspace';

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
  const entries = time.data ?? [];
  const timeTotals = totals(entries);
  const byTask = totalsBy(entries, (e) => e.task_id);
  const people = new Set(entries.map((e) => e.user_id));
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

        <div className="web-stack">
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

          <Card title="Tracked time" description="Automatically measured time people attributed to this project.">
            {time.problem ? <ProblemBanner problem={time.problem} onRetry={() => void time.reload()} /> : null}
            {time.data === undefined ? (
              <LoadingRows rows={2} />
            ) : entries.length === 0 ? (
              <EmptyState compact title="No time attributed yet">
                Attribute tracked sessions to this project on the Time page.
              </EmptyState>
            ) : (
              <>
                <dl className="web-stats">
                  <div>
                    <dt>Active</dt>
                    <dd>{formatDuration(timeTotals.activeMs)}</dd>
                  </div>
                  <div>
                    <dt>In foreground</dt>
                    <dd>{formatDuration(timeTotals.foregroundMs)}</dd>
                  </div>
                  <div>
                    <dt>Sessions</dt>
                    <dd>{timeTotals.entries}</dd>
                  </div>
                </dl>
                <ul className="web-rows web-rows--compact">
                  {[...byTask.entries()]
                    .sort((a, b) => b[1].activeMs - a[1].activeMs)
                    .map(([taskId, t]) => (
                      <li key={taskId ?? 'none'} className="web-row web-row--static">
                        <span className="web-row__main">
                          <span className="web-row__title">
                            {taskId ? (projectTasks.find((x) => x.id === taskId)?.title ?? 'A task in another project') : 'No task'}
                          </span>
                        </span>
                        <span className="web-row__aside">{formatDuration(t.activeMs)} active</span>
                      </li>
                    ))}
                </ul>
                <p className="web-footnote">
                  {people.size > 1 || workspace.timeEntryVisibility === 'admins'
                    ? 'Includes the time of everyone whose entries you can see.'
                    : 'Shows your own time. Teammates’ time stays private unless the workspace owner shares it with admins.'}{' '}
                  Active time excludes idle periods; neither is billable time.
                </p>
              </>
            )}
          </Card>
        </div>
      </div>

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
