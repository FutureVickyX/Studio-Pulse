/**
 * Every read and write of the workspace, through the user's RLS-checked Supabase session.
 *
 * - Creates are idempotent: the id is generated here once, and a retry after a lost response
 *   either succeeds or meets the row the first attempt created (23505), never a duplicate.
 * - Updates of projects, tasks and notes name the version they are based on. When nothing was
 *   updated, the current row tells a conflict (someone else saved), a refusal (no permission)
 *   and a deletion apart. Nothing is overwritten silently.
 * - Lists are read page by page in an order no update changes (`listAll`): PostgREST cuts every
 *   response at the project's max rows without saying so.
 */

import type { FunctionArgs, FunctionReturns, StudioPulseClient, Tables, TablesInsert, TablesUpdate } from '@studio-pulse/database';
import type { ReportBucket, ReportRow } from '@studio-pulse/time-engine';

import { ProblemError, isNetworkError, toProblem, toReportProblem } from './errors';
import { compareNotes, compareProjects, compareSubtasks } from './model';
import type { Member, Note, Project, Subtask, Task, TaskComment, WorkspaceInfo } from './model';
import { TIME_ENTRY_COLUMNS } from './time';
import type { TimeEntry } from './time';
import type { NoteDraft, SaveOutcome } from './autosave';

type Result<T> = { data: T | null; error: unknown };

function fail(error: unknown): never {
  throw new ProblemError(toProblem(error));
}

function must<T>({ data, error }: Result<T>): T {
  if (error) fail(error);
  if (data === null) fail({ code: 'PGRST116' });
  return data;
}

function list<T>({ data, error }: Result<T[]>): T[] {
  if (error) fail(error);
  return data ?? [];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rows per request. PostgREST cuts every response at the project's max rows (1,000 on Supabase
 * by default) and does not say so; a shorter page is taken as the last one, so this must not
 * exceed that setting.
 */
export const PAGE_ROWS = 1000;

/**
 * Every row of a list (at most `max`, the first in `page`'s order), page by page with offsets.
 * `page` must order only by columns that no update changes, ending with a unique one (created_at,
 * then id). Under a column an edit changes (updated_at, a name, a position), a row edited while the
 * pages are read can cross into a page already read, and the next page then skips a row; a list
 * shown in such an order is read in a fixed one and sorted afterwards. A row added meanwhile can
 * push one already read into the next page: a row seen twice (by its id) is kept once. A row
 * removed meanwhile (or no longer matching) pulls the next page's first row back into the range
 * already read: that row is missing until the next read.
 */
export async function listAll<T>(page: (from: number, to: number) => PromiseLike<Result<T[]>>, max = Infinity): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<unknown>();
  for (let from = 0; rows.length < max; ) {
    const size = Math.min(PAGE_ROWS, max - rows.length);
    const batch = list(await page(from, from + size - 1));
    for (const row of batch) {
      const id = (row as { id?: unknown }).id;
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      rows.push(row);
    }
    if (batch.length < size) break;
    from += batch.length;
  }
  return rows;
}

/** Display names by profile id, a few ids per request (keeps each URL short). */
async function profileNames(client: StudioPulseClient, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const rows = list(await client.from('profiles').select('id, display_name').in('id', ids.slice(i, i + 100)));
    for (const row of rows) names.set(row.id, row.display_name);
  }
  return names;
}

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Run `insert` (which carries a client-generated id) until it is confirmed. A network failure is
 * retried with the same id; "already exists" means an earlier attempt landed: return that row.
 * The create functions below take that id, so the UI can keep one id per draft (`useDraftId`):
 * pressing Create again after a failure then finds the row that landed instead of adding another.
 */
export async function insertOnce<T>(
  insert: () => PromiseLike<Result<T>>,
  existing: () => PromiseLike<Result<T>>,
  retries = 2,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let result: Result<T>;
    try {
      result = await insert();
    } catch (error) {
      result = { data: null, error };
    }
    if (!result.error && result.data !== null) return result.data;
    const code = (result.error as { code?: unknown } | null)?.code;
    if (code === '23505') {
      const found = await existing();
      if (!found.error && found.data !== null) return found.data;
    }
    if (isNetworkError(result.error) && attempt < retries) {
      await sleep(600 * 2 ** attempt);
      continue;
    }
    fail(result.error ?? { code: 'PGRST116' });
  }
}

