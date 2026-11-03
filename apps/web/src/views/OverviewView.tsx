/** The workspace home: what needs me, what is due, what changed. Real rows only. */

import { useState } from 'react';
import { Button, Card, EmptyState, IconNotes, IconPlus, IconProjects, IconTasks, Tooltip } from '@studio-pulse/ui';

import { canManageProjects, dueState, filterTasks, isOpenTask, noteTitle, notePreview, sortTasks, taskProgress } from '../lib/model';
import type { Project, Task } from '../lib/model';
import { formatDay, formatRelative, todayKey } from '../lib/format';
import { LoadingRows, PageHeader, ProblemBanner, ProjectStatusBadge } from '../components/common';
import { ProjectDialog } from '../components/ProjectForm';
import { NewTaskDialog } from '../components/TaskForm';
import { TaskRow } from '../components/TaskRow';
import { useNotes, useProjects, useTasks, useWorkspace } from '../app/workspace';

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function OverviewView() {
  const { user, workspace, nav } = useWorkspace();
  const tasks = useTasks();
  const projects = useProjects();
  const notes = useNotes();
  const [newTask, setNewTask] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const today = todayKey();
  const manage = canManageProjects(workspace.role);

  const allTasks = tasks.data ?? [];
  const allProjects = projects.data ?? [];
  const mine = sortTasks(filterTasks(allTasks, { status: 'open', assignee: user.id, projectId: null, priority: null, search: '' }));
  const counts = {
    open: mine.length,
    inProgress: mine.filter((t) => t.status === 'in_progress').length,
    inReview: mine.filter((t) => t.status === 'in_review').length,
    overdue: mine.filter((t) => dueState(t.due_date, today) === 'overdue').length,
  };
  const upcoming = sortTasks(
    allTasks.filter((t) => isOpenTask(t) && t.due_date !== null && ['overdue', 'today', 'soon'].includes(dueState(t.due_date, today, 14))),
  ).slice(0, 8);
  const recentProjects = [...allProjects].filter((p) => p.status !== 'archived').sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);
  const recentNotes = [...(notes.data ?? [])].filter((n) => n.archived_at === null).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);

  const loading = tasks.data === undefined || projects.data === undefined;
  const empty = !loading && allTasks.length === 0 && allProjects.length === 0 && (notes.data?.length ?? 0) === 0;
  const firstName = user.displayName.split(/\s+/)[0] ?? user.displayName;

  const newProjectButton = (
    <Button icon={<IconPlus size={14} />} disabled={!manage} onClick={() => setNewProject(true)}>
      New project
    </Button>
  );

  return (
    <div className="web-page">
      <PageHeader
        title={`${greeting(new Date())}, ${firstName}`}
        subtitle={`${workspace.name} · ${formatDay(today)}`}
        actions={
          <>
            {manage ? newProjectButton : <Tooltip content="Owners and admins create projects">{newProjectButton}</Tooltip>}
            <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setNewTask(true)}>
              New task
            </Button>
          </>
        }
      />

      {tasks.problem ? <ProblemBanner problem={tasks.problem} onRetry={() => void tasks.reload()} /> : null}
      {projects.problem ? <ProblemBanner problem={projects.problem} onRetry={() => void projects.reload()} /> : null}

      {empty ? (
        <Card>
          <EmptyState
            icon={<IconProjects size={22} />}
            title="Your workspace is ready"
            action={
              <div className="web-actions">
                {manage ? (
                  <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setNewProject(true)}>
                    Create the first project
                  </Button>
                ) : null}
                <Button icon={<IconPlus size={14} />} onClick={() => setNewTask(true)}>
                  Add a task
                </Button>
              </div>
            }
          >
            Start with a project for a client or a piece of work, then add tasks and notes to it. Everything you add here is shared with your
            team; personal notes stay private.
          </EmptyState>
        </Card>
      ) : (
        <>
          <section className="web-summary" aria-label="Your work in progress">
            <SummaryTile label="Assigned to you" value={counts.open} onClick={() => nav.navigate({ name: 'tasks', view: 'mine' })} />
            <SummaryTile label="In progress" value={counts.inProgress} />
            <SummaryTile label="In review" value={counts.inReview} />
            <SummaryTile label="Overdue" value={counts.overdue} tone={counts.overdue > 0 ? 'danger' : 'neutral'} />
          </section>

          <div className="web-grid-2">
            <Card
              title="Needs your attention"
              description="Your open tasks, most urgent first."
              actions={
                <Button size="sm" variant="ghost" onClick={() => nav.navigate({ name: 'tasks', view: 'mine' })}>
                  All my tasks
                </Button>
              }
            >
              {loading ? (
                <LoadingRows rows={3} />
              ) : mine.length === 0 ? (
                <EmptyState compact icon={<IconTasks size={18} />} title="Nothing assigned to you">
                  Tasks assigned to you appear here.
                </EmptyState>
              ) : (
                <ul className="web-task-list">
                  {mine.slice(0, 8).map((task) => (
                    <TaskRow key={task.id} task={task} projects={allProjects} today={today} />
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Upcoming due dates" description="Open tasks across the team, overdue or due in the next 14 days.">
              {loading ? (
                <LoadingRows rows={3} />
              ) : upcoming.length === 0 ? (
                <EmptyState compact title="Nothing due soon" />
              ) : (
                <ul className="web-task-list">
                  {upcoming.map((task) => (
                    <TaskRow key={task.id} task={task} projects={allProjects} today={today} />
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Recently updated projects"
              actions={
                <Button size="sm" variant="ghost" onClick={() => nav.navigate({ name: 'projects' })}>
                  All projects
                </Button>
              }
            >
              {projects.data === undefined ? (
                <LoadingRows rows={3} />
              ) : recentProjects.length === 0 ? (
                <EmptyState compact icon={<IconProjects size={18} />} title="No projects yet" />
              ) : (
                <ul className="web-rows">
                  {recentProjects.map((project) => (
                    <ProjectLine key={project.id} project={project} tasks={allTasks} />
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Recent notes"
              actions={
                <Button size="sm" variant="ghost" onClick={() => nav.navigate({ name: 'notes', id: null })}>
                  All notes
                </Button>
              }
            >
              {notes.data === undefined ? (
                notes.problem ? (
                  <ProblemBanner problem={notes.problem} onRetry={() => void notes.reload()} />
                ) : (
                  <LoadingRows rows={3} />
                )
              ) : recentNotes.length === 0 ? (
                <EmptyState compact icon={<IconNotes size={18} />} title="No notes yet" />
              ) : (
                <ul className="web-rows">
                  {recentNotes.map((note) => (
                    <li key={note.id}>
                      <button type="button" className="web-row" onClick={() => nav.navigate({ name: 'notes', id: note.id })}>
                        <span className="web-row__main">
                          <span className="web-row__title">{noteTitle(note)}</span>
                          <span className="web-row__sub">{notePreview(note.body, 90) || 'Empty note'}</span>
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
        </>
      )}

      {newTask ? <NewTaskDialog open onClose={() => setNewTask(false)} projects={allProjects} /> : null}
      {newProject ? (
        <ProjectDialog open onClose={() => setNewProject(false)} onSaved={(p) => nav.navigate({ name: 'project', id: p.id })} />
      ) : null}
    </div>
  );
}

function SummaryTile({ label, value, tone = 'neutral', onClick }: { label: string; value: number; tone?: 'neutral' | 'danger'; onClick?: () => void }) {
  const body = (
    <>
      <span className={`web-tile__value${tone === 'danger' ? ' web-tile__value--danger' : ''}`}>{value}</span>
      <span className="web-tile__label">{label}</span>
    </>
  );
  return onClick ? (
    <button type="button" className="web-tile web-tile--link" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="web-tile">{body}</div>
  );
}

function ProjectLine({ project, tasks }: { project: Project; tasks: readonly Task[] }) {
  const { nav, memberName } = useWorkspace();
  const progress = taskProgress(tasks.filter((t) => t.project_id === project.id));
  return (
    <li>
      <button type="button" className="web-row" onClick={() => nav.navigate({ name: 'project', id: project.id })}>
        <span className="web-row__main">
          <span className="web-row__title">{project.name}</span>
          <span className="web-row__sub">
            {project.lead_id ? `Lead: ${memberName(project.lead_id)} · ` : ''}
            {progress.total > 0 ? `${progress.done}/${progress.total} tasks done` : 'No tasks yet'}
          </span>
        </span>
        <span className="web-row__aside">
          <ProjectStatusBadge status={project.status} />
        </span>
      </button>
    </li>
  );
}
