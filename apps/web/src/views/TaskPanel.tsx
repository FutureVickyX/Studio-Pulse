/**
 * A task in full: fields, checklist, comments and tracked time. Every field edit is saved on top
 * of the version shown; if someone else saved first, nothing is overwritten: the panel shows
 * their version and says so. Text being typed is never replaced by a teammate's save; it is
 * checked against theirs when the user leaves the field.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, Checkbox, Dialog, EmptyState, Field, IconTrash, TextInput } from '@studio-pulse/ui';

import * as api from '../lib/api';
import type { TaskPatch, Versioned } from '../lib/api';
import { canDeleteTask, canEditTask, canManageProjects, commitText, receiveText, textSaved, validateDates, validateName } from '../lib/model';
import type { Task, TaskComment, TextDraft } from '../lib/model';
import { readQueryData } from '../lib/store';
import { totals } from '../lib/time';
import { formatDuration, formatRelative, formatWhen } from '../lib/format';
import {
  Avatar,
  ConfirmDialog,
  DateInput,
  LoadingRows,
  MemberSelect,
  PrioritySelect,
  ProblemBanner,
  ProjectSelect,
  TaskStatusSelect,
  cacheTask,
  useAction,
  useDraftId,
} from '../components/common';
import { notifyProblem, notifySuccess } from '../components/notices';
import { keys, useAttributedTime, useComments, useProjects, useRefresh, useSubtasks, useTasks, useWorkspace } from '../app/workspace';

export function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const tasks = useTasks();
  const task = tasks.data?.find((t) => t.id === taskId);
  return (
    <Dialog open onClose={onClose} title={task ? task.title : 'Task'} size="lg" className="web-task-panel">
      {tasks.data === undefined ? (
        tasks.problem ? (
          <ProblemBanner problem={tasks.problem} onRetry={() => void tasks.reload()} />
        ) : (
          <LoadingRows rows={5} />
        )
      ) : task ? (
        <TaskDetail task={task} onClose={onClose} />
      ) : (
        <EmptyState title="Task not found">It was deleted, or it belongs to a workspace you’re not a member of.</EmptyState>
      )}
    </Dialog>
  );
}

/**
 * A text field over a server value that can change while it is being edited (see `receiveText`).
 * The ref always holds the latest draft, for saves that settle later and the flush on close.
 */
function useTextDraft(server: string) {
  const ref = useRef<TextDraft>({ text: server, base: server });
  const [draft, setDraft] = useState(ref.current);
  const update = useCallback((next: (current: TextDraft) => TextDraft) => {
    const value = next(ref.current);
    if (value === ref.current) return;
    ref.current = value;
    setDraft(value);
  }, []);
  // A newer version arrived (a teammate, a refetch): shown unless the field holds an edit.
  useEffect(() => {
    update((current) => receiveText(current, server));
  }, [server, update]);
  return { draft, ref, update, edit: (text: string) => update((current) => ({ ...current, text })) };
}

type TextField = 'title' | 'description';
type ChangeField = keyof TaskPatch;

const FIELD_NAME: Record<ChangeField, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  assignee_id: 'assignee',
  project_id: 'project',
  start_date: 'start date',
  due_date: 'due date',
  estimated_minutes: 'estimate',
};

/** “your change to the title wasn’t” / “your changes to the status and priority weren’t”. */
function yourChanges(fields: readonly ChangeField[]): string {
  const names = fields.map((f) => FIELD_NAME[f]);
  const last = names.pop() ?? '';
  return names.length === 0 ? `your change to the ${last} wasn’t` : `your changes to the ${names.join(', ')} and ${last} weren’t`;
}

/**
 * The version a change the user made on `seen` is sent on: moved on past each save this panel made
 * since (`own`: the version each one was sent on → the version it returned), and nothing else. If
 * the task moved on any other way (a teammate's version, cached after a conflict or by a refetch),
 * the save goes out on the version the user acted on and comes back as a conflict.
 */
function sendOn(seen: number, own: ReadonlyMap<number, number>): number {
  let version = seen;
  for (let next = own.get(version); next !== undefined && next > version; next = own.get(version)) version = next;
  return version;
}

