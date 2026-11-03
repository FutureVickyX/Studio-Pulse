/**
 * Domain types and pure rules for the workspace UI: labels, filters, sorting, due dates and
 * input validation. No I/O; unit-tested in tests/unit/web.
 */

import { Constants } from '@studio-pulse/database';
import type { Enums, Tables } from '@studio-pulse/database';

export type Project = Tables<'projects'>;
export type Task = Tables<'tasks'>;
export type Note = Tables<'notes'>;
export type Subtask = Tables<'task_subtasks'>;
export type TaskComment = Tables<'task_comments'>;
export type ProjectStatus = Enums<'project_status'>;
export type TaskStatus = Enums<'task_status'>;
export type TaskPriority = Enums<'task_priority'>;
export type WorkspaceRole = Enums<'workspace_role'>;
export type NoteVisibility = Enums<'note_visibility'>;

export interface Member {
  readonly userId: string;
  readonly displayName: string;
  readonly role: WorkspaceRole;
}

export interface WorkspaceInfo {
  readonly id: string;
  readonly name: string;
  readonly role: WorkspaceRole;
  readonly timeEntryVisibility: Enums<'time_entry_visibility'>;
}

// ---------------------------------------------------------------------------------------------
// Labels (enum order comes from the database description, so they cannot drift)
// ---------------------------------------------------------------------------------------------

export type Tone = 'neutral' | 'subtle' | 'accent' | 'warning' | 'danger' | 'success';

export const PROJECT_STATUSES: readonly ProjectStatus[] = Constants.public.Enums.project_status;
export const TASK_STATUSES: readonly TaskStatus[] = Constants.public.Enums.task_status;
export const TASK_PRIORITIES: readonly TaskPriority[] = Constants.public.Enums.task_priority;

export const PROJECT_STATUS_LABEL: Readonly<Record<ProjectStatus, string>> = {
  planning: 'Planning',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  archived: 'Archived',
};
export const PROJECT_STATUS_TONE: Readonly<Record<ProjectStatus, Tone>> = {
  planning: 'neutral',
  active: 'accent',
  on_hold: 'warning',
  completed: 'success',
  archived: 'subtle',
};
export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  inbox: 'Inbox',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  archived: 'Archived',
};
export const TASK_STATUS_TONE: Readonly<Record<TaskStatus, Tone>> = {
  inbox: 'subtle',
  todo: 'neutral',
  in_progress: 'accent',
  in_review: 'warning',
  done: 'success',
  archived: 'subtle',
};
export const TASK_PRIORITY_LABEL: Readonly<Record<TaskPriority, string>> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};
export const ROLE_LABEL: Readonly<Record<WorkspaceRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

// ---------------------------------------------------------------------------------------------
// Permissions the UI mirrors (the database enforces them; this only decides what to offer)
// ---------------------------------------------------------------------------------------------

export function canManageProjects(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function canEditProject(project: Project, role: WorkspaceRole, userId: string): boolean {
  return canManageProjects(role) || project.lead_id === userId;
}

export function canEditTask(task: Task, role: WorkspaceRole, userId: string): boolean {
  return canManageProjects(role) || task.created_by === userId || task.assignee_id === userId;
}

export function canDeleteTask(task: Task, role: WorkspaceRole, userId: string): boolean {
  return canManageProjects(role) || task.created_by === userId;
}

export function canEditNote(note: Note, userId: string): boolean {
  return note.owner_id === userId || note.visibility === 'workspace';
}

/**
 * An assignee or lead who is no longer an active member (they left or were removed). Never true
 * before the member list has loaded: it always includes the signed-in user, so empty means "not yet".
 */
export function isFormerMember(userId: string | null, members: readonly Pick<Member, 'userId'>[]): boolean {
  return userId !== null && members.length > 0 && !members.some((m) => m.userId === userId);
}

// ---------------------------------------------------------------------------------------------
// Dates (day keys are local 'YYYY-MM-DD' strings, compared as strings)
// ---------------------------------------------------------------------------------------------

export type DueState = 'none' | 'overdue' | 'today' | 'soon' | 'later';

function dayNumber(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
}

/** Whole days from `today` to `day` (negative when `day` is in the past). */
export function daysUntil(day: string, today: string): number {
  return Math.round(dayNumber(day) - dayNumber(today));
}

export function dueState(due: string | null, today: string, soonDays = 7): DueState {
  if (!due) return 'none';
  const days = daysUntil(due, today);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= soonDays) return 'soon';
  return 'later';
}

