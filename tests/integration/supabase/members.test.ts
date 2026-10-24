/**
 * workspace_members: the roster is readable by members only, and it changes only through the
 * RPCs (create_workspace, accept_invitation, set_member_role, remove_member). Removed members
 * lose access to the workspace immediately.
 */

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_DENIED,
  addMember,
  buildWorld,
  createNote,
  createProject,
  createTask,
  entry,
  fails,
  invite,
  membership,
  ok,
  removeMember,
  setMemberRole,
  sync,
  useDatabase,
  visibleIds,
} from './fixtures';
import type { World } from './fixtures';
import type { TestUser } from './harness';

const db = useDatabase();

async function roster(who: TestUser, workspaceId: string): Promise<string[]> {
  const rows = ok(
    await db().query<{ user_id: string }>(
      who,
      `select user_id from public.workspace_members where workspace_id = $1`,
      [workspaceId],
    ),
  );
  return rows.map((row) => row.user_id).sort();
}

const ids = (...users: TestUser[]) => users.map((user) => user.id).sort();

describe('reading the roster', () => {
  it('members see the whole roster of their workspace', async () => {
    const w = await buildWorld(db());
    const everyoneA = ids(w.alice, w.bob, w.carol, w.dave, w.gina);
    for (const user of [w.alice, w.bob, w.carol, w.dave, w.gina]) {
      expect(await roster(user, w.wsA), user.label).toEqual(everyoneA);
    }
    expect(await roster(w.frank, w.wsB)).toEqual(ids(w.erin, w.gina, w.frank));
  });

  it('non-members see nothing', async () => {
    const w = await buildWorld(db());
    for (const user of [w.erin, w.frank, w.mallory]) {
      expect(await roster(user, w.wsA), user.label).toEqual([]);
    }
    const all = ok(await db().query(w.mallory, `select * from public.workspace_members`));
    expect(all).toEqual([]);
  });
});

describe('no direct writes, for anyone', () => {
  it('denies self-join and adding others', async () => {
    const w = await buildWorld(db());
    for (const [who, user, role] of [
      [w.mallory, w.mallory, 'owner'],
      [w.mallory, w.mallory, 'member'],
      [w.frank, w.frank, 'member'],
      [w.alice, w.mallory, 'member'],
    ] as Array<[TestUser, TestUser, string]>) {
      fails(
        await db().affected(
          who,
          `insert into public.workspace_members (workspace_id, user_id, role)
           values ($1, $2, $3::public.workspace_role)`,
          [w.wsA, user.id, role],
        ),
        '42501',
        PERMISSION_DENIED,
      );
    }
    expect(await membership(db(), w.wsA, w.mallory)).toBeUndefined();
  });

  it('denies self-promotion, role changes and status changes', async () => {
    const w = await buildWorld(db());
    for (const [who, target, assignment] of [
      [w.carol, w.carol, `role = 'owner'`],
      [w.bob, w.bob, `role = 'owner'`],
      [w.alice, w.carol, `role = 'admin'`],
      [w.alice, w.carol, `status = 'removed'`],
      [w.dave, w.dave, `status = 'active'`],
      [w.alice, w.carol, `workspace_id = '${w.wsB}'`],
    ] as Array<[TestUser, TestUser, string]>) {
      fails(
        await db().affected(
          who,
          `update public.workspace_members set ${assignment} where workspace_id = $1 and user_id = $2`,
          [w.wsA, target.id],
        ),
        '42501',
        PERMISSION_DENIED,
      );
    }
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'member', status: 'active' });
    expect(await membership(db(), w.wsA, w.bob)).toEqual({ role: 'admin', status: 'active' });
  });

  it('denies removing members or yourself by DELETE', async () => {
    const w = await buildWorld(db());
    for (const [who, target] of [
      [w.alice, w.carol],
      [w.bob, w.carol],
      [w.carol, w.carol],
      [w.alice, w.alice],
    ] as Array<[TestUser, TestUser]>) {
      fails(
        await db().affected(
          who,
          `delete from public.workspace_members where workspace_id = $1 and user_id = $2`,
          [w.wsA, target.id],
        ),
        '42501',
        PERMISSION_DENIED,
      );
    }
    expect(await roster(w.alice, w.wsA)).toHaveLength(5);
  });
});

