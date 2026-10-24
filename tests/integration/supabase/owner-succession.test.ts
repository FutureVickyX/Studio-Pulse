/**
 * Deleting an account (Authentication › Users, the Auth admin API or SQL) cascades to the
 * account's memberships without going through remove_member. A workspace must still keep an
 * owner whenever it has active members (migration 6/6).
 */

import { describe, expect, it } from 'vitest';

import {
  addMember,
  createWorkspace,
  entry,
  membership,
  newUser,
  ok,
  removeMember,
  setMemberRole,
  setVisibility,
  storedEntries,
  syncOk,
  useDatabase,
} from './fixtures';
import type { TestUser } from './harness';

const db = useDatabase();

/** Members in join order (joined_at set explicitly, one minute apart). */
async function workspaceWith(owner: TestUser, members: [TestUser, 'admin' | 'member'][]): Promise<string> {
  const ws = await createWorkspace(db(), owner, 'Succession');
  for (const [i, [user, role]] of members.entries()) {
    await addMember(db(), owner, ws, user, role);
    await db().admin(
      `update public.workspace_members set joined_at = now() + make_interval(mins => $3)
        where workspace_id = $1 and user_id = $2`,
      [ws, user.id, i + 1],
    );
  }
  return ws;
}

async function owners(ws: string): Promise<string[]> {
  const rows = await db().admin<{ user_id: string }>(
    `select user_id from public.workspace_members
      where workspace_id = $1 and role = 'owner' and status = 'active' order by user_id`,
    [ws],
  );
  return rows.map((r) => r.user_id);
}

describe('deleting the last owner’s account', () => {
  it('makes the longest-standing admin the owner, who can then manage the workspace', async () => {
    const [owner, admin1, admin2, member] = await Promise.all(
      ['owner', 'admin1', 'admin2', 'member'].map((n) => newUser(db(), n)),
    );
    const ws = await workspaceWith(owner, [
      [member, 'member'],
      [admin1, 'admin'],
      [admin2, 'admin'],
    ]);

    await db().deleteUser(owner);

    expect(await owners(ws)).toEqual([admin1.id]);
    expect(await membership(db(), ws, admin2)).toEqual({ role: 'admin', status: 'active' });
    expect(await membership(db(), ws, member)).toEqual({ role: 'member', status: 'active' });
    // Owner-only operations work again.
    ok(await setVisibility(db(), admin1, ws, 'admins'));
    ok(await setMemberRole(db(), admin1, ws, admin2, 'owner'));
    expect(await owners(ws)).toEqual([admin1.id, admin2.id].sort());
  });

  it('makes the longest-standing member the owner when there is no admin', async () => {
    const [owner, first, second] = await Promise.all(['owner', 'first', 'second'].map((n) => newUser(db(), n)));
    const ws = await workspaceWith(owner, [
      [first, 'member'],
      [second, 'member'],
    ]);

    await db().deleteUser(owner);

    expect(await owners(ws)).toEqual([first.id]);
    expect(await membership(db(), ws, second)).toEqual({ role: 'member', status: 'active' });
  });

  it('never promotes a removed member', async () => {
    const [owner, formerAdmin, member] = await Promise.all(
      ['owner', 'former', 'member'].map((n) => newUser(db(), n)),
    );
    const ws = await workspaceWith(owner, [
      [formerAdmin, 'admin'],
      [member, 'member'],
    ]);
    ok(await removeMember(db(), owner, ws, formerAdmin));

    await db().deleteUser(owner);

    expect(await owners(ws)).toEqual([member.id]);
    expect(await membership(db(), ws, formerAdmin)).toEqual({ role: 'admin', status: 'removed' });
  });

  it('promotes nobody while another active owner remains', async () => {
    const [owner1, owner2, admin] = await Promise.all(['owner1', 'owner2', 'admin'].map((n) => newUser(db(), n)));
    const ws = await workspaceWith(owner1, [
      [admin, 'admin'],
      [owner2, 'member'],
    ]);
    ok(await setMemberRole(db(), owner1, ws, owner2, 'owner'));

    await db().deleteUser(owner1);

    expect(await owners(ws)).toEqual([owner2.id]);
    expect(await membership(db(), ws, admin)).toEqual({ role: 'admin', status: 'active' });
  });

  it('leaves a workspace with no active members as it was, keeping removed members’ entries', async () => {
    const [owner, leaver] = await Promise.all(['owner', 'leaver'].map((n) => newUser(db(), n)));
    const ws = await workspaceWith(owner, [[leaver, 'member']]);
    const kept = entry();
    await syncOk(db(), leaver, ws, [kept]);
    ok(await removeMember(db(), owner, ws, leaver));

    await db().deleteUser(owner);

    expect(await owners(ws)).toEqual([]);
    const [workspace] = await db().admin(`select id from public.workspaces where id = $1`, [ws]);
    expect(workspace).toBeDefined();
    expect((await storedEntries(db(), [kept.id])).length).toBe(1);
  });
});

describe('deleting a workspace', () => {
  it('cascades to its members without promoting anyone or failing', async () => {
    const [owner, admin] = await Promise.all(['owner', 'admin'].map((n) => newUser(db(), n)));
    const ws = await workspaceWith(owner, [[admin, 'admin']]);

    const deleted = ok(
      await db().query<{ id: string }>(owner, `delete from public.workspaces where id = $1 returning id`, [ws]),
    );

    expect(deleted).toEqual([{ id: ws }]);
    const [count] = await db().admin<{ n: number }>(
      `select count(*)::int as n from public.workspace_members where workspace_id = $1`,
      [ws],
    );
    expect(count?.n).toBe(0);
  });
});
