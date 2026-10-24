/**
 * The anonymous key (no user session) can read or write nothing in `public` and call no RPC,
 * and a request that carries the `authenticated` role without a user id cannot act either.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  DEVICE_ID,
  PERMISSION_DENIED,
  buildWorld,
  createNote,
  createProject,
  createTask,
  entry,
  fails,
  invite,
  ok,
  sync,
  useDatabase,
} from './fixtures';
import type { World } from './fixtures';

const db = useDatabase();

/** Every table in `public`; the privilege suite asserts this list is complete. */
const TABLES = [
  'notes',
  'profiles',
  'projects',
  'tasks',
  'time_entries',
  'workspace_invitations',
  'workspace_members',
  'workspaces',
] as const;

/** Every function in `public` with arguments a client could pass. */
const RPC_CALLS: ReadonlyArray<[string, string, (world: World) => unknown[]]> = [
  ['create_workspace', `select public.create_workspace($1)`, () => ['Anon studio']],
  [
    'create_invitation',
    `select public.create_invitation($1, $2, 'member')`,
    (w) => [w.wsA, 'anon@example.test'],
  ],
  ['accept_invitation', `select public.accept_invitation($1)`, () => ['0'.repeat(64)]],
  ['revoke_invitation', `select public.revoke_invitation($1)`, () => [DEVICE_ID]],
  [
    'set_member_role',
    `select public.set_member_role($1, $2, 'owner')`,
    (w) => [w.wsA, w.carol.id],
  ],
  ['remove_member', `select public.remove_member($1, $2)`, (w) => [w.wsA, w.alice.id]],
  [
    'set_time_entry_visibility',
    `select public.set_time_entry_visibility($1, 'admins')`,
    (w) => [w.wsA],
  ],
  ['my_workspaces', `select * from public.my_workspaces()`, () => []],
  [
    'sync_time_entries',
    `select * from public.sync_time_entries($1, $2::jsonb)`,
    (w) => [w.wsA, JSON.stringify([entry()])],
  ],
  // The RLS helpers live in `private` (migration 5/5); anon has no USAGE on that schema.
  ['is_workspace_member', `select private.is_workspace_member($1)`, (w) => [w.wsA]],
  [
    'has_workspace_role',
    `select private.has_workspace_role($1, array['owner']::public.workspace_role[])`,
    (w) => [w.wsA],
  ],
  ['is_active_member', `select private.is_active_member($1, $2)`, (w) => [w.wsA, w.alice.id]],
  ['shares_workspace_with', `select private.shares_workspace_with($1)`, (w) => [w.alice.id]],
];

let world: World;

beforeAll(async () => {
  world = await buildWorld(db());
  // Populate every table so "nothing visible" is meaningful.
  const project = await createProject(db(), world.alice, world.wsA);
  await createTask(db(), world.carol, world.wsA, { projectId: project });
  await createNote(db(), world.carol, world.wsA, 'workspace');
  ok(await invite(db(), world.alice, world.wsA, 'pending@example.test', 'member'));
  ok(await sync(db(), world.carol, world.wsA, [entry()]));
});

describe('anon key', () => {
  it.each(TABLES)('cannot select from %s', async (table) => {
    fails(await db().query('anon', `select * from public.${table}`), '42501', PERMISSION_DENIED);
    fails(
      await db().query('anon', `select count(*) from public.${table}`),
      '42501',
      PERMISSION_DENIED,
    );
  });

  it.each(TABLES)('cannot insert into, update or delete from %s', async (table) => {
    fails(
      await db().query('anon', `insert into public.${table} default values`),
      '42501',
      PERMISSION_DENIED,
    );
    const column = table === 'workspace_members' ? 'role' : 'id';
    fails(
      await db().query('anon', `update public.${table} set ${column} = ${column}`),
      '42501',
      PERMISSION_DENIED,
    );
    fails(await db().query('anon', `delete from public.${table}`), '42501', PERMISSION_DENIED);
    fails(await db().query('anon', `truncate public.${table}`), '42501', PERMISSION_DENIED);
  });

  it.each(RPC_CALLS)('cannot call %s', async (_name, sql, args) => {
    fails(await db().query('anon', sql, args(world)), '42501', PERMISSION_DENIED);
  });

  it('cannot read auth.users', async () => {
    fails(await db().query('anon', `select * from auth.users`), '42501', PERMISSION_DENIED);
  });

  it('left every table untouched', async () => {
    // The failed attempts above changed nothing (inspected as superuser).
    const [counts] = await db().admin<{ workspaces: number; members: number }>(
      `select (select count(*)::int from public.workspaces) as workspaces,
              (select count(*)::int from public.workspace_members) as members`,
    );
    expect(counts).toEqual({ workspaces: 2, members: 8 });
  });
});

describe('the authenticated role without a user id (no sub claim)', () => {
  const asNoSub = (sql: string, params: unknown[] = []) =>
    db().asClaims('authenticated', { role: 'authenticated' }, (s) => s.query(sql, params));

  it('cannot create a workspace (28000)', async () => {
    fails(await asNoSub(`select public.create_workspace('x')`), '28000');
  });

  it('cannot accept an invitation (28000)', async () => {
    fails(await asNoSub(`select public.accept_invitation($1)`, ['0'.repeat(64)]), '28000');
  });

  it('cannot sync time entries (28000)', async () => {
    fails(
      await asNoSub(`select * from public.sync_time_entries($1, $2::jsonb)`, [
        world.wsA,
        JSON.stringify([entry()]),
      ]),
      '28000',
    );
  });

  it('sees no rows and no workspaces', async () => {
    for (const table of TABLES) {
      if (table === 'workspace_invitations') continue; // `select *` is denied by column grants
      const rows = ok(await asNoSub(`select * from public.${table}`));
      expect(rows, table).toEqual([]);
    }
    expect(ok(await asNoSub(`select * from public.my_workspaces()`))).toEqual([]);
  });

  it('cannot invite, change roles, remove members or change visibility', async () => {
    fails(
      await asNoSub(`select public.create_invitation($1, 'x@example.test', 'member')`, [world.wsA]),
      '42501',
    );
    fails(
      await asNoSub(`select public.set_member_role($1, $2, 'owner')`, [world.wsA, world.carol.id]),
      '42501',
    );
    fails(await asNoSub(`select public.remove_member($1, $2)`, [world.wsA, world.carol.id]), 'P0002');
    fails(await asNoSub(`select public.set_time_entry_visibility($1, 'admins')`, [world.wsA]), '42501');
  });
});
