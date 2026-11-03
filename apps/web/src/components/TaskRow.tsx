/** One task in a list: status (changeable inline when allowed), title, project, assignee, due. */

import { cx } from '@studio-pulse/ui';

import * as api from '../lib/api';
import { canEditTask, isFormerMember, isOpenTask } from '../lib/model';
import type { Project, Task, TaskStatus } from '../lib/model';
import { notifyProblem, notifySuccess } from './notices';
import { Avatar, DueTag, PriorityTag, TaskStatusBadge, TaskStatusSelect, cacheTask, useAction } from './common';
import { useRefresh, useWorkspace } from '../app/workspace';

export function TaskRow({
  task,
  projects,
  today,
  showProject = true,
}: {
  task: Task;
  projects?: readonly Project[];
  today: string;
  showProject?: boolean;
}) {
  const { client, workspace, user, members, memberName, nav } = useWorkspace();
  const refresh = useRefresh();
  const action = useAction();
  const editable = canEditTask(task, workspace.role, user.id);
  const project = task.project_id ? projects?.find((p) => p.id === task.project_id) : undefined;
  const assignee = task.assignee_id ? memberName(task.assignee_id) : null;

  async function changeStatus(status: TaskStatus) {
    if (status === task.status) return;
    // Sent on the version this row shows, so a teammate's newer one (refetched, or cached after a
    // conflict) is on screen before it can be saved over. While the last change is saving, run()
    // ignores this one and the select shows the saved status.
    const result = await action.run(() => api.updateTask(client, task.id, task.version, { status }));
    if (!result) return;
    cacheTask(workspace.id, result.status === 'saved' ? result.row : result.current);
    if (result.status === 'conflict') {
      notifyProblem({ kind: 'conflict', message: 'Someone changed this task a moment ago. The list now shows their version; try again.' });
    } else {
      notifySuccess(status === 'done' ? 'Task done.' : 'Status updated.');
    }
    refresh('tasks');
  }

  return (
    <li className={cx('web-task', !isOpenTask(task) && 'web-task--finished')}>
      <div className="web-task__status">
        {editable ? (
          <TaskStatusSelect size="sm" value={task.status} label={`Status of ${task.title}`} busy={action.pending} onChange={(s) => void changeStatus(s)} />
        ) : (
          <TaskStatusBadge status={task.status} />
        )}
      </div>
      <button type="button" className="web-task__title" onClick={() => nav.openTask(task.id)}>
        {task.title}
      </button>
      <div className="web-task__meta">
        <PriorityTag priority={task.priority} />
        {showProject && project ? <span className="web-task__project">{project.name}</span> : null}
        <DueTag due={task.due_date} today={today} finished={!isOpenTask(task)} />
        {assignee === null ? (
          <span className="web-task__unassigned" title="Unassigned">
            <span aria-hidden="true">—</span>
            <span className="sp-visually-hidden">Unassigned</span>
          </span>
        ) : isFormerMember(task.assignee_id, members) ? (
          <span className="web-muted" title="They’ve left this workspace. Open the task to pick a new assignee.">
            <span className="sp-visually-hidden">Assigned to </span>Former member
          </span>
        ) : (
          <>
            <Avatar name={assignee} title={`Assigned to ${assignee}`} />
            <span className="sp-visually-hidden">Assigned to {assignee}</span>
          </>
        )}
      </div>
    </li>
  );
}