/**
 * A whole day as a date field reports it, not one of the values typing a year passes through
 * (typing 2027 reports 0002, 0020 and 0202 first). Years before 1900 are taken as a typing slip.
 */
export function isPlausibleDay(day: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const date = Number(match[3]);
  const utc = new Date(Date.UTC(year, month, date));
  return year >= 1900 && utc.getUTCFullYear() === year && utc.getUTCMonth() === month && utc.getUTCDate() === date;
}

export function describeDue(due: string | null, today: string): string {
  if (!due) return '';
  const days = daysUntil(due, today);
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days === -1) return 'Due yesterday';
  if (days < 0) return `${-days} days overdue`;
  if (days <= 7) return `Due in ${days} days`;
  return `Due ${due}`;
}

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

export function isOpenTask(task: Pick<Task, 'status'>): boolean {
  return task.status !== 'done' && task.status !== 'archived';
}

export interface TaskFilter {
  /** 'open' = everything not done or archived; 'any' = everything except archived. */
  readonly status: 'open' | 'any' | TaskStatus;
  /** A user id, 'unassigned', or null for anyone. */
  readonly assignee: string | 'unassigned' | null;
  /** A project id, 'none' for tasks without a project, or null for any project. */
  readonly projectId: string | 'none' | null;
  readonly priority: TaskPriority | null;
  readonly search: string;
}

export const ALL_TASKS: TaskFilter = { status: 'any', assignee: null, projectId: null, priority: null, search: '' };

export function normalizeSearch(text: string): string {
  return text.trim().toLocaleLowerCase();
}

export function filterTasks(tasks: readonly Task[], filter: TaskFilter): Task[] {
  const search = normalizeSearch(filter.search);
  return tasks.filter((task) => {
    if (filter.status === 'open') {
      if (!isOpenTask(task)) return false;
    } else if (filter.status === 'any') {
      if (task.status === 'archived') return false;
    } else if (task.status !== filter.status) {
      return false;
    }
    if (filter.assignee === 'unassigned' ? task.assignee_id !== null : filter.assignee !== null && task.assignee_id !== filter.assignee) {
      return false;
    }
    if (filter.projectId === 'none' ? task.project_id !== null : filter.projectId !== null && task.project_id !== filter.projectId) {
      return false;
    }
    if (filter.priority !== null && task.priority !== filter.priority) return false;
    if (search && !task.title.toLocaleLowerCase().includes(search)) return false;
    return true;
  });
}

const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_RANK: Readonly<Record<TaskStatus, number>> = Object.fromEntries(
  TASK_STATUSES.map((status, i) => [status, i]),
) as Record<TaskStatus, number>;

/**
 * Work order: open before finished, then the earliest due date (no due date last), then priority,
 * then the most recently updated. Stable for equal keys.
 */
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const openA = isOpenTask(a) ? 0 : 1;
    const openB = isOpenTask(b) ? 0 : 1;
    if (openA !== openB) return openA - openB;
    const dueA = a.due_date ?? '9999-12-31';
    const dueB = b.due_date ?? '9999-12-31';
    if (dueA !== dueB) return dueA < dueB ? -1 : 1;
    const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (priority !== 0) return priority;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