describe('set_member_role', () => {
  it('owners change other members’ roles, including granting ownership', async () => {
    const w = await buildWorld(db());
    ok(await setMemberRole(db(), w.alice, w.wsA, w.carol, 'admin'));
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'admin', status: 'active' });
    ok(await setMemberRole(db(), w.alice, w.wsA, w.carol, 'member'));
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'member', status: 'active' });
    ok(await setMemberRole(db(), w.alice, w.wsA, w.bob, 'owner'));
    expect(await membership(db(), w.wsA, w.bob)).toEqual({ role: 'owner', status: 'active' });
    // The new co-owner may demote the original owner (there is still an owner: the caller).
    ok(await setMemberRole(db(), w.bob, w.wsA, w.alice, 'member'));
    expect(await membership(db(), w.wsA, w.alice)).toEqual({ role: 'member', status: 'active' });
  });

  it('owners cannot change their own role', async () => {
    const w = await buildWorld(db());
    for (const role of ['admin', 'member', 'owner'] as const) {
      fails(await setMemberRole(db(), w.alice, w.wsA, w.alice, role), '42501', /own role/);
    }
    expect(await membership(db(), w.wsA, w.alice)).toEqual({ role: 'owner', status: 'active' });
  });

  it('admins, members, other workspaces’ owners and strangers cannot change roles', async () => {
    const w = await buildWorld(db());
    const attempts: Array<[TestUser, TestUser, 'owner' | 'admin' | 'member']> = [
      [w.bob, w.carol, 'admin'],
      [w.bob, w.bob, 'owner'],
      [w.carol, w.carol, 'owner'],
      [w.carol, w.dave, 'admin'],
      [w.gina, w.carol, 'admin'], // admin of B, member of A
      [w.erin, w.carol, 'admin'],
      [w.mallory, w.carol, 'owner'],
    ];
    for (const [caller, target, role] of attempts) {
      fails(await setMemberRole(db(), caller, w.wsA, target, role), '42501');
    }
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'member', status: 'active' });
    expect(await membership(db(), w.wsA, w.bob)).toEqual({ role: 'admin', status: 'active' });
  });

  it('fails for non-members and removed members', async () => {
    const w = await buildWorld(db());
    fails(await setMemberRole(db(), w.alice, w.wsA, w.mallory, 'admin'), 'P0002');
    fails(await setMemberRole(db(), w.alice, w.wsA, w.frank, 'admin'), 'P0002');
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    fails(await setMemberRole(db(), w.alice, w.wsA, w.dave, 'admin'), 'P0002');
    expect(await membership(db(), w.wsA, w.dave)).toEqual({ role: 'member', status: 'removed' });
  });
});

describe('remove_member', () => {
  it('owners remove admins and members', async () => {
    const w = await buildWorld(db());
    ok(await removeMember(db(), w.alice, w.wsA, w.bob));
    ok(await removeMember(db(), w.alice, w.wsA, w.carol));
    expect(await membership(db(), w.wsA, w.bob)).toEqual({ role: 'admin', status: 'removed' });
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'member', status: 'removed' });
  });

  it('owners remove another owner but never the last one', async () => {
    const w = await buildWorld(db());
    fails(await removeMember(db(), w.alice, w.wsA, w.alice), '42501', /at least one owner/);
    ok(await setMemberRole(db(), w.alice, w.wsA, w.bob, 'owner'));
    ok(await removeMember(db(), w.bob, w.wsA, w.alice));
    expect(await membership(db(), w.wsA, w.alice)).toEqual({ role: 'owner', status: 'removed' });
    fails(await removeMember(db(), w.bob, w.wsA, w.bob), '42501', /at least one owner/);
    expect(await membership(db(), w.wsA, w.bob)).toEqual({ role: 'owner', status: 'active' });
  });

  it('admins remove members only', async () => {
    const w = await buildWorld(db());
    ok(await removeMember(db(), w.bob, w.wsA, w.carol));
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'member', status: 'removed' });
    fails(await removeMember(db(), w.bob, w.wsA, w.alice), '42501');
    ok(await setMemberRole(db(), w.alice, w.wsA, w.dave, 'admin'));
    fails(await removeMember(db(), w.bob, w.wsA, w.dave), '42501');
    expect(await membership(db(), w.wsA, w.dave)).toEqual({ role: 'admin', status: 'active' });
  });

  it('members cannot remove anyone else; admins of other workspaces have no power here', async () => {
    const w = await buildWorld(db());
    for (const [caller, target] of [
      [w.carol, w.dave],
      [w.carol, w.bob],
      [w.carol, w.alice],
      [w.gina, w.carol],
    ] as Array<[TestUser, TestUser]>) {
      fails(await removeMember(db(), caller, w.wsA, target), '42501');
      expect(await membership(db(), w.wsA, target)).toMatchObject({ status: 'active' });
    }
  });

  it('strangers and other workspaces’ owners get "not found"', async () => {
    const w = await buildWorld(db());
    fails(await removeMember(db(), w.mallory, w.wsA, w.carol), 'P0002');
    fails(await removeMember(db(), w.erin, w.wsA, w.carol), 'P0002');
    fails(await removeMember(db(), w.alice, w.wsA, w.frank), 'P0002');
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'member', status: 'active' });
  });

  it('anyone may leave, except the last owner', async () => {
    const w = await buildWorld(db());
    ok(await removeMember(db(), w.carol, w.wsA, w.carol));
    ok(await removeMember(db(), w.bob, w.wsA, w.bob));
    expect(await membership(db(), w.wsA, w.carol)).toMatchObject({ status: 'removed' });
    expect(await membership(db(), w.wsA, w.bob)).toMatchObject({ status: 'removed' });
    // Leaving twice (or removing a removed member) is "not found".
    fails(await removeMember(db(), w.carol, w.wsA, w.carol), 'P0002');
    fails(await removeMember(db(), w.alice, w.wsA, w.carol), 'P0002');
    fails(await removeMember(db(), w.alice, w.wsA, w.alice), '42501', /at least one owner/);
  });
});

