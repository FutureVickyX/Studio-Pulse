/**
 * notes: private notes are visible to their owner only; workspace notes to every member; only the
 * owner edits; owner_id and workspace_id never change; every update bumps `version`, which makes
 * optimistic concurrency (`update … where version = n`) detect conflicting edits; owners/admins
 * may delete other members' workspace notes but never their private ones.
 */

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_DENIED,
  RLS_VIOLATION,
  addMember,
  buildWorld,
  createNote,
  createProject,
  fails,
  ok,
  only,
  removeMember,
  useDatabase,
  visibleIds,
} from './fixtures';
import type { TestUser } from './harness';

const db = useDatabase();

interface StoredNote {
  owner_id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  body: string;
  visibility: string;
  pinned: boolean;
  version: number;
  updated_at: Date;
}

async function stored(id: string): Promise<StoredNote> {
  return only(
    await db().admin<StoredNote & Record<string, unknown>>(
      `select owner_id, workspace_id, project_id, title, body, visibility::text as visibility, pinned,
              version, updated_at
         from public.notes where id = $1`,
      [id],
    ),
  );
}

async function exists(id: string): Promise<boolean> {
  const rows = await db().admin(`select 1 from public.notes where id = $1`, [id]);
  return rows.length === 1;
}

function insertNote(who: TestUser, workspaceId: string, extra: Record<string, unknown> = {}) {
  const columns: Record<string, unknown> = { workspace_id: workspaceId, title: 'Note', ...extra };
  const names = Object.keys(columns);
  return db().affected(
    who,
    `insert into public.notes (${names.join(', ')})
     values (${names.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(columns),
  );
}

function updateNote(who: TestUser | 'service', noteId: string, assignment: string, params: unknown[] = []) {
  return db().affected(who, `update public.notes set ${assignment} where id = $1`, [noteId, ...params]);
}

describe('who sees which notes', () => {
  it('a private note is visible to its owner only, never to the workspace owner or admins', async () => {
    const w = await buildWorld(db());
    const note = await createNote(db(), w.carol, w.wsA, 'private', 'my secret draft');
    expect(await visibleIds(db(), w.carol, 'notes')).toEqual([note]);
    for (const user of [w.alice, w.bob, w.dave, w.gina, w.erin, w.frank, w.mallory]) {
      expect(await visibleIds(db(), user, 'notes', 'id = $1', [note]), user.label).toEqual([]);
    }
  });

  it('a workspace note is visible to every member of that workspace, and nobody else', async () => {
    const w = await buildWorld(db());
    const note = await createNote(db(), w.carol, w.wsA, 'workspace');
    for (const user of [w.alice, w.bob, w.carol, w.dave, w.gina]) {
      expect(await visibleIds(db(), user, 'notes', 'id = $1', [note]), user.label).toEqual([note]);
    }
    for (const user of [w.erin, w.frank, w.mallory]) {
      expect(await visibleIds(db(), user, 'notes', 'id = $1', [note]), user.label).toEqual([]);
    }
  });

  it('changing the visibility takes effect immediately', async () => {
    const w = await buildWorld(db());
    const note = await createNote(db(), w.carol, w.wsA, 'private');
    expect(ok(await updateNote(w.carol, note, `visibility = 'workspace'`))).toBe(1);
    expect(await visibleIds(db(), w.dave, 'notes', 'id = $1', [note])).toEqual([note]);
    expect(ok(await updateNote(w.carol, note, `visibility = 'private'`))).toBe(1);
    expect(await visibleIds(db(), w.dave, 'notes', 'id = $1', [note])).toEqual([]);
  });

  it('a removed member sees none of the workspace’s notes, not even their own, until re-invited', async () => {
    const w = await buildWorld(db());
    const own = await createNote(db(), w.dave, w.wsA, 'private');
    const shared = await createNote(db(), w.dave, w.wsA, 'workspace');
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    expect(await visibleIds(db(), w.dave, 'notes')).toEqual([]);
    expect(ok(await updateNote(w.dave, own, `body = 'x'`))).toBe(0);
    expect(ok(await db().affected(w.dave, `delete from public.notes where id = $1`, [own]))).toBe(0);
    // The workspace keeps the shared note.
    expect(await visibleIds(db(), w.carol, 'notes', 'id = $1', [shared])).toEqual([shared]);

    await addMember(db(), w.alice, w.wsA, w.dave, 'member');
    expect(await visibleIds(db(), w.dave, 'notes')).toEqual([own, shared].sort());
  });
});

describe('creating notes', () => {
  it('members create notes owned by themselves, starting at version 1', async () => {
    const w = await buildWorld(db());
    const note = await createNote(db(), w.carol, w.wsA, 'private');
    expect(await stored(note)).toMatchObject({
      owner_id: w.carol.id,
      workspace_id: w.wsA,
      visibility: 'private',
      pinned: false,
      version: 1,
    });
    // Default visibility is private.
    const rows = ok(
      await db().query<{ visibility: string }>(
        w.dave,
        `insert into public.notes (workspace_id) values ($1) returning visibility::text as visibility`,
        [w.wsA],
      ),
    );
    expect(only(rows).visibility).toBe('private');
  });

  it('owner_id must be the caller, and only members create', async () => {
    const w = await buildWorld(db());
    fails(await insertNote(w.carol, w.wsA, { owner_id: w.alice.id }), '42501', RLS_VIOLATION);
    fails(await insertNote(w.alice, w.wsA, { owner_id: w.carol.id }), '42501', RLS_VIOLATION);
    for (const user of [w.erin, w.frank, w.mallory]) {
      fails(await insertNote(user, w.wsA), '42501', RLS_VIOLATION);
    }
  });

  it('the project must belong to the same workspace', async () => {
    const w = await buildWorld(db());
    const projectA = await createProject(db(), w.alice, w.wsA);
    const projectB = await createProject(db(), w.erin, w.wsB);
    expect(ok(await insertNote(w.gina, w.wsA, { project_id: projectA }))).toBe(1);
    fails(await insertNote(w.gina, w.wsA, { project_id: projectB }), '23503');
  });

  it('clients cannot choose the version, id or timestamps; title length is limited', async () => {
    const w = await buildWorld(db());
    for (const extra of [
      { version: 7 },
      { id: '00000000-0000-4000-8000-0000000000ae' },
      { created_at: '2020-01-01T00:00:00Z' },
      { updated_at: '2020-01-01T00:00:00Z' },
    ]) {
      fails(await insertNote(w.carol, w.wsA, extra), '42501', PERMISSION_DENIED);
    }
    fails(await insertNote(w.carol, w.wsA, { title: 't'.repeat(201) }), '23514');
  });
});

describe('updating notes', () => {
  it('only the owner edits, even a workspace note and even against the workspace owner', async () => {
    const w = await buildWorld(db());
    const shared = await createNote(db(), w.carol, w.wsA, 'workspace', 'original');
    const secret = await createNote(db(), w.carol, w.wsA, 'private', 'original');
    for (const note of [shared, secret]) {
      for (const user of [w.alice, w.bob, w.dave, w.gina, w.erin, w.mallory]) {
        expect(ok(await updateNote(user, note, `body = 'overwritten'`)), user.label).toBe(0);
      }
      expect((await stored(note)).body).toBe('original');
      expect(ok(await updateNote(w.carol, note, `body = 'edited', pinned = true`))).toBe(1);
      expect(await stored(note)).toMatchObject({ body: 'edited', pinned: true });
    }
  });

  it('owner_id, workspace_id and version are not writable, and triggers back that up', async () => {
    const w = await buildWorld(db());
    const note = await createNote(db(), w.gina, w.wsA, 'workspace');
    fails(await updateNote(w.gina, note, `owner_id = $2`, [w.alice.id]), '42501', PERMISSION_DENIED);
    fails(await updateNote(w.gina, note, `workspace_id = $2`, [w.wsB]), '42501', PERMISSION_DENIED);
    fails(await updateNote(w.gina, note, `version = 100`), '42501', PERMISSION_DENIED);
    fails(await updateNote(w.gina, note, `id = gen_random_uuid()`), '42501', PERMISSION_DENIED);
    fails(await updateNote('service', note, `owner_id = $2`, [w.alice.id]), '42501', /owner_id cannot be changed/);
    fails(await updateNote('service', note, `workspace_id = $2`, [w.wsB]), '42501', /workspace_id cannot be changed/);
    expect(await stored(note)).toMatchObject({ owner_id: w.gina.id, workspace_id: w.wsA, version: 1 });
  });

  it('every update increments the version (and moves updated_at)', async () => {
    const w = await buildWorld(db());
    const note = await createNote(db(), w.carol, w.wsA, 'private', 'v1');
    let previous = await stored(note);
    for (const [index, assignment] of [
      `body = 'v2'`,
      `title = 'New title'`,
      `pinned = true`,
      `body = body`, // even a no-op update is a new version
    ].entries()) {
      expect(ok(await updateNote(w.carol, note, assignment))).toBe(1);
      const current = await stored(note);
      expect(current.version).toBe(index + 2);
      expect(current.updated_at.getTime()).toBeGreaterThanOrEqual(previous.updated_at.getTime());
      previous = current;
    }
  });

  it('optimistic concurrency: an update based on a stale version changes nothing', async () => {
    const w = await buildWorld(db());
    const note = await createNote(db(), w.carol, w.wsA, 'workspace', 'base');
    // Two devices of the owner load the note at version 1.
    const loaded = (await stored(note)).version;
    expect(loaded).toBe(1);

    const saveAs = (body: string, version: number) =>
      db().query<{ version: number }>(
        w.carol,
        `update public.notes set body = $1 where id = $2 and version = $3 returning version`,
        [body, note, version],
      );

    expect(ok(await saveAs('from laptop', loaded))).toEqual([{ version: 2 }]);
    // The second device's save matches no row: a conflict to surface, not an overwrite.
    expect(ok(await saveAs('from desktop', loaded))).toEqual([]);
    expect(await stored(note)).toMatchObject({ body: 'from laptop', version: 2 });
    // After reloading, the retry applies on top of the newer version.
    expect(ok(await saveAs('merged', 2))).toEqual([{ version: 3 }]);
    expect(await stored(note)).toMatchObject({ body: 'merged', version: 3 });
  });

  it('the project can only change to one of the same workspace', async () => {
    const w = await buildWorld(db());
    const projectA = await createProject(db(), w.alice, w.wsA);
    const projectB = await createProject(db(), w.erin, w.wsB);
    const note = await createNote(db(), w.gina, w.wsA, 'private');
    expect(ok(await updateNote(w.gina, note, `project_id = $2`, [projectA]))).toBe(1);
    fails(await updateNote(w.gina, note, `project_id = $2`, [projectB]), '23503');
    expect((await stored(note)).project_id).toBe(projectA);
  });
});

describe('deleting notes', () => {
  it('owners of a note delete it, private or shared', async () => {
    const w = await buildWorld(db());
    for (const visibility of ['private', 'workspace'] as const) {
      const note = await createNote(db(), w.carol, w.wsA, visibility);
      expect(ok(await db().affected(w.carol, `delete from public.notes where id = $1`, [note]))).toBe(1);
      expect(await exists(note)).toBe(false);
    }
  });

  it('workspace owners and admins delete members’ workspace notes, never their private ones', async () => {
    const w = await buildWorld(db());
    for (const moderator of [w.alice, w.bob]) {
      const shared = await createNote(db(), w.carol, w.wsA, 'workspace');
      const secret = await createNote(db(), w.carol, w.wsA, 'private');
      expect(ok(await db().affected(moderator, `delete from public.notes where id = $1`, [shared]))).toBe(1);
      expect(ok(await db().affected(moderator, `delete from public.notes where id = $1`, [secret]))).toBe(0);
      expect(await exists(shared)).toBe(false);
      expect(await exists(secret)).toBe(true);
    }
  });

  it('members, admins of other workspaces and strangers delete nothing of others', async () => {
    const w = await buildWorld(db());
    const shared = await createNote(db(), w.carol, w.wsA, 'workspace');
    const secret = await createNote(db(), w.carol, w.wsA, 'private');
    for (const user of [w.dave, w.gina, w.erin, w.frank, w.mallory]) {
      expect(ok(await db().affected(user, `delete from public.notes where id = any($1::uuid[])`, [[shared, secret]])), user.label).toBe(0);
    }
    expect(await exists(shared)).toBe(true);
    expect(await exists(secret)).toBe(true);
  });
});