/** Tasks grouped by status, in workflow order, omitting empty groups. */
export function groupByStatus(tasks: readonly Task[]): { status: TaskStatus; tasks: Task[] }[] {
  const groups = new Map<TaskStatus, Task[]>();
  for (const task of sortTasks(tasks)) {
    const list = groups.get(task.status) ?? [];
    list.push(task);
    groups.set(task.status, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => STATUS_RANK[a] - STATUS_RANK[b])
    .map(([status, list]) => ({ status, tasks: list }));
}

export interface Progress {
  readonly done: number;
  readonly total: number;
}

/** Done / total over a project's tasks, archived tasks excluded. */
export function taskProgress(tasks: readonly Pick<Task, 'status'>[]): Progress {
  let done = 0;
  let total = 0;
  for (const task of tasks) {
    if (task.status === 'archived') continue;
    total += 1;
    if (task.status === 'done') done += 1;
  }
  return { done, total };
}

/**
 * Code-unit order, the order the database gives uuids and (UTC) timestamps. `localeCompare` would
 * put '…T09:00:00+00:00' after '…T09:00:00.5+00:00'.
 */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A task's checklist order: by position, then in the order the items were added. */
export function compareSubtasks(
  a: Pick<Subtask, 'position' | 'created_at' | 'id'>,
  b: Pick<Subtask, 'position' | 'created_at' | 'id'>,
): number {
  return a.position - b.position || byCodeUnits(a.created_at, b.created_at) || byCodeUnits(a.id, b.id);
}

// ---------------------------------------------------------------------------------------------
// Cached lists (a row the server just returned goes in at once; the refetch brings the rest)
// ---------------------------------------------------------------------------------------------

/**
 * `rows` with `row` (just returned by the server) in place of its cached copy, or added at the end
 * when it is new. A cached copy at a newer version (a refetch got there first) is kept.
 */
export function withRow<T extends { readonly id: string; readonly version: number }>(rows: readonly T[], row: T): T[] {
  const index = rows.findIndex((r) => r.id === row.id);
  if (index === -1) return [...rows, row];
  return rows.map((r, i) => (i === index && r.version <= row.version ? row : r));
}

/**
 * The cached notes list with a note this client just created, first (the newest), so a page that
 * opens it finds it before the refetch lands. `undefined` when there is nothing to change: the list
 * has not loaded (a one-row list would pass for the whole list; the page that opens the note loads
 * it), or a refetch already brought the note (that copy is kept).
 */
export function withCreatedNote(notes: readonly Note[] | undefined, note: Note): Note[] | undefined {
  if (notes === undefined || notes.some((n) => n.id === note.id)) return undefined;
  return [note, ...notes];
}

/** The same for a project, in the projects list's order (`compareProjects`). */
export function withCreatedProject(projects: readonly Project[] | undefined, project: Project): Project[] | undefined {
  if (projects === undefined || projects.some((p) => p.id === project.id)) return undefined;
  return [...projects, project].sort(compareProjects);
}

// ---------------------------------------------------------------------------------------------
// Text edited in place (saved when the user leaves the field, while teammates' saves arrive)
// ---------------------------------------------------------------------------------------------

/**
 * A text field saved when the user leaves it. `base` is the server text it was last synced from:
 * while `text` differs from it, the field holds an edit of the user's own.
 */
export interface TextDraft {
  readonly text: string;
  readonly base: string;
}

/** The server text changed (a teammate, a refetch): an untouched field shows it; an edit is kept. */
export function receiveText(draft: TextDraft, server: string): TextDraft {
  if (draft.base === server) return draft;
  if (draft.text === draft.base || draft.text === server) return { text: server, base: server };
  return draft;
}

export type TextCommit =
  | { readonly kind: 'save'; readonly value: string }
  /** Nothing to save: the field shows the server text again. */
  | { readonly kind: 'unchanged'; readonly draft: TextDraft }
  /** Someone else changed this field while it was being edited: theirs stays, the edit is dropped. */
  | { readonly kind: 'conflict'; readonly draft: TextDraft };

/**
 * Leaving the field with `value` (its text as it would be saved, e.g. trimmed). An edit is saved
 * only on top of the server text it started from, so a teammate's change to the same field is
 * never overwritten unseen.
 */
export function commitText(draft: TextDraft, server: string, value: string = draft.text): TextCommit {
  const synced = draft.text === server && draft.base === server ? draft : { text: server, base: server };
  if (draft.text === draft.base || value === server) return { kind: 'unchanged', draft: synced };
  if (draft.base !== server) return { kind: 'conflict', draft: synced };
  return { kind: 'save', value };
}

/** The field's text `committed` was saved as `saved`: that is the new base; typing since is kept. */
export function textSaved(draft: TextDraft, committed: string, saved: string): TextDraft {
  return { text: draft.text === committed ? saved : draft.text, base: saved };
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

/** 'current' = planning, active and on hold. */
export type ProjectScope = 'current' | 'completed' | 'archived' | 'all';

export function projectInScope(status: ProjectStatus, scope: ProjectScope): boolean {
  switch (scope) {
    case 'current':
      return status === 'planning' || status === 'active' || status === 'on_hold';
    case 'completed':
      return status === 'completed';
    case 'archived':
      return status === 'archived';
    case 'all':
      return true;
  }
}

/** The projects list's order: by name (then by id, so equal names always come in one order). */
export function compareProjects(a: Pick<Project, 'name' | 'id'>, b: Pick<Project, 'name' | 'id'>): number {
  return a.name.localeCompare(b.name) || byCodeUnits(a.id, b.id);
}

export function filterProjects(projects: readonly Project[], scope: ProjectScope, search: string): Project[] {
  const needle = normalizeSearch(search);
  return projects
    .filter((p) => projectInScope(p.status, scope) && (!needle || p.name.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------

/** 'mine' = my private notes; 'shared' = workspace notes; 'all' = everything I can see. */
export type NoteScope = 'all' | 'mine' | 'shared';

export interface NoteFilter {
  readonly scope: NoteScope;
  readonly projectId: string | 'none' | null;
  readonly search: string;
  readonly archived: boolean;
}

/** The notes list's order: the most recently updated first (then by id, so ties always come in one order). */
export function compareNotes(a: Pick<Note, 'updated_at' | 'id'>, b: Pick<Note, 'updated_at' | 'id'>): number {
  return byCodeUnits(b.updated_at, a.updated_at) || byCodeUnits(a.id, b.id);
}

export function filterNotes(notes: readonly Note[], filter: NoteFilter, userId: string): Note[] {
  const needle = normalizeSearch(filter.search);
  return notes
    .filter((note) => {
      if ((note.archived_at !== null) !== filter.archived) return false;
      if (filter.scope === 'mine' && !(note.owner_id === userId && note.visibility === 'private')) return false;
      if (filter.scope === 'shared' && note.visibility !== 'workspace') return false;
      if (filter.projectId === 'none' ? note.project_id !== null : filter.projectId !== null && note.project_id !== filter.projectId) {
        return false;
      }
      if (needle && !`${note.title}\n${note.body}`.toLocaleLowerCase().includes(needle)) return false;
      return true;
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
}

/** A one-line plain-text preview of a note body (Markdown markers stripped). */
export function notePreview(body: string, max = 140): string {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function noteTitle(note: Pick<Note, 'title' | 'body'>): string {
  const title = note.title.trim();
  if (title) return title;
  const firstLine = note.body.split('\n').find((line) => line.trim().length > 0);
  return firstLine ? notePreview(firstLine, 60) : 'Untitled note';
}

// ---------------------------------------------------------------------------------------------
// Validation (mirrors the database CHECK constraints so problems show before a round trip)
// ---------------------------------------------------------------------------------------------

export function validateName(value: string, label: string, max: number): string | null {
  const length = value.trim().length;
  if (length === 0) return `${label} can’t be empty.`;
  if (length > max) return `${label} can be at most ${max} characters (now ${length}).`;
  return null;
}

export function validateDates(start: string | null, due: string | null): string | null {
  if (start && due && start > due) return 'The start date must be on or before the due date.';
  return null;
}

export function validateEmail(value: string): string | null {
  const email = value.trim();
  if (!email) return 'Enter an email address.';
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
  return null;
}

/** Initials for an avatar: up to two letters of the display name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase() || '?';
}