describe('a removed member loses all access to the workspace immediately', () => {
  async function removedWorld(): Promise<World & { project: string; task: string; note: string; ownNote: string }> {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    const task = await createTask(db(), w.dave, w.wsA, { assigneeId: w.dave.id });
    const note = await createNote(db(), w.alice, w.wsA, 'workspace');
    const ownNote = await createNote(db(), w.dave, w.wsA, 'private');
    ok(await setMemberRole(db(), w.alice, w.wsA, w.dave, 'admin'));
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    return { ...w, project, task, note, ownNote };
  }

  it('cannot read the workspace, roster, projects, tasks, notes or teammates', async () => {
    const w = await removedWorld();
    for (const table of ['workspaces', 'projects', 'tasks', 'notes', 'workspace_invitations']) {
      expect(await visibleIds(db(), w.dave, table), table).toEqual([]);
    }
    expect(await roster(w.dave, w.wsA)).toEqual([]);
    expect(await visibleIds(db(), w.dave, 'profiles')).toEqual([w.dave.id]);
    expect(ok(await db().query(w.dave, `select * from public.my_workspaces()`))).toEqual([]);
    for (const fn of ['is_workspace_member($1)', `has_workspace_role($1, array['admin']::public.workspace_role[])`]) {
      const [row] = ok(await db().query<{ v: boolean }>(w.dave, `select private.${fn} as v`, [w.wsA]));
      expect(row?.v, fn).toBe(false);
    }
  });

  it('cannot write anything or use the former admin role', async () => {
    const w = await removedWorld();
    fails(
      await db().affected(w.dave, `insert into public.tasks (workspace_id, title) values ($1, 't')`, [w.wsA]),
      '42501',
    );
    fails(
      await db().affected(w.dave, `insert into public.notes (workspace_id, title) values ($1, 'n')`, [w.wsA]),
      '42501',
    );
    fails(
      await db().affected(w.dave, `insert into public.projects (workspace_id, name) values ($1, 'p')`, [w.wsA]),
      '42501',
    );
    expect(ok(await db().affected(w.dave, `update public.tasks set title = 'x' where id = $1`, [w.task]))).toBe(0);
    expect(ok(await db().affected(w.dave, `delete from public.tasks where id = $1`, [w.task]))).toBe(0);
    expect(ok(await db().affected(w.dave, `update public.notes set body = 'x' where id = $1`, [w.ownNote]))).toBe(0);
    expect(ok(await db().affected(w.dave, `update public.workspaces set name = 'x' where id = $1`, [w.wsA]))).toBe(0);
    fails(await invite(db(), w.dave, w.wsA, 'friend@example.test', 'member'), '42501');
    fails(await removeMember(db(), w.dave, w.wsA, w.carol), 'P0002');
    fails(await sync(db(), w.dave, w.wsA, [entry()]), '42501');
  });

  it('regains access only through a new invitation', async () => {
    const w = await removedWorld();
    await addMember(db(), w.alice, w.wsA, w.dave, 'member');
    expect(await membership(db(), w.wsA, w.dave)).toEqual({ role: 'member', status: 'active' });
    expect(await visibleIds(db(), w.dave, 'workspaces')).toEqual([w.wsA]);
  });
});
