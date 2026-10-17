/**
 * time_entries as a table (the sync RPC has its own suite): rows are inserted only as yourself
 * into a workspace you are an active member of; detailed entries are private by default; with
 * visibility 'admins' the workspace's owners/admins may read members' entries but members still
 * cannot; entries are immutable; people delete only their own.
 */

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_DENIED,
  RLS_VIOLATION,
  buildWorld,
  entry,
  fails,
  insertEntryDirect,
  ok,
  only,
  removeMember,
  setVisibility,
  storedEntries,
  sync,
  syncOk,
  useDatabase,
  visibleIds,
} from './fixtures';
import type { World } from './fixtures';

const db = useDatabase();

const NAMES = ['alice', 'bob', 'carol', 'dave', 'gina', 'erin', 'frank'] as const;
type Name = (typeof NAMES)[number];

/** The world, with two synced entries per member and workspace (gina has entries in A and B). */
async function trackedWorld(): Promise<World & { entries: Record<Name, string[]>; inA: string[]; inB: string[] }> {
  const w = await buildWorld(db());
  const entries = {} as Record<Name, string[]>;
  const inA: string[] = [];
  const inB: string[] = [];
  for (const name of NAMES) {
    const user = w[name];
    entries[name] = [];
    const workspaces = name === 'gina' ? [w.wsA, w.wsB] : ['erin', 'frank'].includes(name) ? [w.wsB] : [w.wsA];
    for (const workspaceId of workspaces) {
      const ids = await syncOk(db(), user, workspaceId, [entry(), entry({ kind: 'idle', activeMs: 0, idleMs: 300_000, endReason: 'inputResumed' })]);
      entries[name].push(...ids);
      (workspaceId === w.wsA ? inA : inB).push(...ids);
    }
  }
  return { ...w, entries, inA: inA.sort(), inB: inB.sort() };
}

/** The sorted union of id lists. */
const sorted = (...lists: string[][]): string[] => [...new Set(lists.flat())].sort();

describe('inserting directly', () => {
  it('a member inserts their own entry into their workspace; user_id defaults to the caller', async () => {
    const w = await buildWorld(db());
    const outcome = await db().query<{ id: string; user_id: string; source: string }>(
      w.carol,
      `insert into public.time_entries (id, workspace_id, device_id, application_id, application_name,
         kind, started_at, ended_at, active_ms, idle_ms, end_reason, recorded_at)
       values (gen_random_uuid(), $1, gen_random_uuid(), 'figma', 'Figma', 'active',
         '2026-10-16T08:00:00Z', '2026-10-16T08:01:00Z', 60000, 0, 'appSwitch', now())
       returning id, user_id, source`,
      [w.wsA],
    );
    const row = only(ok(outcome));
    expect(row).toMatchObject({ user_id: w.carol.id, source: 'automatic' });
    expect(ok(await insertEntryDirect(db(), w.carol, w.wsA, { user_id: w.carol.id }))).toBe(1);
  });

  it('cannot insert entries as someone else', async () => {
    const w = await buildWorld(db());
    for (const other of [w.dave, w.alice, w.frank, w.mallory]) {
      fails(await insertEntryDirect(db(), w.carol, w.wsA, { user_id: other.id }), '42501', RLS_VIOLATION);
    }
  });

  it('cannot insert into a workspace one is not an active member of', async () => {
    const w = await buildWorld(db());
    fails(await insertEntryDirect(db(), w.carol, w.wsB), '42501', RLS_VIOLATION);
    fails(await insertEntryDirect(db(), w.mallory, w.wsA), '42501', RLS_VIOLATION);
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    fails(await insertEntryDirect(db(), w.dave, w.wsA), '42501', RLS_VIOLATION);
  });

  it('only automatic intervals are accepted, and created_at is the server’s', async () => {
    const w = await buildWorld(db());
    fails(await insertEntryDirect(db(), w.carol, w.wsA, { source: 'manual' }), '23514');
    fails(
      await insertEntryDirect(db(), w.carol, w.wsA, { created_at: '2020-01-01T00:00:00Z' }),
      '42501',
      PERMISSION_DENIED,
    );
  });

  it('the table enforces the interval invariants for direct inserts too', async () => {
    const w = await buildWorld(db());
    for (const columns of [
      { active_ms: 1 }, // active + idle ≠ duration
      { kind: 'typing' },
      { end_reason: 'crashed' },
      { kind: 'idle' }, // idle entry with active ms
      { application_id: 'Not An Id' },
    ]) {
      fails(await insertEntryDirect(db(), w.carol, w.wsA, columns), '23514');
    }
  });
});