export type Versioned<T> = { readonly status: 'saved'; readonly row: T } | { readonly status: 'conflict'; readonly current: T };

/** After an update matched nothing: who is right? */
function settleUnmatched<T extends { version: number }>(current: T | null, version: number): Versioned<T> {
  if (current === null) fail({ code: 'P0002', message: 'this item was deleted or is no longer shared with you' });
  if (current.version === version) fail({ code: '42501' }); // same version, still refused: no permission
  return { status: 'conflict', current };
}

// ---------------------------------------------------------------------------------------------
// Workspaces and members
// ---------------------------------------------------------------------------------------------

export async function listMyWorkspaces(client: StudioPulseClient): Promise<WorkspaceInfo[]> {
  const rows = list(await client.rpc('my_workspaces'));
  return rows.map((row) => ({
    id: row.workspace_id,
    name: row.name,
    role: row.role,
    timeEntryVisibility: row.time_entry_visibility,
  }));
}

export async function createWorkspace(client: StudioPulseClient, name: string): Promise<string> {
  return must(await client.rpc('create_workspace', { p_name: name.trim() })).id;
}

export async function acceptInvitation(client: StudioPulseClient, token: string): Promise<string> {
  return must(await client.rpc('accept_invitation', { p_token: token.trim() }));
}

export async function createInvitation(
  client: StudioPulseClient,
  workspaceId: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ token: string; expiresAt: string }> {
  const rows = list(await client.rpc('create_invitation', { p_workspace_id: workspaceId, p_email: email.trim(), p_role: role }));
  const row = rows[0];
  if (!row) fail({ code: 'PGRST116' });
  return { token: row.token, expiresAt: row.expires_at };
}