function TaskDetail({ task, onClose }: { task: Task; onClose: () => void }) {
  const { client, workspace, user, members, memberName } = useWorkspace();
  const refresh = useRefresh();
  const projects = useProjects();
  const action = useAction();
  const title = useTextDraft(task.title);
  const description = useTextDraft(task.description);
  // Changes of the user's that a teammate's save got ahead of, until made again or dismissed.
  const [unapplied, setUnapplied] = useState<readonly ChangeField[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  const own = useRef(new Map<number, number>());
  // Text being saved, so leaving a field and then closing the panel doesn't send it twice.
  const sending = useRef<Partial<Record<TextField, string>>>({});
  const deleted = useRef(false);
  // The panel has closed: a conflict can't be shown in the banner any more.
  const closed = useRef(false);
  const editable = canEditTask(task, workspace.role, user.id);

  /** The newest copy of this task this client has (a save just made here may not be rendered yet). */
  function latest(): Task | undefined {
    if (deleted.current) return undefined;
    return readQueryData<Task[]>(keys.tasks(workspace.id))?.find((t) => t.id === task.id);
  }

  // A change that wasn't applied over a teammate's: named in the banner or, once the panel has
  // closed (Escape, Back), in a notice.
  function missed(fields: readonly ChangeField[], current: Task) {
    if (closed.current) {
      notifyProblem({ kind: 'conflict', message: `Someone else changed the task “${current.title}” meanwhile, so ${yourChanges(fields)} saved.` });
    } else {
      setUnapplied((list) => [...list, ...fields.filter((f) => !list.includes(f))]);
    }
  }

  // Saves run one after another: a change made while another is saving is queued instead of
  // dropped. Each goes out on the version shown when the user made it (see `sendOn`), so a
  // teammate's version that arrived meanwhile is never overwritten unseen.
  function save(patch: TaskPatch, success?: string): Promise<Versioned<Task> | undefined> {
    const seen = task.version;
    const fields = Object.keys(patch) as ChangeField[];
    // Making a change again deals with the earlier one that wasn't applied.
    setUnapplied((list) => (list.some((f) => fields.includes(f)) ? list.filter((f) => !fields.includes(f)) : list));
    const run = saves.current.then(async () => {
      if (!latest()) return undefined;
      const version = sendOn(seen, own.current);
      const result = await action.run(() => api.updateTask(client, task.id, version, patch), undefined, 'Couldn’t save:');
      if (result) cacheTask(workspace.id, result.status === 'saved' ? result.row : result.current);
      refresh('tasks');
      if (!result) return undefined;
      if (result.status === 'saved') {
        own.current.set(version, result.row.version);
        if (success) notifySuccess(success);
      } else {
        missed(fields, result.current);
      }
      return result;
    });
    saves.current = run.catch(() => undefined);
    return run;
  }

  async function saveText(field: TextField): Promise<void> {
    const draft = field === 'title' ? title : description;
    const base = latest();
    if (!base) return;
    const text = draft.ref.current.text;
    const value = field === 'title' ? text.trim() : text;
    if (value === sending.current[field]) return;
    const next = commitText(draft.ref.current, base[field], value);
    if (next.kind !== 'save') {
      draft.update(() => next.draft);
      if (next.kind === 'conflict') missed([field], base);
      return;
    }
    const error =
      field === 'title'
        ? validateName(value, 'The title', 200)
        : value.length > 10_000
          ? 'The description can be at most 10,000 characters.'
          : null;
    if (error) {
      notifyProblem({ kind: 'invalid', message: error });
      if (field === 'title') draft.update(() => ({ text: base.title, base: base.title }));
      return;
    }
    sending.current[field] = value;
    const result = await save(field === 'title' ? { title: value } : { description: value });
    if (sending.current[field] === value) delete sending.current[field];
    if (result?.status === 'saved') {
      draft.update((current) => textSaved(current, text, result.row[field]));
    } else if (result?.status === 'conflict') {
      draft.update(() => ({ text: result.current[field], base: result.current[field] }));
    }
  }

  // Escape, Back or the close button can unmount the panel with a text field still focused, and not
  // every browser blurs it first: save what the fields hold on the way out. A conflict from here on
  // is reported in a notice (see `missed`).
  const flush = useRef<() => void>(() => undefined);
  useEffect(() => {
    flush.current = () => {
      void saveText('title');
      void saveText('description');
    };
  });
  useEffect(() => {
    // Set again on every setup: StrictMode runs setup, cleanup, setup on mount with the same ref.
    closed.current = false;
    return () => {
      closed.current = true;
      flush.current();
    };
  }, []);

  function saveDate(patch: TaskPatch, start: string | null, due: string | null): Promise<unknown> | undefined {
    const error = validateDates(start, due);
    if (error) {
      notifyProblem({ kind: 'invalid', message: error });
      return undefined;
    }
    return save(patch);
  }

  async function remove(): Promise<boolean> {
    await saves.current;
    const done = await action.run(() => api.deleteTask(client, task.id), 'Task deleted.', 'Couldn’t delete:');
    if (done === undefined) return false;
    deleted.current = true;
    refresh('tasks');
    onClose();
    return true;
  }

  const archived = task.status === 'archived';

  return (
    <div className="web-task-detail">
      {unapplied.length > 0 ? (
        <Banner
          tone="warning"
          title="Changed by someone else"
          action={
            <Button size="sm" onClick={() => setUnapplied([])}>
              Dismiss
            </Button>
          }
        >
          Someone saved this task a moment ago, so {yourChanges(unapplied)} applied. You’re now seeing their version; make the change again if
          it’s still needed.
        </Banner>
      ) : null}

      <div className="web-task-detail__main">
        <Field label="Title" htmlFor="task-detail-title">
          <TextInput
            id="task-detail-title"
            value={title.draft.text}
            disabled={!editable}
            onChange={(e) => title.edit(e.currentTarget.value)}
            onBlur={() => void saveText('title')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </Field>
        <Field label="Description" htmlFor="task-detail-description" hint={editable ? 'Saved when you leave the field.' : undefined}>
          <textarea
            id="task-detail-description"
            className="sp-input web-textarea"
            rows={5}
            value={description.draft.text}
            disabled={!editable}
            placeholder={editable ? 'Add details, links, acceptance notes…' : ''}
            onChange={(e) => description.edit(e.currentTarget.value)}
            onBlur={() => void saveText('description')}
          />
        </Field>

        <Checklist task={task} editable={editable} />
        <Comments task={task} />
      </div>

      <aside className="web-task-detail__side" aria-label="Task details">
        {/* Saving keeps these enabled (focus stays on the control just used); changes are queued. */}
        <Field label="Status" htmlFor="task-detail-status">
          <TaskStatusSelect id="task-detail-status" value={task.status} disabled={!editable} busy={action.pending} onChange={(status) => void save({ status })} />
        </Field>
        <Field label="Priority" htmlFor="task-detail-priority">
          <PrioritySelect id="task-detail-priority" value={task.priority} disabled={!editable} busy={action.pending} onChange={(priority) => void save({ priority })} />
        </Field>
        <Field label="Assignee" htmlFor="task-detail-assignee">
          <MemberSelect
            id="task-detail-assignee"
            members={members}
            value={task.assignee_id}
            disabled={!editable}
            busy={action.pending}
            onChange={(assignee_id) => void save({ assignee_id })}
          />
        </Field>
        <Field label="Project" htmlFor="task-detail-project">
          <ProjectSelect
            id="task-detail-project"
            projects={projects.data ?? []}
            value={task.project_id}
            disabled={!editable}
            busy={action.pending}
            onChange={(project_id) => {
              // The task's tracked time moves with it, so project totals change too.
              void save({ project_id }).then((result) => {
                if (result?.status === 'saved') refresh('time');
              });
            }}
          />
        </Field>
        <Field label="Start date" htmlFor="task-detail-start">
          <DateInput
            id="task-detail-start"
            value={task.start_date}
            disabled={!editable}
            onChange={(start_date) => saveDate({ start_date }, start_date, task.due_date)}
            onConflict={() => missed(['start_date'], latest() ?? task)}
          />
        </Field>
        <Field label="Due date" htmlFor="task-detail-due">
          <DateInput
            id="task-detail-due"
            value={task.due_date}
            disabled={!editable}
            onChange={(due_date) => saveDate({ due_date }, task.start_date, due_date)}
            onConflict={() => missed(['due_date'], latest() ?? task)}
          />
        </Field>

        <TaskTime task={task} />

        <dl className="web-meta">
          <div>
            <dt>Created by</dt>
            <dd>{task.created_by ? memberName(task.created_by) : 'Unknown'}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatWhen(task.created_at)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatRelative(task.updated_at)}</dd>
          </div>
          {task.completed_at ? (
            <div>
              <dt>Completed</dt>
              <dd>{formatWhen(task.completed_at)}</dd>
            </div>
          ) : null}
        </dl>

        {editable ? (
          <div className="web-actions web-actions--stack">
            {archived ? (
              <Button size="sm" onClick={() => void save({ status: 'todo' }, 'Task restored.')}>
                Restore task
              </Button>
            ) : (
              <Button size="sm" onClick={() => void save({ status: 'archived' }, 'Task archived.')}>
                Archive task
              </Button>
            )}
            {canDeleteTask(task, workspace.role, user.id) ? (
              <Button size="sm" variant="ghost" icon={<IconTrash size={14} />} onClick={() => setConfirmDelete(true)}>
                Delete task
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="web-footnote">Only its creator, its assignee, and owners or admins can change this task.</p>
        )}
      </aside>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this task?"
        confirmLabel="Delete task"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
      >
        <p className="web-dialog-text">
          Its checklist and comments are deleted with it. A task with tracked time can’t be deleted; archive it instead to keep its history.
        </p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------------------------

function Checklist({ task, editable }: { task: Task; editable: boolean }) {
  const { client, workspace, user } = useWorkspace();
  const refresh = useRefresh();
  const subtasks = useSubtasks(task.id);
  const action = useAction();
  const draftId = useDraftId();
  const [draft, setDraft] = useState('');
  const items = subtasks.data ?? [];
  const done = items.filter((s) => s.done).length;

  async function add(event: FormEvent) {
    event.preventDefault();
    const error = validateName(draft, 'A checklist item', 200);
    if (error) {
      if (draft.length > 0) notifyProblem({ kind: 'invalid', message: error });
      return;
    }
    const position = items.reduce((max, s) => Math.max(max, s.position), -1) + 1;
    const created = await action.run(
      () => api.addSubtask(client, { workspaceId: workspace.id, taskId: task.id, title: draft.trim(), position }, user.id, draftId.id()),
      undefined,
      'Couldn’t add the item:',
    );
    if (created) {
      draftId.done();
      setDraft('');
    }
    refresh('task_subtasks');
  }

  return (
    <section className="web-section" aria-label="Checklist">
      <h3 className="web-section__title">
        Checklist {items.length > 0 ? <span className="web-section__count">{`${done}/${items.length}`}</span> : null}
      </h3>
      {subtasks.problem ? <ProblemBanner problem={subtasks.problem} onRetry={() => void subtasks.reload()} /> : null}
      {subtasks.data === undefined && !subtasks.problem ? (
        <LoadingRows rows={2} />
      ) : (
        <ul className="web-checklist">
          {items.map((item) => (
            <li key={item.id} className="web-checklist__item">
              <Checkbox
                checked={item.done}
                disabled={!editable}
                label={<span className={item.done ? 'web-done' : undefined}>{item.title}</span>}
                onChange={(next) =>
                  void action
                    .run(() => api.updateSubtask(client, item.id, { done: next }), undefined, 'Couldn’t update the item:')
                    .then(() => refresh('task_subtasks'))
                }
              />
              {editable ? (
                <button
                  type="button"
                  className="web-icon-button"
                  aria-label={`Remove “${item.title}”`}
                  onClick={() =>
                    void action.run(() => api.deleteSubtask(client, item.id), undefined, 'Couldn’t remove the item:').then(() => refresh('task_subtasks'))
                  }
                >
                  <IconTrash size={12} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <form className="web-inline-form" onSubmit={(e) => void add(e)}>
          <TextInput inputSize="sm" placeholder="Add a checklist item" aria-label="New checklist item" value={draft} onChange={(e) => setDraft(e.currentTarget.value)} />
          <Button size="sm" type="submit" pending={action.pending} disabled={!draft.trim()}>
            Add
          </Button>
        </form>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

function Comments({ task }: { task: Task }) {
  const { client, workspace, user, memberName } = useWorkspace();
  const refresh = useRefresh();
  const comments = useComments(task.id);
  const action = useAction();
  const draftId = useDraftId();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [deleting, setDeleting] = useState<TaskComment | null>(null);

  async function post(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    if (body.length > 10_000) {
      notifyProblem({ kind: 'invalid', message: 'A comment can be at most 10,000 characters.' });
      return;
    }
    const created = await action.run(
      () => api.addComment(client, { workspaceId: workspace.id, taskId: task.id, body }, user.id, draftId.id()),
      undefined,
      'Couldn’t post the comment:',
    );
    if (created) {
      draftId.done();
      setDraft('');
    }
    refresh('task_comments');
  }

  async function saveEdit() {
    if (!editing) return;
    const body = editing.body.trim();
    if (!body) return;
    const saved = await action.run(() => api.editComment(client, editing.id, body), undefined, 'Couldn’t save the comment:');
    if (saved) setEditing(null);
    refresh('task_comments');
  }

  return (
    <section className="web-section" aria-label="Comments">
      <h3 className="web-section__title">Comments</h3>
      {comments.problem ? <ProblemBanner problem={comments.problem} onRetry={() => void comments.reload()} /> : null}
      {comments.data === undefined && !comments.problem ? (
        <LoadingRows rows={2} />
      ) : (comments.data ?? []).length === 0 ? (
        <p className="web-footnote">No comments yet.</p>
      ) : (
        <ol className="web-comments">
          {(comments.data ?? []).map((comment) => {
            const mine = comment.author_id === user.id;
            const canDelete = mine || canManageProjects(workspace.role);
            return (
              <li key={comment.id} className="web-comment">
                <Avatar name={memberName(comment.author_id)} size={24} />
                <div className="web-comment__body">
                  <div className="web-comment__meta">
                    <strong>{memberName(comment.author_id)}</strong>
                    <span>{formatRelative(comment.created_at)}</span>
                    {comment.edited_at ? <span title={`Edited ${formatWhen(comment.edited_at)}`}>edited</span> : null}
                  </div>
                  {editing?.id === comment.id ? (
                    <div className="web-comment__edit">
                      <textarea
                        className="sp-input web-textarea"
                        rows={3}
                        aria-label="Edit comment"
                        value={editing.body}
                        onChange={(e) => setEditing({ id: comment.id, body: e.currentTarget.value })}
                      />
                      <div className="web-actions">
                        <Button size="sm" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                        <Button size="sm" variant="primary" pending={action.pending} onClick={() => void saveEdit()}>
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="web-comment__text">{comment.body}</p>
                  )}
                  {editing?.id !== comment.id && (mine || canDelete) ? (
                    <div className="web-comment__actions">
                      {mine ? (
                        <button type="button" className="web-link" onClick={() => setEditing({ id: comment.id, body: comment.body })}>
                          Edit
                        </button>
                      ) : null}
                      {canDelete ? (
                        <button type="button" className="web-link" onClick={() => setDeleting(comment)}>
                          Delete
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <form className="web-comment-form" onSubmit={(e) => void post(e)}>
        <textarea
          className="sp-input web-textarea"
          rows={2}
          aria-label="Write a comment"
          placeholder="Write a comment…"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void post(e);
          }}
        />
        <Button size="sm" type="submit" variant="primary" pending={action.pending} disabled={!draft.trim()}>
          Comment
        </Button>
      </form>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this comment?"
        confirmLabel="Delete"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return true;
          const done = await action.run(() => api.deleteComment(client, deleting.id), undefined, 'Couldn’t delete the comment:');
          refresh('task_comments');
          return done !== undefined;
        }}
      />
    </section>
  );
}

function TaskTime({ task }: { task: Task }) {
  const time = useAttributedTime({ taskId: task.id });
  if (time.data === undefined || time.data.length === 0) return null;
  const sum = totals(time.data);
  return (
    <div className="web-task-time">
      <span className="web-task-time__label">Tracked on this task</span>
      <span className="web-task-time__value">{formatDuration(sum.activeMs)} active</span>
      <span className="web-task-time__sub">
        {formatDuration(sum.foregroundMs)} in foreground · {sum.entries} sessions
      </span>
    </div>
  );
}