describe('reading entries', () => {
  it('private by default: everyone reads only their own entries, owners and admins included', async () => {
    const w = await trackedWorld();
    for (const name of NAMES) {
      expect(await visibleIds(db(), w[name], 'time_entries'), name).toEqual(sorted(w.entries[name]));
    }
    expect(await visibleIds(db(), w.mallory, 'time_entries')).toEqual([]);
    // Aggregates see the same rows: no totals of other people's time leak.
    const [total] = ok(
      await db().query<{ n: number; ms: string }>(
        w.alice,
        `select count(*)::int as n, coalesce(sum(active_ms + idle_ms), 0)::text as ms from public.time_entries`,
      ),
    );
    expect(total).toEqual({ n: 2, ms: String(600_000) });
  });

  it('with visibility "admins", owners and admins read members’ entries; members still cannot', async () => {
    const w = await trackedWorld();
    ok(await setVisibility(db(), w.alice, w.wsA, 'admins'));
    expect(await visibleIds(db(), w.alice, 'time_entries')).toEqual(w.inA);
    expect(await visibleIds(db(), w.bob, 'time_entries')).toEqual(w.inA);
    for (const name of ['carol', 'dave'] as const) {
      expect(await visibleIds(db(), w[name], 'time_entries'), name).toEqual(sorted(w.entries[name]));
    }
    // gina is a member of A: her own entries only (B is still private, so her B admin role adds nothing).
    expect(await visibleIds(db(), w.gina, 'time_entries')).toEqual(sorted(w.entries.gina));
    // B's owner and members see nothing of A.
    expect(await visibleIds(db(), w.erin, 'time_entries')).toEqual(sorted(w.entries.erin));
    expect(await visibleIds(db(), w.frank, 'time_entries')).toEqual(sorted(w.entries.frank));

    // The role in the entry's own workspace decides: gina administers B once B opts in.
    ok(await setVisibility(db(), w.erin, w.wsB, 'admins'));
    expect(await visibleIds(db(), w.gina, 'time_entries')).toEqual(sorted(w.inB, w.entries.gina));
    expect(await visibleIds(db(), w.frank, 'time_entries')).toEqual(sorted(w.entries.frank));
  });

  it('switching back to private, or losing the admin role, hides members’ entries immediately', async () => {
    const w = await trackedWorld();
    ok(await setVisibility(db(), w.alice, w.wsA, 'admins'));
    expect(await visibleIds(db(), w.bob, 'time_entries')).toEqual(w.inA);

    ok(await db().query(w.alice, `select public.set_member_role($1, $2, 'member')`, [w.wsA, w.bob.id]));
    expect(await visibleIds(db(), w.bob, 'time_entries')).toEqual(sorted(w.entries.bob));
    ok(await db().query(w.alice, `select public.set_member_role($1, $2, 'admin')`, [w.wsA, w.bob.id]));
    ok(await removeMember(db(), w.alice, w.wsA, w.bob));
    expect(await visibleIds(db(), w.bob, 'time_entries')).toEqual(sorted(w.entries.bob));

    ok(await setVisibility(db(), w.alice, w.wsA, 'private'));
    expect(await visibleIds(db(), w.alice, 'time_entries')).toEqual(sorted(w.entries.alice));
  });
});

describe('entries are immutable', () => {
  it('nobody can UPDATE an entry, not even its owner or a workspace owner who can read it', async () => {
    const w = await trackedWorld();
    ok(await setVisibility(db(), w.alice, w.wsA, 'admins'));
    const [target] = w.entries.carol;
    const before = await storedEntries(db(), [target!]);
    for (const assignment of [
      `application_name = 'Edited'`,
      `active_ms = 0, idle_ms = 300000, kind = 'idle'`,
      `ended_at = ended_at + interval '1 hour'`,
      `project_id = null`,
      `task_id = null`,
      `user_id = '${w.dave.id}'`,
      `workspace_id = '${w.wsB}'`,
      `local_revision = local_revision + 1`,
      `source = 'automatic'`,
    ]) {
      for (const who of [w.carol, w.alice]) {
        fails(
          await db().affected(who, `update public.time_entries set ${assignment} where id = $1`, [target]),
          '42501',
          PERMISSION_DENIED,
        );
      }
    }
    expect(await storedEntries(db(), [target!])).toEqual(before);
  });
});

describe('deleting entries', () => {
  it('members delete their own entries only, whatever the visibility', async () => {
    const w = await trackedWorld();
    ok(await setVisibility(db(), w.alice, w.wsA, 'admins'));
    const [first, second] = w.entries.carol;
    for (const user of [w.alice, w.bob, w.dave, w.gina, w.erin, w.mallory]) {
      expect(ok(await db().affected(user, `delete from public.time_entries where id = $1`, [first])), user.label).toBe(0);
    }
    expect(ok(await db().affected(w.carol, `delete from public.time_entries where id = $1`, [first]))).toBe(1);
    expect(await storedEntries(db(), [first!])).toEqual([]);

    // An unfiltered DELETE by the owner of the workspace removes only the owner's own rows.
    expect(ok(await db().affected(w.alice, `delete from public.time_entries`))).toBe(2);
    expect(await storedEntries(db(), [second!])).toHaveLength(1);
    expect(await storedEntries(db(), w.entries.dave)).toHaveLength(2);
  });

  it('a removed member keeps read and delete rights over their own history, but cannot add to it', async () => {
    const w = await trackedWorld();
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    expect(await visibleIds(db(), w.dave, 'time_entries')).toEqual(sorted(w.entries.dave));
    fails(await sync(db(), w.dave, w.wsA, [entry()]), '42501');
    fails(await insertEntryDirect(db(), w.dave, w.wsA), '42501', RLS_VIOLATION);
    const [first] = w.entries.dave;
    expect(ok(await db().affected(w.dave, `delete from public.time_entries where id = $1`, [first]))).toBe(1);
    expect(await visibleIds(db(), w.dave, 'time_entries')).toHaveLength(1);
  });
});