/** Active members with their display names (teammates' profiles are readable to members). */
export async function listMembers(client: StudioPulseClient, workspaceId: string): Promise<Member[]> {
  const rows = await listAll((from, to) =>
    client
      .from('workspace_members')
      .select('user_id, role')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .order('user_id')
      .range(from, to),
  );
  // Someone joining while the pages are read can push a membership already read into the next
  // page. Memberships have no id for listAll to drop the second copy by: one per user.
  const memberships = [...new Map(rows.map((m) => [m.user_id, m])).values()];
  if (memberships.length === 0) return [];
  const names = await profileNames(
    client,
    memberships.map((m) => m.user_id),
  );
  return memberships
    .map((m) => ({ userId: m.user_id, role: m.role, displayName: names.get(m.user_id) ?? 'Former member' }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
}

/** Display names of people who are not active members any more (authors of old work). */
export async function listProfiles(client: StudioPulseClient, ids: readonly string[]): Promise<Map<string, string>> {
  return profileNames(client, ids);
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

/** By name. Read in creation order: a rename while the pages are read would move a project between them. */
export async function listProjects(client: StudioPulseClient, workspaceId: string): Promise<Project[]> {
  const rows = await listAll((from, to) =>
    client.from('projects').select('*').eq('workspace_id', workspaceId).order('created_at').order('id').range(from, to),
  );
  return rows.sort(compareProjects);
}

export type ProjectInput = Omit<TablesInsert<'projects'>, 'id' | 'created_by' | 'version' | 'created_at' | 'updated_at'>;

export function createProject(client: StudioPulseClient, input: ProjectInput, userId: string, id = newId()): Promise<Project> {
  return insertOnce(
    () => client.from('projects').insert({ ...input, id, created_by: userId }).select('*').single(),
    () => client.from('projects').select('*').eq('id', id).single(),
  );
}

export type ProjectPatch = Pick<TablesUpdate<'projects'>, 'name' | 'description' | 'status' | 'lead_id' | 'start_date' | 'due_date'>;

export async function updateProject(
  client: StudioPulseClient,
  id: string,
  version: number,
  patch: ProjectPatch,
): Promise<Versioned<Project>> {
  const row = await client.from('projects').update(patch).eq('id', id).eq('version', version).select('*').maybeSingle();
  if (row.error) fail(row.error);
  if (row.data) return { status: 'saved', row: row.data };
  const current = await client.from('projects').select('*').eq('id', id).maybeSingle();
  if (current.error) fail(current.error);
  return settleUnmatched(current.data, version);
}

export async function deleteProject(client: StudioPulseClient, id: string): Promise<void> {
  const { error, count } = await client.from('projects').delete({ count: 'exact' }).eq('id', id);
  if (error) fail(error);
  if (count === 0) fail({ code: '42501' });
}

// ---------------------------------------------------------------------------------------------
// Tasks, checklists and comments
// ---------------------------------------------------------------------------------------------

export async function listTasks(client: StudioPulseClient, workspaceId: string): Promise<Task[]> {
  return listAll((from, to) => client.from('tasks').select('*').eq('workspace_id', workspaceId).order('created_at').order('id').range(from, to));
}

export type TaskInput = Omit<
  TablesInsert<'tasks'>,
  'id' | 'created_by' | 'version' | 'created_at' | 'updated_at' | 'completed_at'
>;

export function createTask(client: StudioPulseClient, input: TaskInput, userId: string, id = newId()): Promise<Task> {
  return insertOnce(
    () => client.from('tasks').insert({ ...input, id, created_by: userId }).select('*').single(),
    () => client.from('tasks').select('*').eq('id', id).single(),
  );
}

export type TaskPatch = Pick<
  TablesUpdate<'tasks'>,
  'title' | 'description' | 'status' | 'priority' | 'assignee_id' | 'project_id' | 'due_date' | 'start_date' | 'estimated_minutes'
>;

export async function updateTask(client: StudioPulseClient, id: string, version: number, patch: TaskPatch): Promise<Versioned<Task>> {
  const row = await client.from('tasks').update(patch).eq('id', id).eq('version', version).select('*').maybeSingle();
  if (row.error) fail(row.error);
  if (row.data) return { status: 'saved', row: row.data };
  const current = await client.from('tasks').select('*').eq('id', id).maybeSingle();
  if (current.error) fail(current.error);
  return settleUnmatched(current.data, version);
}

export async function deleteTask(client: StudioPulseClient, id: string): Promise<void> {
  const { error, count } = await client.from('tasks').delete({ count: 'exact' }).eq('id', id);
  if (error) fail(error);
  if (count === 0) fail({ code: '42501' });
}

/** In checklist order. Read in creation order: reordering changes `position`. */
export async function listSubtasks(client: StudioPulseClient, taskId: string): Promise<Subtask[]> {
  const rows = await listAll((from, to) =>
    client.from('task_subtasks').select('*').eq('task_id', taskId).order('created_at').order('id').range(from, to),
  );
  return rows.sort(compareSubtasks);
}

export function addSubtask(
  client: StudioPulseClient,
  input: { workspaceId: string; taskId: string; title: string; position: number },
  userId: string,
  id = newId(),
): Promise<Subtask> {
  return insertOnce(
    () =>
      client
        .from('task_subtasks')
        .insert({ id, workspace_id: input.workspaceId, task_id: input.taskId, title: input.title, position: input.position, created_by: userId })
        .select('*')
        .single(),
    () => client.from('task_subtasks').select('*').eq('id', id).single(),
  );
}

export async function updateSubtask(
  client: StudioPulseClient,
  id: string,
  patch: Pick<TablesUpdate<'task_subtasks'>, 'title' | 'done' | 'position'>,
): Promise<Subtask> {
  const result = await client.from('task_subtasks').update(patch).eq('id', id).select('*').maybeSingle();
  if (result.error) fail(result.error);
  if (!result.data) fail({ code: '42501' });
  return result.data;
}

export async function deleteSubtask(client: StudioPulseClient, id: string): Promise<void> {
  const { error, count } = await client.from('task_subtasks').delete({ count: 'exact' }).eq('id', id);
  if (error) fail(error);
  if (count === 0) fail({ code: '42501' });
}

export async function listComments(client: StudioPulseClient, taskId: string): Promise<TaskComment[]> {
  return listAll((from, to) => client.from('task_comments').select('*').eq('task_id', taskId).order('created_at').order('id').range(from, to));
}

export function addComment(
  client: StudioPulseClient,
  input: { workspaceId: string; taskId: string; body: string },
  userId: string,
  id = newId(),
): Promise<TaskComment> {
  return insertOnce(
    () =>
      client
        .from('task_comments')
        .insert({ id, workspace_id: input.workspaceId, task_id: input.taskId, body: input.body, author_id: userId })
        .select('*')
        .single(),
    () => client.from('task_comments').select('*').eq('id', id).single(),
  );
}

export async function editComment(client: StudioPulseClient, id: string, body: string): Promise<TaskComment> {
  const result = await client.from('task_comments').update({ body }).eq('id', id).select('*').maybeSingle();
  if (result.error) fail(result.error);
  if (!result.data) fail({ code: '42501' });
  return result.data;
}

export async function deleteComment(client: StudioPulseClient, id: string): Promise<void> {
  const { error, count } = await client.from('task_comments').delete({ count: 'exact' }).eq('id', id);
  if (error) fail(error);
  if (count === 0) fail({ code: '42501' });
}

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------

/** The most recently updated first. Read in creation order: every save changes `updated_at`. */
export async function listNotes(client: StudioPulseClient, workspaceId: string): Promise<Note[]> {
  const rows = await listAll((from, to) =>
    client.from('notes').select('*').eq('workspace_id', workspaceId).order('created_at').order('id').range(from, to),
  );
  return rows.sort(compareNotes);
}

export function createNote(
  client: StudioPulseClient,
  input: Pick<TablesInsert<'notes'>, 'workspace_id' | 'title' | 'body' | 'visibility' | 'project_id'>,
  userId: string,
  id = newId(),
): Promise<Note> {
  return insertOnce(
    () => client.from('notes').insert({ ...input, id, owner_id: userId }).select('*').single(),
    () => client.from('notes').select('*').eq('id', id).single(),
  );
}

/** notes.body holds at most this many bytes of UTF-8 (`octet_length`). */
export const NOTE_BODY_MAX_BYTES = 1_000_000;

function utf8Bytes(text: string): number {
  // A UTF-16 code unit takes at most 3 bytes in UTF-8: short text needs no encoding to tell.
  return text.length * 3 <= NOTE_BODY_MAX_BYTES ? text.length : new TextEncoder().encode(text).length;
}

/** The autosave's save: only on top of `baseVersion`. */
export async function saveNoteText(client: StudioPulseClient, id: string, draft: NoteDraft, baseVersion: number): Promise<SaveOutcome> {
  if (utf8Bytes(draft.body) > NOTE_BODY_MAX_BYTES) {
    throw new ProblemError({ kind: 'invalid', message: 'This note is longer than 1 MB. Shorten it to save it; your text is kept on this device.' });
  }
  const row = await client
    .from('notes')
    .update({ title: draft.title, body: draft.body })
    .eq('id', id)
    .eq('version', baseVersion)
    .select('version')
    .maybeSingle();
  if (row.error) fail(row.error);
  if (row.data) return { kind: 'saved', version: row.data.version };
  const current = await client.from('notes').select('title, body, version, owner_id, visibility').eq('id', id).maybeSingle();
  if (current.error) fail(current.error);
  if (!current.data) return { kind: 'gone' };
  if (current.data.version === baseVersion) {
    // Readable, same version, but not updatable: it was made private by its owner.
    return { kind: 'gone' };
  }
  if (current.data.title === draft.title && current.data.body === draft.body) {
    // The server already has this text: an earlier attempt landed but its response was lost
    // (this is the retry). Not someone else's save.
    return { kind: 'saved', version: current.data.version };
  }
  return { kind: 'conflict', server: { draft: { title: current.data.title, body: current.data.body }, version: current.data.version } };
}

export type NoteMetaPatch = Pick<TablesUpdate<'notes'>, 'visibility' | 'project_id' | 'pinned' | 'archived_at'>;

export async function updateNoteMeta(client: StudioPulseClient, id: string, version: number, patch: NoteMetaPatch): Promise<Versioned<Note>> {
  const row = await client.from('notes').update(patch).eq('id', id).eq('version', version).select('*').maybeSingle();
  if (row.error) fail(row.error);
  if (row.data) return { status: 'saved', row: row.data };
  const current = await client.from('notes').select('*').eq('id', id).maybeSingle();
  if (current.error) fail(current.error);
  return settleUnmatched(current.data, version);
}

export async function deleteNote(client: StudioPulseClient, id: string): Promise<void> {
  const { error, count } = await client.from('notes').delete({ count: 'exact' }).eq('id', id);
  if (error) fail(error);
  if (count === 0) fail({ code: '42501' });
}

// ---------------------------------------------------------------------------------------------
// Tracked time
// ---------------------------------------------------------------------------------------------

/** The caller's own synced intervals in a range, newest first (all of them, or at most `limit`). */
export async function listMyTime(
  client: StudioPulseClient,
  input: { workspaceId: string; userId: string; fromIso: string; toIso: string; limit?: number },
): Promise<TimeEntry[]> {
  return (await listAll(
    (from, to) =>
      client
        .from('time_entries')
        .select(TIME_ENTRY_COLUMNS)
        .eq('workspace_id', input.workspaceId)
        .eq('user_id', input.userId)
        .gte('started_at', input.fromIso)
        .lt('started_at', input.toIso)
        .order('started_at', { ascending: false })
        .order('id')
        .range(from, to),
    input.limit,
  )) as TimeEntry[];
}

/** Time attributed to a project (or a task), newest first: all that RLS lets this user read. */
export async function listAttributedTime(
  client: StudioPulseClient,
  workspaceId: string,
  by: { projectId: string } | { taskId: string },
): Promise<TimeEntry[]> {
  return (await listAll((from, to) => {
    const query = client.from('time_entries').select(TIME_ENTRY_COLUMNS).eq('workspace_id', workspaceId);
    return ('projectId' in by ? query.eq('project_id', by.projectId) : query.eq('task_id', by.taskId))
      .order('started_at', { ascending: false })
      .order('id')
      .range(from, to);
  })) as TimeEntry[];
}

/** Attribute (or clear) the caller's entries; returns how many changed. */
export async function attributeTime(
  client: StudioPulseClient,
  ids: readonly string[],
  target: { projectId: string | null; taskId: string | null },
): Promise<number> {
  let changed = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    changed += must(
      await client.rpc('set_time_entry_attribution', {
        p_entry_ids: chunk,
        p_project_id: target.projectId,
        p_task_id: target.taskId,
      }),
    );
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------------------------

/** A report's arguments (`analytics_time_summary`), camelCase. Days are local to `timeZone`. */
export interface AnalyticsSummaryParams {
  readonly workspaceId: string;
  /** Last local day, inclusive (`YYYY-MM-DD`). */
  readonly toDay: string;
  /** IANA name, e.g. `Europe/London`, or `UTC`. */
  readonly timeZone: string;
  /** First local day, inclusive. Null or omitted: from the local day of the first session in scope. */
  readonly fromDay?: string | null;
  /** Period rows by day (the database default), ISO week or month. */
  readonly bucket?: ReportBucket | null;
  /** Only these people's time. Null or omitted: everyone whose time the caller can read. */
  readonly userIds?: readonly string[] | null;
  /** Only this project's time. */
  readonly projectId?: string | null;
  /** Only time with no project and no task. Not together with `projectId`. */
  readonly unattributed?: boolean | null;
  /** Only this application's time. */
  readonly applicationId?: string | null;
}

type ReportArgs = FunctionArgs<'analytics_time_summary'>;
type ReportRecord = FunctionReturns<'analytics_time_summary'>[number];

/**
 * The function's arguments. Optional ones that are null or undefined are left out, so the call
 * names only the arguments it sets and the database defaults apply to the rest.
 */
export function reportArgs(params: AnalyticsSummaryParams): ReportArgs {
  const args: ReportArgs = { p_workspace_id: params.workspaceId, p_to: params.toDay, p_time_zone: params.timeZone };
  if (params.fromDay != null) args.p_from = params.fromDay;
  if (params.bucket != null) args.p_bucket = params.bucket;
  if (params.userIds != null) args.p_user_ids = [...params.userIds];
  if (params.projectId != null) args.p_project_id = params.projectId;
  if (params.unattributed != null) args.p_unattributed = params.unattributed;
  if (params.applicationId != null) args.p_application_id = params.applicationId;
  return args;
}

/** A row of the report, camelCase: the same shape as time-engine's `summarizeReport` rows. */
export function toReportRow(record: ReportRecord): ReportRow {
  return {
    dimension: record.dimension,
    bucketStart: record.bucket_start,
    userId: record.user_id,
    applicationId: record.application_id,
    applicationName: record.application_name,
    projectId: record.project_id,
    taskId: record.task_id,
    unattributed: record.unattributed,
    // bigint columns arrive as JSON numbers; Number() would also read one sent as a string.
    activeMs: Number(record.active_ms),
    idleMs: Number(record.idle_ms),
    entryCount: Number(record.entry_count),
    overlapMs: Number(record.overlap_ms),
    teammatesVisible: record.teammates_visible,
  };
}

/**
 * One report, aggregated on the server. The function is security invoker, so the caller's
 * row-level security decides whose time counts. Every row is returned: the result is read in
 * pages with `.range()` until a short page, because PostgREST cuts a function's result at max
 * rows like any list. Each page runs the report again, so pages read while sessions sync are not
 * one snapshot. Errors go through `toReportProblem` (timeouts and a database without migration
 * 10 are explained).
 */
export async function analyticsSummary(client: StudioPulseClient, params: AnalyticsSummaryParams): Promise<ReportRow[]> {
  const args = reportArgs(params);
  const rows = await listAll<ReportRecord>(async (from, to) => {
    const page = await client.rpc('analytics_time_summary', args).range(from, to);
    if (page.error) throw new ProblemError(toReportProblem(page.error));
    return { data: page.data, error: null };
  });
  const report = rows.map(toReportRow);
  REPORT_READ_AT.set(report, Date.now());
  return report;
}

/**
 * When each report was read, kept beside the rows themselves: every page that caches a report
 * (Analytics, Project Insights) shares the cache key, so "Updated HH:MM" is true whichever page
 * read it, and after leaving a page and coming back to a cached report.
 */
const REPORT_READ_AT = new WeakMap<object, number>();

/** When `analyticsSummary` returned these rows (epoch ms), or null for rows it did not return. */
export function reportReadAt(rows: readonly ReportRow[]): number | null {
  return REPORT_READ_AT.get(rows) ?? null;
}

/** One of the caller's own sessions (a synced time entry) as the Analytics session list shows it. */
export type MySession = Pick<
  Tables<'time_entries'>,
  'id' | 'started_at' | 'ended_at' | 'application_id' | 'application_name' | 'kind' | 'active_ms' | 'idle_ms' | 'project_id' | 'task_id'
>;

export const MY_SESSION_COLUMNS =
  'id, started_at, ended_at, application_id, application_name, kind, active_ms, idle_ms, project_id, task_id';

/** No time entry lasts longer (the table's CHECK), so a session overlapping a range started at most this long before it. */
export const MAX_SESSION_MS = 744 * 3_600_000;

export interface MySessionsQuery {
  readonly workspaceId: string;
  /** The signed-in user: these reads only ever ask for the caller's own sessions. */
  readonly userId: string;
  /** Range start (inclusive), an ISO instant. */
  readonly startIso: string;
  /** Range end (exclusive), an ISO instant. */
  readonly endIso: string;
  /**
   * Only sessions with no project and no task: the page's "Unattributed" project filter or the
   * card's "Only unattributed" toggle (the report's `p_unattributed`).
   */
  readonly unattributedOnly?: boolean;
  /** Only sessions on this project (the page's project filter; the report's `p_project_id`). */
  readonly projectId?: string;
  /** Only sessions in this application (the page's application filter; the report's `p_application_id`). */
  readonly applicationId?: string;
}

export interface MySessionsPageQuery extends MySessionsQuery {
  /**
   * The last session of the previous page, its `started_at` and `id` exactly as returned: the page
   * continues after it (keyset paging, newest first). Omitted or null for the first page.
   */
  readonly before?: { readonly startedAt: string; readonly id: string } | null;
  /** Sessions per page, 1 to `PAGE_ROWS`. */
  readonly limit: number;
}

/** A value in PostgREST's `or=(…)` syntax, quoted so its `:` `.` and `+` are read literally. */
function orValue(value: string): string {
  return `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

/**
 * One page of the caller's own sessions overlapping [startIso, endIso), newest first
 * (`started_at` desc, then `id` desc). Sessions are whole, not clipped to the range. The lower
 * bound on `started_at` (no session lasts longer than 744 h) keeps every page an index range scan
 * on (user_id, started_at) instead of a walk through all older history.
 */
export async function listMySessions(client: StudioPulseClient, input: MySessionsPageQuery): Promise<MySession[]> {
  const lowerIso = new Date(Date.parse(input.startIso) - MAX_SESSION_MS).toISOString();
  const limit = Math.max(1, Math.min(PAGE_ROWS, Math.floor(input.limit)));
  let query = client
    .from('time_entries')
    .select(MY_SESSION_COLUMNS)
    .eq('workspace_id', input.workspaceId)
    .eq('user_id', input.userId)
    .lt('started_at', input.endIso)
    .gt('ended_at', input.startIso)
    .gte('started_at', lowerIso);
  // The page's filters, as the report applies them (plain column checks), so the list and the
  // figures around it agree. A project and "unattributed" together match nothing, as in the report.
  if (input.projectId !== undefined) query = query.eq('project_id', input.projectId);
  if (input.applicationId !== undefined) query = query.eq('application_id', input.applicationId);
  if (input.unattributedOnly) query = query.is('project_id', null).is('task_id', null);
  if (input.before) {
    const startedAt = orValue(input.before.startedAt);
    query = query.or(`started_at.lt.${startedAt},and(started_at.eq.${startedAt},id.lt.${orValue(input.before.id)})`);
  }
  const rows = list(await query.order('started_at', { ascending: false }).order('id', { ascending: false }).limit(limit));
  return rows as MySession[];
}

/**
 * The caller's sessions in the range, newest first, read page by page (keyset) up to `max`.
 * `truncated` says there were more than `max`.
 */
export async function listAllMySessions(
  client: StudioPulseClient,
  input: MySessionsQuery,
  max: number,
): Promise<{ sessions: MySession[]; truncated: boolean }> {
  const sessions: MySession[] = [];
  let before: MySessionsPageQuery['before'] = null;
  // One more than `max` tells a range of exactly `max` sessions from a longer one.
  for (let wanted = max + 1; wanted > 0; ) {
    const limit = Math.min(PAGE_ROWS, wanted);
    const page = await listMySessions(client, { ...input, before, limit });
    sessions.push(...page);
    wanted -= page.length;
    const last = page[page.length - 1];
    if (!last || page.length < limit) break;
    before = { startedAt: last.started_at, id: last.id };
  }
  const truncated = sessions.length > max;
  return { sessions: truncated ? sessions.slice(0, max) : sessions, truncated };
}

/** The "My sessions" export reads at most this many sessions. */
export const MY_SESSIONS_EXPORT_MAX = 50_000;

/** Every session in the range for the "My sessions" export, or a clear refusal past `MY_SESSIONS_EXPORT_MAX`. */
export async function listMySessionsForExport(client: StudioPulseClient, input: MySessionsQuery): Promise<MySession[]> {
  const { sessions, truncated } = await listAllMySessions(client, input, MY_SESSIONS_EXPORT_MAX);
  if (truncated) {
    throw new ProblemError({
      kind: 'invalid',
      message: 'This range has more than 50,000 sessions, too many for one export. Choose a shorter range.',
    });
  }
  return sessions;
}

export type { Tables };
