/**
 * workspaces: created only through create_workspace (caller becomes owner); members read;
 * owners/admins rename; only owners delete; time_entry_visibility changes only through
 * set_time_entry_visibility, and only for owners.
 */

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_DENIED,
  buildWorld,
  createNote,
  createProject,
  createTask,
  createWorkspace,
  entry,
  fails,
  membership,
  newUser,
  ok,
  only,
  setVisibility,
  sync,
  useDatabase,
  visibleIds,
} from './fixtures';

const db = useDatabase();

async function workspaceName(id: string): Promise<string> {
  const rows = await db().admin<{ name: string }>(`select name from public.workspaces where id = $1`, [id]);
  return only(rows).name;
}

async function visibility(id: string): Promise<string> {
  const rows = await db().admin<{ v: string }>(
    `select time_entry_visibility::text as v from public.workspaces where id = $1`,
    [id],
  );
  return only(rows).v;
}

describe('create_workspace', () => {
  it('creates the workspace with the caller as its only (owner) member', async () => {
    const owner = await newUser(db(), 'owner');
    const rows = ok(
      await db().query<{ id: string; name: string; created_by: string; time_entry_visibility: string }>(
        owner,
        `select id, name, created_by, time_entry_visibility::text from public.create_workspace('  Night Shift  ')`,
      ),
    );
    const workspace = only(rows);
    expect(workspace.name).toBe('Night Shift');
    expect(workspace.created_by).toBe(owner.id);
    expect(workspace.time_entry_visibility).toBe('private');
    expect(await membership(db(), workspace.id, owner)).toEqual({ role: 'owner', status: 'active' });
    const roster = await db().admin(`select user_id from public.workspace_members where workspace_id = $1`, [
      workspace.id,
    ]);
    expect(roster).toEqual([{ user_id: owner.id }]);

    const mine = ok(
      await db().query(owner, `select workspace_id, name, role::text, time_entry_visibility::text from public.my_workspaces()`),
    );
    expect(mine).toEqual([
      { workspace_id: workspace.id, name: 'Night Shift', role: 'owner', time_entry_visibility: 'private' },
    ]);
  });

  it('validates the name', async () => {
    const owner = await newUser(db(), 'owner');
    fails(await db().query(owner, `select public.create_workspace('   ')`), '23514');
    fails(await db().query(owner, `select public.create_workspace($1)`, ['w'.repeat(81)]), '23514');
    fails(await db().query(owner, `select public.create_workspace(null)`), '23502');
    expect(ok(await db().query(owner, `select * from public.my_workspaces()`))).toEqual([]);
  });

  it('is the only way in: direct INSERT is denied, even with created_by = self', async () => {
    const user = await newUser(db(), 'direct');
    fails(
      await db().affected(user, `insert into public.workspaces (name, created_by) values ('x', $1)`, [user.id]),
      '42501',
      PERMISSION_DENIED,
    );
    fails(await db().affected(user, `insert into public.workspaces (name) values ('x')`), '42501', PERMISSION_DENIED);
  });
});

describe('reading workspaces', () => {
  it('members read their workspaces; nobody reads anyone else’s', async () => {
    const w = await buildWorld(db());
    for (const user of [w.alice, w.bob, w.carol, w.dave]) {
      expect(await visibleIds(db(), user, 'workspaces'), user.label).toEqual([w.wsA]);
    }
    for (const user of [w.erin, w.frank]) {
      expect(await visibleIds(db(), user, 'workspaces'), user.label).toEqual([w.wsB]);
    }
    expect(await visibleIds(db(), w.gina, 'workspaces')).toEqual([w.wsA, w.wsB].sort());
    expect(await visibleIds(db(), w.mallory, 'workspaces')).toEqual([]);
    expect(await visibleIds(db(), w.erin, 'workspaces', 'id = $1', [w.wsA])).toEqual([]);
  });

  it('my_workspaces lists active memberships with role and visibility', async () => {
    const w = await buildWorld(db());
    const rows = ok(
      await db().query<{ workspace_id: string; role: string }>(
        w.gina,
        `select workspace_id, role::text from public.my_workspaces() order by name`,
      ),
    );
    expect(rows).toEqual([
      { workspace_id: w.wsA, role: 'member' },
      { workspace_id: w.wsB, role: 'admin' },
    ]);
    expect(ok(await db().query(w.mallory, `select * from public.my_workspaces()`))).toEqual([]);
  });
});

