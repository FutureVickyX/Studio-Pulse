/**
 * The signed-in user's current workspace and the data hooks the views use. Every cache key is
 * scoped to the workspace (`ws:<id>:…`), so switching workspaces never shows another
 * workspace's data, and sign-out clears the cache entirely.
 */

import { createContext, useCallback, useContext } from 'react';
import type { StudioPulseClient } from '@studio-pulse/database';

import * as api from '../lib/api';
import { withCreatedNote, withCreatedProject } from '../lib/model';
import type { Member, Note, Project, Subtask, Task, TaskComment, WorkspaceInfo } from '../lib/model';
import type { Navigation } from '../lib/router';
import { invalidate, readQueryData, setQueryData, useQuery } from '../lib/store';
import type { QueryResult } from '../lib/store';
import type { TimeEntry } from '../lib/time';
import type { WatchedTable } from '../lib/realtime';

export interface SignedInUser {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string;
}

export interface WorkspaceContextValue {
  readonly client: StudioPulseClient;
  readonly user: SignedInUser;
  readonly workspace: WorkspaceInfo;
  readonly workspaces: readonly WorkspaceInfo[];
  readonly members: readonly Member[];
  readonly nav: Navigation;
  memberName: (userId: string | null | undefined) => string;
  selectWorkspace: (id: string) => void;
  reloadWorkspaces: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace outside the workspace');
  return value;
}

// ---------------------------------------------------------------------------------------------
// Keys and invalidation
// ---------------------------------------------------------------------------------------------

export const keys = {
  members: (ws: string) => `ws:${ws}:members`,
  projects: (ws: string) => `ws:${ws}:projects`,
  tasks: (ws: string) => `ws:${ws}:tasks`,
  notes: (ws: string) => `ws:${ws}:notes`,
  subtasks: (ws: string, taskId: string) => `ws:${ws}:task:${taskId}:subtasks`,
  comments: (ws: string, taskId: string) => `ws:${ws}:task:${taskId}:comments`,
  myTime: (ws: string, from: string, to: string) => `ws:${ws}:time:mine:${from}:${to}`,
  projectTime: (ws: string, projectId: string) => `ws:${ws}:time:project:${projectId}`,
  taskTime: (ws: string, taskId: string) => `ws:${ws}:time:task:${taskId}`,
  profiles: (ws: string, ids: string) => `ws:${ws}:profiles:${ids}`,
};

/** After a change (ours or a teammate's): refetch what shows that table. */
export function refreshTable(workspaceId: string, table: WatchedTable | 'time' | 'members' | 'all'): void {
  const ws = `ws:${workspaceId}:`;
  switch (table) {
    case 'projects':
      invalidate(`${ws}projects`);
      break;
    case 'tasks':
      invalidate(`${ws}tasks`);
      // Moving a task to another project moves its tracked time with it (tasks_move_time), so
      // project time and analytics totals (`time:analytics:…`) can change too.
      invalidate(`${ws}time:`);
      break;
    case 'task_subtasks':
    case 'task_comments':
      invalidate(`${ws}task:`);
      break;
    case 'notes':
      invalidate(`${ws}notes`);
      break;
    case 'time':
      invalidate(`${ws}time:`);
      break;
    case 'members':
      invalidate(`${ws}members`);
      break;
    case 'all':
      invalidate(ws);
      break;
  }
}

/**
 * A note this client just created goes into the cached list at once (`withCreatedNote`), so a view
 * that opens it right away finds it instead of "not available" until the refetch lands.
 */
export function cacheCreatedNote(workspaceId: string, note: Note): void {
  const key = keys.notes(workspaceId);
  const next = withCreatedNote(readQueryData<Note[]>(key), note);
  if (next) setQueryData<Note[]>(key, () => next);
}

/** The same for a project (`withCreatedProject`), so its page opens instead of "Project not found". */
export function cacheCreatedProject(workspaceId: string, project: Project): void {
  const key = keys.projects(workspaceId);
  const next = withCreatedProject(readQueryData<Project[]>(key), project);
  if (next) setQueryData<Project[]>(key, () => next);
}

// ---------------------------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------------------------

export function useMembersQuery(client: StudioPulseClient, workspaceId: string | null): QueryResult<Member[]> {
  return useQuery(workspaceId ? keys.members(workspaceId) : null, () => api.listMembers(client, workspaceId ?? ''));
}

export function useProjects(): QueryResult<Project[]> {
  const { client, workspace } = useWorkspace();
  return useQuery(keys.projects(workspace.id), () => api.listProjects(client, workspace.id));
}

export function useTasks(): QueryResult<Task[]> {
  const { client, workspace } = useWorkspace();
  return useQuery(keys.tasks(workspace.id), () => api.listTasks(client, workspace.id));
}

export function useNotes(): QueryResult<Note[]> {
  const { client, workspace } = useWorkspace();
  return useQuery(keys.notes(workspace.id), () => api.listNotes(client, workspace.id));
}

export function useSubtasks(taskId: string): QueryResult<Subtask[]> {
  const { client, workspace } = useWorkspace();
  return useQuery(keys.subtasks(workspace.id, taskId), () => api.listSubtasks(client, taskId));
}

export function useComments(taskId: string): QueryResult<TaskComment[]> {
  const { client, workspace } = useWorkspace();
  return useQuery(keys.comments(workspace.id, taskId), () => api.listComments(client, taskId));
}

export function useMyTime(fromIso: string, toIso: string): QueryResult<TimeEntry[]> {
  const { client, workspace, user } = useWorkspace();
  return useQuery(keys.myTime(workspace.id, fromIso, toIso), () =>
    api.listMyTime(client, { workspaceId: workspace.id, userId: user.id, fromIso, toIso }),
  );
}

export function useAttributedTime(by: { projectId: string } | { taskId: string }): QueryResult<TimeEntry[]> {
  const { client, workspace } = useWorkspace();
  const key = 'projectId' in by ? keys.projectTime(workspace.id, by.projectId) : keys.taskTime(workspace.id, by.taskId);
  return useQuery(key, () => api.listAttributedTime(client, workspace.id, by));
}

/** Names for people who left the workspace but still appear on older work. */
export function useFormerNames(ids: readonly string[]): QueryResult<Map<string, string>> {
  const { client, workspace } = useWorkspace();
  const sorted = [...new Set(ids)].sort();
  return useQuery(sorted.length ? keys.profiles(workspace.id, sorted.join(',')) : null, () => api.listProfiles(client, sorted));
}

/** Run a mutation, then refresh what it touched. */
export function useRefresh(): (table: WatchedTable | 'time' | 'members' | 'all') => void {
  const { workspace } = useWorkspace();
  return useCallback((table) => refreshTable(workspace.id, table), [workspace.id]);
}
