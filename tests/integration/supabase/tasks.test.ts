/**
 * tasks: members read and create (as themselves); the assignee must be an active member of the
 * same workspace; the project must be in the same workspace (composite foreign key); the
 * creator, the assignee or an owner/admin edits; the creator or an owner/admin deletes;
 * workspace_id never changes; completed_at follows the status.
 */

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_DENIED,
  RLS_VIOLATION,
  buildWorld,
  createProject,
  createTask,
  fails,
  ok,
  only,
  removeMember,
  useDatabase,
  visibleIds,
} from './fixtures';
import type { TestUser } from './harness';

const db = useDatabase();

interface StoredTask {
  title: string;
  status: string;
  priority: string;
  workspace_id: string;
  project_id: string | null;
  assignee_id: string | null;
  created_by: string | null;
  completed_at: Date | null;
}

async function stored(id: string): Promise<StoredTask> {
  return only(
    await db().admin<StoredTask & Record<string, unknown>>(
      `select title, status::text as status, priority::text as priority, workspace_id, project_id,
              assignee_id, created_by, completed_at
         from public.tasks where id = $1`,
      [id],
    ),
  );
}

function insertTask(who: TestUser, workspaceId: string, extra: Record<string, unknown> = {}) {
  const columns: Record<string, unknown> = { workspace_id: workspaceId, title: 'Task', ...extra };
  const names = Object.keys(columns);
  return db().affected(
    who,
    `insert into public.tasks (${names.join(', ')})
     values (${names.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(columns),
  );
}

function updateTask(who: TestUser | 'service', taskId: string, assignment: string, params: unknown[] = []) {
  return db().affected(who, `update public.tasks set ${assignment} where id = $1`, [taskId, ...params]);
}

describe('reading tasks', () => {
  it('members of the workspace read its tasks; nobody else does', async () => {
    const w = await buildWorld(db());
    const a1 = await createTask(db(), w.carol, w.wsA);
    const a2 = await createTask(db(), w.alice, w.wsA, { assigneeId: w.dave.id });
    const b1 = await createTask(db(), w.frank, w.wsB);
    for (const user of [w.alice, w.bob, w.carol, w.dave]) {
      expect(await visibleIds(db(), user, 'tasks'), user.label).toEqual([a1, a2].sort());
    }
    expect(await visibleIds(db(), w.gina, 'tasks')).toEqual([a1, a2, b1].sort());
    expect(await visibleIds(db(), w.erin, 'tasks')).toEqual([b1]);
    expect(await visibleIds(db(), w.frank, 'tasks', 'id = $1', [a1])).toEqual([]);
    expect(await visibleIds(db(), w.mallory, 'tasks')).toEqual([]);
  });
});

describe('creating tasks', () => {
  it('any active member creates tasks, recorded as created by themselves', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA, { title: 'Storyboard' });
    expect(await stored(task)).toEqual({
      title: 'Storyboard',
      status: 'inbox',
      priority: 'normal',
      workspace_id: w.wsA,
      project_id: null,
      assignee_id: null,
      created_by: w.carol.id,
      completed_at: null,
    });
    expect(ok(await insertTask(w.dave, w.wsA, { created_by: w.dave.id }))).toBe(1);
  });

  it('created_by must be the caller', async () => {
    const w = await buildWorld(db());
    fails(await insertTask(w.carol, w.wsA, { created_by: w.alice.id }), '42501', RLS_VIOLATION);
    fails(await insertTask(w.carol, w.wsA, { created_by: null }), '42501', RLS_VIOLATION);
  });

  it('non-members and removed members cannot create tasks', async () => {
    const w = await buildWorld(db());
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    for (const user of [w.erin, w.frank, w.mallory, w.dave]) {
      fails(await insertTask(user, w.wsA), '42501', RLS_VIOLATION);
    }
  });

  it('the assignee must be an active member of the same workspace', async () => {
    const w = await buildWorld(db());
    for (const assignee of [w.carol, w.alice, w.bob, w.gina]) {
      expect(ok(await insertTask(w.carol, w.wsA, { assignee_id: assignee.id })), assignee.label).toBe(1);
    }
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    for (const assignee of [w.mallory.id, w.frank.id, w.erin.id, w.dave.id, '00000000-0000-4000-8000-0000000000ab']) {
      fails(await insertTask(w.carol, w.wsA, { assignee_id: assignee }), '42501', RLS_VIOLATION);
    }
  });

  it('the project must belong to the same workspace', async () => {
    const w = await buildWorld(db());
    const projectA = await createProject(db(), w.alice, w.wsA);
    const projectB = await createProject(db(), w.erin, w.wsB);
    expect(ok(await insertTask(w.carol, w.wsA, { project_id: projectA }))).toBe(1);
    fails(await insertTask(w.carol, w.wsA, { project_id: projectB }), '23503');
    fails(await insertTask(w.carol, w.wsA, { project_id: '00000000-0000-4000-8000-0000000000ac' }), '23503');
  });

  it('clients cannot set the id, completed_at or timestamps', async () => {
    const w = await buildWorld(db());
    for (const extra of [
      { id: '00000000-0000-4000-8000-0000000000ad' },
      { completed_at: '2026-01-01T00:00:00Z' },
      { created_at: '2026-01-01T00:00:00Z' },
      { updated_at: '2026-01-01T00:00:00Z' },
    ]) {
      fails(await insertTask(w.carol, w.wsA, extra), '42501', PERMISSION_DENIED);
    }
  });

  it('validates title, dates and estimate', async () => {
    const w = await buildWorld(db());
    for (const extra of [
      { title: '   ' },
      { title: 't'.repeat(201) },
      { start_date: '2026-10-20', due_date: '2026-10-19' },
      { estimated_minutes: 0 },
      { estimated_minutes: 100_001 },
    ]) {
      fails(await insertTask(w.carol, w.wsA, extra), '23514');
    }
    expect(
      ok(await insertTask(w.carol, w.wsA, { start_date: '2026-10-19', due_date: '2026-10-19', estimated_minutes: 1 })),
    ).toBe(1);
  });
});

describe('completed_at follows the status', () => {
  it('is set when a task becomes done and cleared when it leaves done', async () => {
    const w = await buildWorld(db());
    const doneAtBirth = await createTask(db(), w.carol, w.wsA, { status: 'done' });
    expect((await stored(doneAtBirth)).completed_at).toBeInstanceOf(Date);

    const task = await createTask(db(), w.carol, w.wsA, { status: 'todo' });
    expect((await stored(task)).completed_at).toBeNull();
    expect(ok(await updateTask(w.carol, task, `status = 'done'`))).toBe(1);
    const completedAt = (await stored(task)).completed_at;
    expect(completedAt).toBeInstanceOf(Date);

    // Other edits while done keep the original completion time.
    expect(ok(await updateTask(w.carol, task, `title = 'Renamed', status = 'done'`))).toBe(1);
    expect((await stored(task)).completed_at).toEqual(completedAt);

    expect(ok(await updateTask(w.carol, task, `status = 'in_review'`))).toBe(1);
    expect((await stored(task)).completed_at).toBeNull();
    expect(ok(await updateTask(w.carol, task, `status = 'done'`))).toBe(1);
    expect((await stored(task)).completed_at).toBeInstanceOf(Date);
    expect(ok(await updateTask(w.carol, task, `status = 'archived'`))).toBe(1);
    expect((await stored(task)).completed_at).toBeNull();
  });

  it('clients cannot write completed_at directly', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA);
    fails(await updateTask(w.carol, task, `completed_at = now()`), '42501', PERMISSION_DENIED);
    fails(await updateTask(w.alice, task, `completed_at = null`), '42501', PERMISSION_DENIED);
  });
});

describe('updating tasks', () => {
  it('the creator, the assignee, admins and owners edit', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA, { assigneeId: w.dave.id });
    for (const editor of [w.carol, w.dave, w.bob, w.alice]) {
      expect(
        ok(await updateTask(editor, task, `title = $2, priority = 'high'`, [`by ${editor.label}`])),
        editor.label,
      ).toBe(1);
      expect((await stored(task)).title).toBe(`by ${editor.label}`);
    }
  });

  it('other members, admins of other workspaces and strangers cannot', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA, { title: 'Original', assigneeId: w.dave.id });
    // gina is a plain member of A (and an admin of B).
    for (const user of [w.gina, w.erin, w.frank, w.mallory]) {
      expect(ok(await updateTask(user, task, `title = 'hacked'`)), user.label).toBe(0);
      expect(ok(await updateTask(user, task, `assignee_id = $2`, [user.id])), user.label).toBe(0);
    }
    expect(await stored(task)).toMatchObject({ title: 'Original', assignee_id: w.dave.id });
  });

  it('reassignment follows the assignee rule', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA);
    expect(ok(await updateTask(w.carol, task, `assignee_id = $2`, [w.gina.id]))).toBe(1);
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    for (const assignee of [w.mallory, w.frank, w.erin, w.dave]) {
      fails(await updateTask(w.carol, task, `assignee_id = $2`, [assignee.id]), '42501', RLS_VIOLATION);
    }
    expect((await stored(task)).assignee_id).toBe(w.gina.id);
    expect(ok(await updateTask(w.carol, task, `assignee_id = null`))).toBe(1);
  });

  it('an assignee who hands a task back can no longer edit it', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA, { assigneeId: w.dave.id });
    expect(ok(await updateTask(w.dave, task, `assignee_id = null`))).toBe(1);
    expect(ok(await updateTask(w.dave, task, `title = 'mine again?'`))).toBe(0);
    expect(ok(await updateTask(w.dave, task, `assignee_id = $2`, [w.dave.id]))).toBe(0);
  });

  it('workspace_id and created_by never change', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.gina, w.wsA);
    fails(await updateTask(w.gina, task, `workspace_id = $2`, [w.wsB]), '42501', PERMISSION_DENIED);
    fails(await updateTask(w.alice, task, `created_by = $2`, [w.alice.id]), '42501', PERMISSION_DENIED);
    fails(await updateTask(w.alice, task, `id = gen_random_uuid()`), '42501', PERMISSION_DENIED);
    fails(await updateTask('service', task, `workspace_id = $2`, [w.wsB]), '42501', /workspace_id cannot be changed/);
    expect(await stored(task)).toMatchObject({ workspace_id: w.wsA, created_by: w.gina.id });
  });

  it('a task still assigned to a removed member must be reassigned on its next edit', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA, { assigneeId: w.dave.id });
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    // The stale assignment no longer satisfies the assignee rule, so any edit that keeps it fails...
    fails(await updateTask(w.carol, task, `status = 'done'`), '42501', RLS_VIOLATION);
    fails(await updateTask(w.alice, task, `status = 'done'`), '42501', RLS_VIOLATION);
    // ...and the same edit with a valid assignee succeeds.
    expect(ok(await updateTask(w.carol, task, `status = 'done', assignee_id = null`))).toBe(1);
    // The removed assignee lost every right on it.
    expect(ok(await updateTask(w.dave, task, `title = 'x'`))).toBe(0);
  });
});

describe('deleting tasks', () => {
  it('the creator, admins and owners delete', async () => {
    const w = await buildWorld(db());
    for (const deleter of [w.carol, w.bob, w.alice]) {
      const task = await createTask(db(), w.carol, w.wsA, { assigneeId: w.dave.id });
      expect(ok(await db().affected(deleter, `delete from public.tasks where id = $1`, [task])), deleter.label).toBe(1);
    }
  });

  it('the assignee, other members, outsiders and strangers cannot', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA, { assigneeId: w.dave.id });
    for (const user of [w.dave, w.gina, w.erin, w.frank, w.mallory]) {
      expect(ok(await db().affected(user, `delete from public.tasks where id = $1`, [task])), user.label).toBe(0);
    }
    // An unfiltered DELETE by a member removes only their own tasks.
    const own = await createTask(db(), w.dave, w.wsA);
    expect(ok(await db().affected(w.dave, `delete from public.tasks`))).toBe(1);
    expect(await visibleIds(db(), w.alice, 'tasks', 'id = any($1::uuid[])', [[task, own]])).toEqual([task]);
  });
});
