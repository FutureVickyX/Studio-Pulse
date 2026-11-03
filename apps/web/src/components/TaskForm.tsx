/** Create a task: validated before it is sent, created once even if the request is retried. */

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Dialog, Field, TextInput } from '@studio-pulse/ui';

import * as api from '../lib/api';
import { validateDates, validateName } from '../lib/model';
import type { Project, TaskPriority, TaskStatus } from '../lib/model';
import { DateInput, MemberSelect, PrioritySelect, ProjectSelect, TaskStatusSelect, cacheTask, useAction, useDraftId } from './common';
import { useRefresh, useWorkspace } from '../app/workspace';

export function NewTaskDialog({
  open,
  onClose,
  projects,
  defaults,
}: {
  open: boolean;
  onClose: () => void;
  projects: readonly Project[];
  defaults?: { projectId?: string | null; assigneeId?: string | null };
}) {
  const { client, workspace, user, members, nav } = useWorkspace();
  const refresh = useRefresh();
  const action = useAction();
  const draftId = useDraftId();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState<string | null>(defaults?.projectId ?? null);
  const [assigneeId, setAssigneeId] = useState<string | null>(defaults?.assigneeId ?? user.id);
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const titleError = touched ? validateName(title, 'The title', 200) : null;
  const descriptionError = description.length > 10_000 ? 'The description can be at most 10,000 characters.' : null;
  const dateError = validateDates(null, dueDate);

  function reset() {
    setTitle('');
    setDescription('');
    setPriority('normal');
    setStatus('todo');
    setDueDate(null);
    setTouched(false);
  }

  async function submit(event: FormEvent, openAfter: boolean) {
    event.preventDefault();
    setTouched(true);
    if (validateName(title, 'Title', 200) || descriptionError || dateError) return;
    const task = await action.run(
      () =>
        api.createTask(
          client,
          {
            workspace_id: workspace.id,
            title: title.trim(),
            description,
            project_id: projectId,
            assignee_id: assigneeId,
            priority,
            status,
            due_date: dueDate,
          },
          user.id,
          draftId.id(),
        ),
      'Task created.',
      'Couldn’t create the task:',
    );
    if (!task) return;
    draftId.done();
    // In the list before the panel opens on it (not "Task not found" until the refetch lands).
    cacheTask(workspace.id, task);
    refresh('tasks');
    reset();
    onClose();
    if (openAfter) nav.openTask(task.id);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New task"
      size="md"
      dismissible={!action.pending}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button onClick={(e) => void submit(e, true)} disabled={action.pending}>
            Create and open
          </Button>
          <Button variant="primary" pending={action.pending} onClick={(e) => void submit(e, false)}>
            Create task
          </Button>
        </>
      }
    >
      <form className="web-form" onSubmit={(e) => void submit(e, false)} noValidate>
        <Field label="Title" htmlFor="task-title" error={titleError}>
          <TextInput id="task-title" value={title} autoFocus invalid={Boolean(titleError)} onChange={(e) => setTitle(e.currentTarget.value)} />
        </Field>
        <Field label="Description" htmlFor="task-description" error={descriptionError} hint="Optional. Plain text or Markdown.">
          <textarea id="task-description" className="sp-input web-textarea" rows={3} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        </Field>
        <div className="web-form__grid">
          <Field label="Project" htmlFor="task-project">
            <ProjectSelect id="task-project" projects={projects} value={projectId} onChange={setProjectId} />
          </Field>
          <Field label="Assignee" htmlFor="task-assignee">
            <MemberSelect id="task-assignee" members={members} value={assigneeId} onChange={setAssigneeId} />
          </Field>
          <Field label="Status" htmlFor="task-status">
            <TaskStatusSelect id="task-status" value={status} onChange={setStatus} />
          </Field>
          <Field label="Priority" htmlFor="task-priority">
            <PrioritySelect id="task-priority" value={priority} onChange={setPriority} />
          </Field>
          <Field label="Due date" htmlFor="task-due" error={dateError}>
            <DateInput id="task-due" value={dueDate} onChange={setDueDate} />
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
