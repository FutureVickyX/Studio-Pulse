/**
 * projects: members read; owners/admins create (as themselves), edit and delete; members and
 * outsiders cannot; a project never moves to another workspace, and nothing in one workspace can
 * reference another workspace's project.
 */

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_DENIED,
  RLS_VIOLATION,
  buildWorld,
  createNote,
  createProject,
  createTask,
  createWorkspace,
  entry,
  fails,
  newUser,
  ok,
  only,
  sync,
  useDatabase,
  visibleIds,
} from './fixtures';
import type { TestUser } from './harness';

const db = useDatabase();

interface StoredProject {
  name: string;
  description: string;
  status: string;
  workspace_id: string;
  created_by: string | null;
  updated_at: Date;
}

async function stored(id: string): Promise<StoredProject> {
  return only(
    await db().admin<StoredProject & Record<string, unknown>>(
      `select name, description, status::text as status, workspace_id, created_by, updated_at
         from public.projects where id = $1`,
      [id],
    ),
  );
}

async function projectCount(workspaceId: string): Promise<number> {
  const [row] = await db().admin<{ n: number }>(
    `select count(*)::int as n from public.projects where workspace_id = $1`,
    [workspaceId],
  );
  return row?.n ?? 0;
}

function insertProject(who: TestUser, workspaceId: string, extra: Record<string, unknown> = {}) {
  const columns: Record<string, unknown> = { workspace_id: workspaceId, name: 'Project', ...extra };
  const names = Object.keys(columns);
  return db().affected(
    who,
    `insert into public.projects (${names.join(', ')})
     values (${names.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(columns),
  );
}

describe('reading projects', () => {
  it('members of a workspace read its projects; nobody else does', async () => {
    const w = await buildWorld(db());
    const a1 = await createProject(db(), w.alice, w.wsA, 'A1');
    const a2 = await createProject(db(), w.bob, w.wsA, 'A2');
    const b1 = await createProject(db(), w.erin, w.wsB, 'B1');

    for (const user of [w.alice, w.bob, w.carol, w.dave]) {
      expect(await visibleIds(db(), user, 'projects'), user.label).toEqual([a1, a2].sort());
    }
    expect(await visibleIds(db(), w.gina, 'projects')).toEqual([a1, a2, b1].sort());
    for (const user of [w.erin, w.frank]) {
      expect(await visibleIds(db(), user, 'projects'), user.label).toEqual([b1]);
      expect(await visibleIds(db(), user, 'projects', 'id = $1', [a1])).toEqual([]);
    }
    expect(await visibleIds(db(), w.mallory, 'projects')).toEqual([]);
  });
});

describe('creating projects', () => {
  it('owners and admins create projects, recorded as created by themselves', async () => {
    const w = await buildWorld(db());
    const byOwner = await createProject(db(), w.alice, w.wsA, 'By owner');
    expect(await stored(byOwner)).toMatchObject({ workspace_id: w.wsA, created_by: w.alice.id, status: 'active' });
    expect(ok(await insertProject(w.bob, w.wsA, { name: 'By admin', created_by: w.bob.id }))).toBe(1);
    // gina is an admin of B.
    expect(ok(await insertProject(w.gina, w.wsB, { name: 'By B admin' }))).toBe(1);
  });

  it('members, admins of other workspaces, other owners and strangers cannot', async () => {
    const w = await buildWorld(db());
    const before = await projectCount(w.wsA);
    for (const user of [w.carol, w.dave, w.gina, w.erin, w.frank, w.mallory]) {
      fails(await insertProject(user, w.wsA), '42501', RLS_VIOLATION);
    }
    expect(await projectCount(w.wsA)).toBe(before);
  });

  it('created_by must be the caller', async () => {
    const w = await buildWorld(db());
    fails(await insertProject(w.alice, w.wsA, { created_by: w.bob.id }), '42501', RLS_VIOLATION);
    fails(await insertProject(w.alice, w.wsA, { created_by: null }), '42501', RLS_VIOLATION);
  });

  it('clients cannot choose the id or timestamps', async () => {
    const w = await buildWorld(db());
    for (const extra of [
      { id: '00000000-0000-4000-8000-000000000001' },
      { created_at: '2020-01-01T00:00:00Z' },
      { updated_at: '2020-01-01T00:00:00Z' },
    ]) {
      fails(await insertProject(w.alice, w.wsA, extra), '42501', PERMISSION_DENIED);
    }
  });

  it('validates name and description', async () => {
    const w = await buildWorld(db());
    fails(await insertProject(w.alice, w.wsA, { name: '   ' }), '23514');
    fails(await insertProject(w.alice, w.wsA, { name: 'n'.repeat(121) }), '23514');
    fails(await insertProject(w.alice, w.wsA, { description: 'd'.repeat(4001) }), '23514');
    expect(ok(await insertProject(w.alice, w.wsA, { name: 'n'.repeat(120), description: 'd'.repeat(4000) }))).toBe(1);
  });
});

describe('updating projects', () => {
  it('owners and admins edit name, description and status', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA, 'Original');
    const before = await stored(project);
    expect(
      ok(
        await db().affected(
          w.bob,
          `update public.projects set name = 'Renamed', description = 'Brief', status = 'archived' where id = $1`,
          [project],
        ),
      ),
    ).toBe(1);
    const after = await stored(project);
    expect(after).toMatchObject({ name: 'Renamed', description: 'Brief', status: 'archived', created_by: w.alice.id });
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
    expect(ok(await db().affected(w.alice, `update public.projects set status = 'active' where id = $1`, [project]))).toBe(1);
  });

  it('members, admins of other workspaces and strangers cannot', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA, 'Original');
    for (const user of [w.carol, w.dave, w.gina, w.erin, w.frank, w.mallory]) {
      expect(
        ok(await db().affected(user, `update public.projects set name = 'hacked' where id = $1`, [project])),
        user.label,
      ).toBe(0);
    }
    expect((await stored(project)).name).toBe('Original');
  });

  it('never moves to another workspace: no column grant, and a trigger behind it', async () => {
    // Someone who owns both workspaces still cannot move a project between them.
    const both = await newUser(db(), 'both');
    const first = await createWorkspace(db(), both, 'First');
    const second = await createWorkspace(db(), both, 'Second');
    const project = await createProject(db(), both, first);
    fails(
      await db().affected(both, `update public.projects set workspace_id = $1 where id = $2`, [second, project]),
      '42501',
      PERMISSION_DENIED,
    );
    // The service role has every privilege; the trigger still refuses.
    fails(
      await db().affected('service', `update public.projects set workspace_id = $1 where id = $2`, [second, project]),
      '42501',
      /workspace_id cannot be changed/,
    );
    expect((await stored(project)).workspace_id).toBe(first);
  });

  it('id, created_by and timestamps are not writable', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    for (const assignment of [
      `id = gen_random_uuid()`,
      `created_by = '${w.bob.id}'`,
      `created_at = now()`,
      `updated_at = now()`,
    ]) {
      fails(
        await db().affected(w.alice, `update public.projects set ${assignment} where id = $1`, [project]),
        '42501',
        PERMISSION_DENIED,
      );
    }
  });
});

describe('deleting projects', () => {
  it('owners and admins delete; members, outsiders and strangers cannot', async () => {
    const w = await buildWorld(db());
    const first = await createProject(db(), w.alice, w.wsA, 'First');
    const second = await createProject(db(), w.alice, w.wsA, 'Second');
    for (const user of [w.carol, w.dave, w.gina, w.erin, w.frank, w.mallory]) {
      expect(ok(await db().affected(user, `delete from public.projects where id = $1`, [first])), user.label).toBe(0);
    }
    expect(ok(await db().affected(w.bob, `delete from public.projects where id = $1`, [first]))).toBe(1);
    expect(ok(await db().affected(w.alice, `delete from public.projects where id = $1`, [second]))).toBe(1);
    expect(await projectCount(w.wsA)).toBe(0);
  });

  it('detaches tasks, notes and time entries without deleting them', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    const keep = await createProject(db(), w.alice, w.wsA, 'Keep');
    const task = await createTask(db(), w.carol, w.wsA, { projectId: project });
    const otherTask = await createTask(db(), w.carol, w.wsA, { projectId: keep });
    const note = only(
      ok(
        await db().query<{ id: string }>(
          w.carol,
          `insert into public.notes (workspace_id, project_id, visibility) values ($1, $2, 'private') returning id`,
          [w.wsA, project],
        ),
      ),
    ).id;
    const timed = entry({ projectId: project, taskId: task });
    expect(ok(await sync(db(), w.carol, w.wsA, [timed]))[0]?.status).toBe('synced');

    expect(ok(await db().affected(w.bob, `delete from public.projects where id = $1`, [project]))).toBe(1);

    const [after] = await db().admin<Record<string, unknown>>(
      `select (select project_id from public.tasks where id = $1) as task_project,
              (select count(*)::int from public.tasks where id = $1) as task_exists,
              (select project_id from public.tasks where id = $2) as other_task_project,
              (select project_id from public.notes where id = $3) as note_project,
              (select count(*)::int from public.notes where id = $3) as note_exists,
              (select project_id from public.time_entries where id = $4) as entry_project,
              (select task_id from public.time_entries where id = $4) as entry_task,
              (select active_ms::int from public.time_entries where id = $4) as entry_active_ms`,
      [task, otherTask, note, timed.id],
    );
    expect(after).toEqual({
      task_project: null,
      task_exists: 1,
      other_task_project: keep,
      note_project: null,
      note_exists: 1,
      entry_project: null,
      entry_task: task,
      entry_active_ms: timed.activeMs,
    });
  });
});

describe('cross-workspace isolation', () => {
  it('nothing in one workspace can reference another workspace’s project', async () => {
    const w = await buildWorld(db());
    const projectA = await createProject(db(), w.alice, w.wsA);
    const projectB = await createProject(db(), w.erin, w.wsB);
    const unknown = '00000000-0000-4000-8000-0000000000aa';

    // gina belongs to both workspaces, so only the foreign key can stop her.
    for (const [workspaceId, projectId] of [
      [w.wsB, projectA],
      [w.wsA, projectB],
      [w.wsA, unknown],
    ] as const) {
      fails(
        await db().affected(
          w.gina,
          `insert into public.tasks (workspace_id, title, project_id) values ($1, 't', $2)`,
          [workspaceId, projectId],
        ),
        '23503',
      );
      fails(
        await db().affected(
          w.gina,
          `insert into public.notes (workspace_id, project_id) values ($1, $2)`,
          [workspaceId, projectId],
        ),
        '23503',
      );
    }
    const [result] = ok(await sync(db(), w.gina, w.wsB, [entry({ projectId: projectA })]));
    expect(result?.status).toBe('rejected');
    expect(result?.detail).toMatch(/^23503: /);

    // Moving an existing row onto the other workspace's project fails the same way.
    const taskB = await createTask(db(), w.gina, w.wsB);
    fails(
      await db().affected(w.gina, `update public.tasks set project_id = $1 where id = $2`, [projectA, taskB]),
      '23503',
    );
    const noteB = await createNote(db(), w.gina, w.wsB, 'private');
    fails(
      await db().affected(w.gina, `update public.notes set project_id = $1 where id = $2`, [projectA, noteB]),
      '23503',
    );
  });
});
