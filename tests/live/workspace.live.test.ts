/**
 * The workspace's data layer (apps/web/src/lib/api.ts, the code the web UI runs) against a REAL
 * Supabase project, as three confirmed throwaway users signed in with the publishable key:
 * `owner` creates a workspace and invites `member`; `outsider` belongs to none of it.
 *
 * Environment (tests/live/README.md):
 *   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY   public values
 *   SP_LIVE_USERS_FILE                       JSON {users:[{label:'a'|'b'|'c', email, password, id}]}
 * The provisioning operator deletes disposable workspaces and users after the run. Clients
 * intentionally have no workspace DELETE grant.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStudioPulseClient, validateSupabaseConfig } from '@studio-pulse/database';
import type { StudioPulseClient } from '@studio-pulse/database';

import * as api from '../../apps/web/src/lib/api';
import { ProblemError } from '../../apps/web/src/lib/errors';
import { totals } from '../../apps/web/src/lib/time';

interface LiveUser {
  label: string;
  email: string;
  password: string;
  id: string;
}

const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
const usersFile = process.env.SP_LIVE_USERS_FILE ?? '';
const configured = Boolean(url && key && usersFile);

async function signedIn(user: LiveUser): Promise<StudioPulseClient> {
  const client = createStudioPulseClient(validateSupabaseConfig(url, key));
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`sign-in failed for ${user.label}: ${error.message}`);
  return client;
}

async function problemOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemError) return error.problem.kind;
    throw error;
  }
  return 'none';
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe.skipIf(!configured)('workspace data layer on the real project', () => {
  let owner: StudioPulseClient;
  let member: StudioPulseClient;
  let outsider: StudioPulseClient;
  let users: Record<'owner' | 'member' | 'outsider', LiveUser>;
  let workspaceId = '';

  beforeAll(async () => {
    const list = (JSON.parse(readFileSync(usersFile, 'utf8')) as { users: LiveUser[] }).users;
    const pick = (label: string) => {
      const user = list.find((u) => u.label === label);
      if (!user) throw new Error(`no user ${label} in ${usersFile}`);
      return user;
    };
    users = { owner: pick('a'), member: pick('b'), outsider: pick('c') };
    // Each successful client remains available for sign-out if a later fixture sign-in fails.
    owner = await signedIn(users.owner);
    member = await signedIn(users.member);
    outsider = await signedIn(users.outsider);
    workspaceId = await api.createWorkspace(owner, `SP Live ${users.owner.email.split('@')[0]}`);
    const invitation = await api.createInvitation(owner, workspaceId, users.member.email, 'member');
    expect(await api.acceptInvitation(member, invitation.token)).toBe(workspaceId);
  });

  afterAll(async () => {
    // The provisioning operator removes this workspace and the disposable users. Clients have
    // no workspace DELETE grant; an unchecked delete here previously left a misleading cleanup.
    await Promise.all([owner, member, outsider].filter(Boolean).map((c) => c.auth.signOut({ scope: 'local' })));
  });

  it('lists the workspace and its members for members only', async () => {
    expect((await api.listMyWorkspaces(owner)).map((w) => [w.id, w.role])).toContainEqual([workspaceId, 'owner']);
    expect((await api.listMyWorkspaces(member)).map((w) => [w.id, w.role])).toContainEqual([workspaceId, 'member']);
    expect((await api.listMyWorkspaces(outsider)).map((w) => w.id)).not.toContain(workspaceId);
    const members = await api.listMembers(owner, workspaceId);
    expect(members.map((m) => m.userId).sort()).toEqual([users.owner.id, users.member.id].sort());
    expect(await api.listMembers(outsider, workspaceId)).toEqual([]);
  });

  it('projects: an owner creates and edits; a member cannot create; a stale edit is a conflict', async () => {
    const project = await api.createProject(
      owner,
      { workspace_id: workspaceId, name: '  Rebrand  ', description: 'Logo and guide', status: 'planning', lead_id: users.member.id, start_date: null, due_date: '2026-12-01' },
      users.owner.id,
    );
    expect(project).toMatchObject({ name: 'Rebrand', status: 'planning', lead_id: users.member.id, version: 1 });
    // Persisted (a fresh read, as after a reload).
    expect((await api.listProjects(member, workspaceId)).map((p) => p.id)).toContain(project.id);

    expect(
      await problemOf(api.createProject(member, { workspace_id: workspaceId, name: 'Mine', description: '', status: 'active', lead_id: null, start_date: null, due_date: null }, users.member.id)),
    ).toBe('permission');

    // The lead (a member) edits the project.
    const edited = await api.updateProject(member, project.id, project.version, { status: 'active' });
    expect(edited.status).toBe('saved');
    // A second edit based on the old version is a conflict, not an overwrite.
    const stale = await api.updateProject(owner, project.id, project.version, { name: 'Overwrite' });
    expect(stale.status).toBe('conflict');
    expect((await api.listProjects(owner, workspaceId)).find((p) => p.id === project.id)?.name).toBe('Rebrand');
    // Outsiders see nothing and change nothing.
    expect(await api.listProjects(outsider, workspaceId)).toEqual([]);
    expect(await problemOf(api.updateProject(outsider, project.id, 2, { name: 'Hijack' }))).toBe('notFound');
  });

  it('tasks: create, assign to members only, update, and a retried create is never duplicated', async () => {
    const task = await api.createTask(
      member,
      { workspace_id: workspaceId, title: 'Sketch logo', description: '', status: 'todo', priority: 'high', assignee_id: users.owner.id, project_id: null, due_date: '2026-11-01' },
      users.member.id,
    );
    expect(task).toMatchObject({ title: 'Sketch logo', assignee_id: users.owner.id, created_by: users.member.id });

    // Assigning to someone outside the workspace is refused by RLS.
    expect(await problemOf(api.updateTask(member, task.id, task.version, { assignee_id: users.outsider.id }))).toBe('permission');

    const moved = await api.updateTask(owner, task.id, task.version, { status: 'in_progress', priority: 'urgent', due_date: '2026-11-05' });
    expect(moved.status).toBe('saved');
    const reloaded = (await api.listTasks(member, workspaceId)).find((t) => t.id === task.id);
    expect(reloaded).toMatchObject({ status: 'in_progress', priority: 'urgent', due_date: '2026-11-05' });

    // A create whose response was lost: the retry carries the same id and returns the same row.
    const id = api.newId();
    const insert = () =>
      member.from('tasks').insert({ id, workspace_id: workspaceId, title: 'Once', created_by: users.member.id }).select('*').single();
    const existing = () => member.from('tasks').select('*').eq('id', id).single();
    const first = await api.insertOnce(insert, existing);
    const retry = await api.insertOnce(insert, existing);
    expect(retry.id).toBe(first.id);
    const { count } = await member.from('tasks').select('id', { count: 'exact', head: true }).eq('title', 'Once');
    expect(count).toBe(1);
  });

  it('checklists and comments follow the task permissions', async () => {
    const task = await api.createTask(
      owner,
      { workspace_id: workspaceId, title: 'Guide', description: '', status: 'todo', priority: 'normal', assignee_id: users.member.id, project_id: null, due_date: null },
      users.owner.id,
    );
    const step = await api.addSubtask(member, { workspaceId, taskId: task.id, title: 'Colours', position: 0 }, users.member.id);
    expect((await api.updateSubtask(owner, step.id, { done: true })).done).toBe(true);
    expect(await problemOf(api.addSubtask(outsider, { workspaceId, taskId: task.id, title: 'x', position: 1 }, users.outsider.id))).toBe('permission');

    const comment = await api.addComment(member, { workspaceId, taskId: task.id, body: 'First pass ready' }, users.member.id);
    expect((await api.editComment(member, comment.id, 'First pass ready for review')).edited_at).not.toBeNull();
    expect(await problemOf(api.editComment(owner, comment.id, 'not mine'))).toBe('permission');
    expect((await api.listComments(owner, task.id)).map((c) => c.body)).toEqual(['First pass ready for review']);
    expect(await api.listComments(outsider, task.id)).toEqual([]);
  });

  it('notes: private stays private; shared is editable by members; a stale save is a conflict', async () => {
    const secret = await api.createNote(member, { workspace_id: workspaceId, title: 'Mine', body: 'private', visibility: 'private', project_id: null }, users.member.id);
    expect((await api.listNotes(owner, workspaceId)).map((n) => n.id)).not.toContain(secret.id);
    expect(await api.saveNoteText(owner, secret.id, { title: 'x', body: 'x' }, secret.version)).toEqual({ kind: 'gone' });

    const shared = await api.createNote(member, { workspace_id: workspaceId, title: 'Brief', body: 'v1', visibility: 'workspace', project_id: null }, users.member.id);
    const ownerSave = await api.saveNoteText(owner, shared.id, { title: 'Brief', body: 'owner v2' }, shared.version);
    expect(ownerSave).toEqual({ kind: 'saved', version: shared.version + 1 });
    // The member still has version 1: their save must not overwrite the owner's.
    const memberSave = await api.saveNoteText(member, shared.id, { title: 'Brief', body: 'member v2' }, shared.version);
    expect(memberSave).toMatchObject({ kind: 'conflict', server: { draft: { body: 'owner v2' }, version: shared.version + 1 } });
    // Only the owner changes sharing.
    expect(await problemOf(api.updateNoteMeta(owner, shared.id, shared.version + 1, { visibility: 'private' }))).toBe('permission');
    expect(await api.listNotes(outsider, workspaceId)).toEqual([]);
  });

  it('time: synced sessions are attributed explicitly; archiving keeps them; totals count each once', async () => {
    const project = await api.createProject(
      owner,
      { workspace_id: workspaceId, name: 'Motion', description: '', status: 'active', lead_id: null, start_date: null, due_date: null },
      users.owner.id,
    );
    const task = await api.createTask(
      owner,
      { workspace_id: workspaceId, title: 'Animatic', description: '', status: 'todo', priority: 'normal', assignee_id: null, project_id: project.id, due_date: null },
      users.owner.id,
    );
    // What the desktop uploads (sync_time_entries).
    const now = Date.now() - 3_600_000;
    const entries = [0, 1, 2].map((i) => ({
      id: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      applicationId: 'blender',
      applicationName: 'Blender',
      kind: 'active',
      startedAt: iso(now + i * 600_000),
      endedAt: iso(now + i * 600_000 + 300_000),
      activeMs: 300_000,
      idleMs: 0,
      endReason: 'appSwitch',
      revision: 1,
      recordedAt: iso(now + i * 600_000 + 301_000),
    }));
    const synced = await owner.rpc('sync_time_entries', { p_workspace_id: workspaceId, p_entries: entries });
    expect(synced.error).toBeNull();

    const mine = await api.listMyTime(owner, { workspaceId, userId: users.owner.id, fromIso: iso(now - 1), toIso: iso(now + 3_600_000) });
    expect(mine).toHaveLength(3);
    expect(await api.attributeTime(owner, mine.slice(0, 2).map((e) => e.id), { projectId: project.id, taskId: task.id })).toBe(2);
    // Nobody else attributes my sessions.
    expect(await api.attributeTime(member, [mine[2]!.id], { projectId: project.id, taskId: null })).toBe(0);

    const onProject = await api.listAttributedTime(owner, workspaceId, { projectId: project.id });
    expect(totals(onProject)).toMatchObject({ activeMs: 600_000, entries: 2 });
    // A retried upload adds nothing.
    await owner.rpc('sync_time_entries', { p_workspace_id: workspaceId, p_entries: entries });
    expect(totals(await api.listAttributedTime(owner, workspaceId, { projectId: project.id })).entries).toBe(2);

    // Archiving keeps the history and refuses new time.
    const archived = await api.updateProject(owner, project.id, project.version, { status: 'archived' });
    expect(archived.status).toBe('saved');
    expect(totals(await api.listAttributedTime(owner, workspaceId, { projectId: project.id })).activeMs).toBe(600_000);
    expect(await problemOf(api.attributeTime(owner, [mine[2]!.id], { projectId: project.id, taskId: null }))).toBe('invalid');
    // With tracked time attached, the project and task can only be archived, not deleted.
    expect(await problemOf(api.deleteTask(owner, task.id))).toBe('blocked');
    expect(await problemOf(api.deleteProject(owner, project.id))).toBe('blocked');
  });

  it('realtime: teammates get workspace changes, never someone’s private note', async () => {
    const seen: string[] = [];
    const channel = owner
      .channel(`live-test:${workspaceId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tasks', filter: `workspace_id=eq.${workspaceId}` }, (p) =>
        seen.push(`task:${(p.new as { title: string }).title}`),
      )
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notes', filter: `workspace_id=eq.${workspaceId}` }, (p) =>
        seen.push(`note:${(p.new as { title: string }).title}`),
      );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('realtime did not subscribe')), 20_000);
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    // Let the subscription settle before writing.
    await new Promise((r) => setTimeout(r, 1500));
    await api.createNote(member, { workspace_id: workspaceId, title: 'RT private', body: '', visibility: 'private', project_id: null }, users.member.id);
    await api.createNote(member, { workspace_id: workspaceId, title: 'RT shared', body: '', visibility: 'workspace', project_id: null }, users.member.id);
    await api.createTask(
      member,
      { workspace_id: workspaceId, title: 'RT task', description: '', status: 'inbox', priority: 'normal', assignee_id: null, project_id: null, due_date: null },
      users.member.id,
    );
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(seen.includes('task:RT task') && seen.includes('note:RT shared'))) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 1500)); // time for a stray private event to show up
    await owner.removeChannel(channel);
    expect(seen).toContain('task:RT task');
    expect(seen).toContain('note:RT shared');
    expect(seen).not.toContain('note:RT private');
  });
});
