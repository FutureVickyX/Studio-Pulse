/** My tasks and the workspace-wide task list, with filters and search. */

import { useState } from 'react';
import { Button, Card, EmptyState, IconPlus, IconTasks, SegmentedControl, Select } from '@studio-pulse/ui';

import { TASK_PRIORITIES, TASK_PRIORITY_LABEL, TASK_STATUSES, TASK_STATUS_LABEL, dueState, filterTasks, groupByStatus } from '../lib/model';
import type { TaskFilter, TaskPriority, TaskStatus } from '../lib/model';
import { todayKey } from '../lib/format';
import { LoadingRows, PageHeader, ProblemBanner, SearchField } from '../components/common';
import { NewTaskDialog } from '../components/TaskForm';
import { TaskRow } from '../components/TaskRow';
import { useProjects, useTasks, useWorkspace } from '../app/workspace';

type StatusChoice = 'open' | 'any' | TaskStatus;
const ANY = '*';
const NONE = 'none';
/** A filter that is narrowing the list shows the selected state. */
const FILTER_ACTIVE = 'web-filter--active';

export function TasksView({ view }: { view: 'mine' | 'all' }) {
  const { user, members, nav } = useWorkspace();
  const tasks = useTasks();
  const projects = useProjects();
  const [status, setStatus] = useState<StatusChoice>('open');
  const [projectId, setProjectId] = useState<string>(ANY);
  const [assignee, setAssignee] = useState<string>(ANY);
  const [priority, setPriority] = useState<string>(ANY);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const today = todayKey();

  const filter: TaskFilter = {
    status,
    assignee: view === 'mine' ? user.id : assignee === ANY ? null : assignee === NONE ? 'unassigned' : assignee,
    projectId: projectId === ANY ? null : projectId === NONE ? 'none' : projectId,
    priority: priority === ANY ? null : (priority as TaskPriority),
    search,
  };
  const all = tasks.data ?? [];
  const shown = filterTasks(all, filter);
  const groups = groupByStatus(shown);
  const overdue = shown.filter((t) => t.status !== 'done' && t.status !== 'archived' && dueState(t.due_date, today) === 'overdue').length;
  const dueSoon = shown.filter((t) => t.status !== 'done' && t.status !== 'archived' && ['today', 'soon'].includes(dueState(t.due_date, today))).length;
  const filtered = status !== 'open' || projectId !== ANY || assignee !== ANY || priority !== ANY || search.trim() !== '';

  return (
    <div className="web-page">
      <PageHeader
        title="Tasks"
        subtitle={
          tasks.data
            ? [`${shown.length} shown`, overdue ? `${overdue} overdue` : null, dueSoon ? `${dueSoon} due this week` : null].filter(Boolean).join(' · ')
            : undefined
        }
        actions={
          <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            New task
          </Button>
        }
      />
      <div className="web-toolbar">
        <SegmentedControl
          aria-label="Whose tasks"
          value={view}
          onChange={(next) => nav.navigate({ name: 'tasks', view: next })}
          options={[
            { value: 'mine', label: 'My tasks' },
            { value: 'all', label: 'All tasks' },
          ]}
        />
        <SearchField label="Search tasks by title" value={search} onChange={setSearch} />
      </div>
      <div className="web-filters" role="group" aria-label="Filters">
        <Select<StatusChoice>
          aria-label="Status"
          selectSize="sm"
          className={status !== 'open' ? FILTER_ACTIVE : undefined}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Open tasks' },
            { value: 'any', label: 'All but archived' },
            ...TASK_STATUSES.map((s) => ({ value: s, label: TASK_STATUS_LABEL[s] })),
          ]}
        />
        <Select
          aria-label="Project"
          selectSize="sm"
          className={projectId !== ANY ? FILTER_ACTIVE : undefined}
          value={projectId}
          onChange={setProjectId}
          options={[
            { value: ANY, label: 'Any project' },
            { value: NONE, label: 'No project' },
            ...(projects.data ?? []).filter((p) => p.status !== 'archived').map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        {view === 'all' ? (
          <Select
            aria-label="Assignee"
            selectSize="sm"
            className={assignee !== ANY ? FILTER_ACTIVE : undefined}
            value={assignee}
            onChange={setAssignee}
            options={[
              { value: ANY, label: 'Anyone' },
              { value: NONE, label: 'Unassigned' },
              ...members.map((m) => ({ value: m.userId, label: m.userId === user.id ? `${m.displayName} (you)` : m.displayName })),
            ]}
          />
        ) : null}
        <Select
          aria-label="Priority"
          selectSize="sm"
          className={priority !== ANY ? FILTER_ACTIVE : undefined}
          value={priority}
          onChange={setPriority}
          options={[{ value: ANY, label: 'Any priority' }, ...TASK_PRIORITIES.map((p) => ({ value: p, label: TASK_PRIORITY_LABEL[p] }))]}
        />
        {filtered ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setStatus('open');
              setProjectId(ANY);
              setAssignee(ANY);
              setPriority(ANY);
              setSearch('');
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {tasks.problem ? <ProblemBanner problem={tasks.problem} onRetry={() => void tasks.reload()} /> : null}

      {tasks.data === undefined ? (
        <Card flush>
          <LoadingRows rows={6} label="Loading tasks" />
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconTasks size={22} />}
            title={all.length === 0 ? 'No tasks yet' : view === 'mine' && !filtered ? 'Nothing assigned to you' : 'No tasks match'}
            action={
              <Button variant="primary" icon={<IconPlus size={14} />} onClick={() => setCreating(true)}>
                New task
              </Button>
            }
          >
            {filtered ? 'Try clearing the filters.' : 'Create a task, assign it to someone and track it to done.'}
          </EmptyState>
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.status} flush title={`${TASK_STATUS_LABEL[group.status]} · ${group.tasks.length}`} headingLevel={2}>
            <ul className="web-task-list">
              {group.tasks.map((task) => (
                <TaskRow key={task.id} task={task} projects={projects.data ?? []} today={today} />
              ))}
            </ul>
          </Card>
        ))
      )}
      {creating ? (
        <NewTaskDialog open onClose={() => setCreating(false)} projects={projects.data ?? []} defaults={{ assigneeId: view === 'mine' ? user.id : null }} />
      ) : null}
    </div>
  );
}