describe('renaming', () => {
  it('owners and admins rename', async () => {
    const w = await buildWorld(db());
    expect(ok(await db().affected(w.alice, `update public.workspaces set name = 'A1' where id = $1`, [w.wsA]))).toBe(1);
    expect(await workspaceName(w.wsA)).toBe('A1');
    expect(ok(await db().affected(w.bob, `update public.workspaces set name = 'A2' where id = $1`, [w.wsA]))).toBe(1);
    expect(await workspaceName(w.wsA)).toBe('A2');
  });

  it('members, admins of other workspaces and strangers cannot', async () => {
    const w = await buildWorld(db());
    // gina is an admin of B, but only a member of A.
    for (const user of [w.carol, w.gina, w.erin, w.frank, w.mallory]) {
      expect(
        ok(await db().affected(user, `update public.workspaces set name = 'hacked' where id = $1`, [w.wsA])),
        user.label,
      ).toBe(0);
    }
    expect(await workspaceName(w.wsA)).toBe('Studio A');
  });

  it('validates the new name', async () => {
    const w = await buildWorld(db());
    fails(await db().affected(w.alice, `update public.workspaces set name = ' ' where id = $1`, [w.wsA]), '23514');
  });

  it('allows no other column, even for the owner', async () => {
    const w = await buildWorld(db());
    for (const assignment of [
      `time_entry_visibility = 'admins'`,
      `created_by = '${w.carol.id}'`,
      `id = gen_random_uuid()`,
      `created_at = now()`,
      `updated_at = now()`,
    ]) {
      fails(
        await db().affected(w.alice, `update public.workspaces set ${assignment} where id = $1`, [w.wsA]),
        '42501',
        PERMISSION_DENIED,
      );
    }
    expect(await visibility(w.wsA)).toBe('private');
  });
});

describe('set_time_entry_visibility', () => {
  it('only the owner changes it', async () => {
    const w = await buildWorld(db());
    for (const user of [w.bob, w.carol, w.gina, w.erin, w.mallory]) {
      fails(await setVisibility(db(), user, w.wsA, 'admins'), '42501');
    }
    expect(await visibility(w.wsA)).toBe('private');
    ok(await setVisibility(db(), w.alice, w.wsA, 'admins'));
    expect(await visibility(w.wsA)).toBe('admins');
    ok(await setVisibility(db(), w.alice, w.wsA, 'private'));
    expect(await visibility(w.wsA)).toBe('private');
    // An owner of B has no say over A.
    fails(await setVisibility(db(), w.erin, w.wsA, 'admins'), '42501');
  });

  it('a co-owner (granted through set_member_role) may change it', async () => {
    const w = await buildWorld(db());
    ok(await db().query(w.alice, `select public.set_member_role($1, $2, 'owner')`, [w.wsA, w.bob.id]));
    ok(await setVisibility(db(), w.bob, w.wsA, 'admins'));
    expect(await visibility(w.wsA)).toBe('admins');
  });
});

describe('deleting', () => {
  it('admins, members and strangers cannot delete', async () => {
    const w = await buildWorld(db());
    for (const user of [w.bob, w.carol, w.gina, w.erin, w.mallory]) {
      expect(ok(await db().affected(user, `delete from public.workspaces where id = $1`, [w.wsA])), user.label).toBe(0);
    }
    expect(await workspaceName(w.wsA)).toBe('Studio A');
  });

  it('the owner deletes a populated workspace and everything in it, nothing else', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    const task = await createTask(db(), w.carol, w.wsA, { projectId: project, assigneeId: w.dave.id });
    await createNote(db(), w.carol, w.wsA, 'workspace');
    await createNote(db(), w.carol, w.wsA, 'private');
    ok(await sync(db(), w.carol, w.wsA, [entry({ projectId: project, taskId: task })]));
    ok(await sync(db(), w.frank, w.wsB, [entry()]));
    await createProject(db(), w.erin, w.wsB);

    expect(ok(await db().affected(w.alice, `delete from public.workspaces where id = $1`, [w.wsA]))).toBe(1);

    const counts = only(
      await db().admin<Record<string, number>>(
        `select
           (select count(*)::int from public.workspace_members where workspace_id = $1) as members,
           (select count(*)::int from public.workspace_invitations where workspace_id = $1) as invitations,
           (select count(*)::int from public.projects where workspace_id = $1) as projects,
           (select count(*)::int from public.tasks where workspace_id = $1) as tasks,
           (select count(*)::int from public.notes where workspace_id = $1) as notes,
           (select count(*)::int from public.time_entries where workspace_id = $1) as entries,
           (select count(*)::int from public.workspace_members where workspace_id = $2) as b_members,
           (select count(*)::int from public.projects where workspace_id = $2) as b_projects,
           (select count(*)::int from public.time_entries where workspace_id = $2) as b_entries,
           (select count(*)::int from public.profiles where id = $3) as carol_profile`,
        [w.wsA, w.wsB, w.carol.id],
      ),
    );
    expect(counts).toEqual({
      members: 0,
      invitations: 0,
      projects: 0,
      tasks: 0,
      notes: 0,
      entries: 0,
      b_members: 3,
      b_projects: 1,
      b_entries: 1,
      carol_profile: 1,
    });
    expect(ok(await db().query(w.carol, `select * from public.my_workspaces()`))).toEqual([]);
  });

  it('a new owner keeps working after creating several workspaces', async () => {
    const owner = await newUser(db(), 'multi');
    const first = await createWorkspace(db(), owner, 'One');
    const second = await createWorkspace(db(), owner, 'Two');
    expect(await visibleIds(db(), owner, 'workspaces')).toEqual([first, second].sort());
  });
});
