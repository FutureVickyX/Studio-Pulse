/**
 * Phase 2B (migrations 8 and 9): project leads and statuses, version bumps, deletion guards, task
 * checklists and comments, attributing tracked time to projects and tasks, former leads and
 * assignees, and time following a moved task. Every rule is exercised with members of two
 * workspaces plus an outsider (see `buildWorld`).
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorld,
  createNote,
  createProject,
  createTask,
  entry,
  fails,
  ok,
  only,
  removeMember,
  syncOk,
  useDatabase,
  visibleIds,
} from './fixtures';
import type { World } from './fixtures';
import type { TestUser } from './harness';

const db = useDatabase();

async function one<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return only(await db().admin<T>(sql, params));
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

describe('projects: statuses, leads and versions', () => {
  it('accepts every status in the lifecycle and bumps the version on each update', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    for (const [i, status] of ['planning', 'active', 'on_hold', 'completed', 'archived', 'active'].entries()) {
      expect(
        ok(await db().affected(w.bob, `update public.projects set status = $2 where id = $1`, [project, status])),
        status,
      ).toBe(1);
      expect(await one(`select status::text as status, version from public.projects where id = $1`, [project])).toEqual({
        status,
        version: i + 2,
      });
    }
  });

  it('a lead must be an active member of the project’s workspace', async () => {
    const w = await buildWorld(db());
    // erin and frank are in workspace B only; mallory is in none.
    for (const lead of [w.erin, w.frank, w.mallory]) {
      fails(
        await db().affected(w.alice, `insert into public.projects (workspace_id, name, lead_id) values ($1, 'p', $2)`, [
          w.wsA,
          lead.id,
        ]),
        '42501',
      );
    }
    expect(
      ok(
        await db().affected(w.alice, `insert into public.projects (workspace_id, name, lead_id) values ($1, 'p', $2)`, [
          w.wsA,
          w.carol.id,
        ]),
      ),
    ).toBe(1);
    const project = await createProject(db(), w.alice, w.wsA);
    fails(await db().affected(w.bob, `update public.projects set lead_id = $2 where id = $1`, [project, w.erin.id]), '42501');
  });

  it('the lead edits their project but cannot hand the lead on; other members edit nothing', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    ok(await db().affected(w.alice, `update public.projects set lead_id = $2 where id = $1`, [project, w.carol.id]));

    expect(
      ok(
        await db().affected(w.carol, `update public.projects set name = 'Renamed', status = 'on_hold', due_date = '2026-12-01' where id = $1`, [
          project,
        ]),
      ),
    ).toBe(1);
    // Handing the lead on is for owners and admins.
    fails(await db().affected(w.carol, `update public.projects set lead_id = $2 where id = $1`, [project, w.dave.id]), '42501');
    // A non-lead member and an outsider change nothing.
    for (const user of [w.dave, w.gina, w.erin, w.mallory]) {
      expect(ok(await db().affected(user, `update public.projects set name = 'Hijacked' where id = $1`, [project])), user.label).toBe(0);
    }
    expect(await one(`select name, status::text as status, due_date::text as due_date from public.projects where id = $1`, [project])).toEqual({
      name: 'Renamed',
      status: 'on_hold',
      due_date: '2026-12-01',
    });
    // A removed lead loses the right.
    ok(await removeMember(db(), w.alice, w.wsA, w.carol));
    expect(ok(await db().affected(w.carol, `update public.projects set name = 'Gone' where id = $1`, [project]))).toBe(0);
  });

  it('validates the date order', async () => {
    const w = await buildWorld(db());
    fails(
      await db().affected(
        w.alice,
        `insert into public.projects (workspace_id, name, start_date, due_date) values ($1, 'p', '2026-11-02', '2026-11-01')`,
        [w.wsA],
      ),
      '23514',
    );
  });

  it('deleting a workspace still removes its projects, tasks, notes and time entries', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.erin, w.wsB);
    const task = await createTask(db(), w.frank, w.wsB, { projectId: project });
    await createNote(db(), w.frank, w.wsB, 'workspace');
    await syncOk(db(), w.frank, w.wsB, [entry({ projectId: project, taskId: task })]);

    expect(ok(await db().affected(w.erin, `delete from public.workspaces where id = $1`, [w.wsB]))).toBe(1);
    expect(
      await one(
        `select (select count(*)::int from public.projects where workspace_id = $1) as projects,
                (select count(*)::int from public.tasks where workspace_id = $1) as tasks,
                (select count(*)::int from public.notes where workspace_id = $1) as notes,
                (select count(*)::int from public.time_entries where workspace_id = $1) as entries`,
        [w.wsB],
      ),
    ).toEqual({ projects: 0, tasks: 0, notes: 0, entries: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

describe('tasks: versions and deletion', () => {
  it('bumps the version on every update', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA);
    for (const version of [2, 3, 4]) {
      ok(await db().affected(w.carol, `update public.tasks set priority = 'high' where id = $1`, [task]));
      expect(await one(`select version from public.tasks where id = $1`, [task])).toEqual({ version });
    }
  });

  it('a task with tracked time cannot be deleted (archive it), one without can', async () => {
    const w = await buildWorld(db());
    const timed = await createTask(db(), w.carol, w.wsA);
    const plain = await createTask(db(), w.carol, w.wsA);
    const tracked = entry({ taskId: timed });
    await syncOk(db(), w.dave, w.wsA, [tracked]);

    // carol may delete her task, but dave's time is attached to it.
    fails(await db().affected(w.carol, `delete from public.tasks where id = $1`, [timed]), '23503');
    expect(ok(await db().affected(w.carol, `update public.tasks set status = 'archived' where id = $1`, [timed]))).toBe(1);
    expect(await one(`select task_id from public.time_entries where id = $1`, [tracked.id])).toEqual({ task_id: timed });
    expect(ok(await db().affected(w.carol, `delete from public.tasks where id = $1`, [plain]))).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Checklists (task_subtasks)
// ---------------------------------------------------------------------------------------------

function addSubtask(who: TestUser, workspaceId: string, taskId: string, title = 'Step') {
  return db().query<{ id: string }>(
    who,
    `insert into public.task_subtasks (workspace_id, task_id, title) values ($1, $2, $3) returning id`,
    [workspaceId, taskId, title],
  );
}

async function checklistWorld(): Promise<World & { task: string; step: string }> {
  const w = await buildWorld(db());
  // carol creates the task and assigns it to dave; gina is a member with no part in it.
  const task = await createTask(db(), w.carol, w.wsA, { assigneeId: w.dave.id });
  const step = only(ok(await addSubtask(w.carol, w.wsA, task, '  Rough cut  '))).id;
  return { ...w, task, step };
}

describe('task checklists', () => {
  it('members of the workspace see a task’s checklist; nobody else does', async () => {
    const w = await checklistWorld();
    for (const user of [w.alice, w.bob, w.carol, w.dave, w.gina]) {
      expect(await visibleIds(db(), user, 'task_subtasks'), user.label).toEqual([w.step]);
    }
    for (const user of [w.erin, w.frank, w.mallory]) {
      expect(await visibleIds(db(), user, 'task_subtasks'), user.label).toEqual([]);
    }
    expect(await one(`select title, done from public.task_subtasks where id = $1`, [w.step])).toEqual({
      title: 'Rough cut',
      done: false,
    });
  });

  it('the task’s creator, assignee and owners/admins manage it; other members cannot', async () => {
    const w = await checklistWorld();
    for (const user of [w.carol, w.dave, w.alice, w.bob]) {
      expect(ok(await addSubtask(w.carol, w.wsA, w.task, `by ${user.label}`)).length).toBe(1);
      ok(await addSubtask(user, w.wsA, w.task, `from ${user.label}`));
      expect(
        ok(await db().affected(user, `update public.task_subtasks set done = not done where id = $1`, [w.step])),
        user.label,
      ).toBe(1);
    }
    fails(await addSubtask(w.gina, w.wsA, w.task), '42501');
    expect(ok(await db().affected(w.gina, `update public.task_subtasks set done = true where id = $1`, [w.step]))).toBe(0);
    expect(ok(await db().affected(w.gina, `delete from public.task_subtasks where id = $1`, [w.step]))).toBe(0);
    for (const user of [w.erin, w.mallory]) {
      fails(await addSubtask(user, w.wsA, w.task), '42501');
    }
    expect(ok(await db().affected(w.dave, `delete from public.task_subtasks where id = $1`, [w.step]))).toBe(1);
  });

  it('cannot point at a task of another workspace, nor move to another task', async () => {
    const w = await checklistWorld();
    const taskB = await createTask(db(), w.gina, w.wsB);
    // gina is admin in B and a member in A: only the foreign key stops the mix.
    fails(await addSubtask(w.gina, w.wsA, taskB), '23503');
    const otherA = await createTask(db(), w.carol, w.wsA);
    fails(
      await db().affected(w.carol, `update public.task_subtasks set task_id = $2 where id = $1`, [w.step, otherA]),
      '42501',
    );
  });

  it('disappears with its task', async () => {
    const w = await checklistWorld();
    expect(ok(await db().affected(w.carol, `delete from public.tasks where id = $1`, [w.task]))).toBe(1);
    expect(await one(`select count(*)::int as n from public.task_subtasks where id = $1`, [w.step])).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

function comment(who: TestUser, workspaceId: string, taskId: string, body = 'Looks good', author?: string) {
  return db().query<{ id: string }>(
    who,
    author
      ? `insert into public.task_comments (workspace_id, task_id, body, author_id) values ($1, $2, $3, $4) returning id`
      : `insert into public.task_comments (workspace_id, task_id, body) values ($1, $2, $3) returning id`,
    author ? [workspaceId, taskId, body, author] : [workspaceId, taskId, body],
  );
}

describe('task comments', () => {
  it('any active member comments as themselves; nobody comments as someone else', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA);
    for (const user of [w.alice, w.bob, w.carol, w.dave, w.gina]) {
      const id = only(ok(await comment(user, w.wsA, task))).id;
      expect(await one(`select author_id from public.task_comments where id = $1`, [id])).toEqual({ author_id: user.id });
    }
    fails(await comment(w.dave, w.wsA, task, 'as carol', w.carol.id), '42501');
    for (const user of [w.erin, w.frank, w.mallory]) {
      fails(await comment(user, w.wsA, task), '42501');
      expect(await visibleIds(db(), user, 'task_comments'), user.label).toEqual([]);
    }
    fails(await comment(w.carol, w.wsA, task, '   '), '23514');
  });

  it('authors edit their own comments (marked edited); authors and owners/admins delete', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA);
    const daves = only(ok(await comment(w.dave, w.wsA, task, 'first'))).id;
    for (const user of [w.alice, w.bob, w.carol, w.gina]) {
      expect(ok(await db().affected(user, `update public.task_comments set body = 'x' where id = $1`, [daves])), user.label).toBe(0);
    }
    expect(await one(`select edited_at from public.task_comments where id = $1`, [daves])).toEqual({ edited_at: null });
    expect(ok(await db().affected(w.dave, `update public.task_comments set body = 'second' where id = $1`, [daves]))).toBe(1);
    const edited = await one<{ body: string; edited: boolean }>(
      `select body, edited_at is not null as edited from public.task_comments where id = $1`,
      [daves],
    );
    expect(edited).toEqual({ body: 'second', edited: true });

    // A member cannot delete someone else's comment; an admin can.
    expect(ok(await db().affected(w.carol, `delete from public.task_comments where id = $1`, [daves]))).toBe(0);
    expect(ok(await db().affected(w.bob, `delete from public.task_comments where id = $1`, [daves]))).toBe(1);
    const own = only(ok(await comment(w.gina, w.wsA, task))).id;
    expect(ok(await db().affected(w.gina, `delete from public.task_comments where id = $1`, [own]))).toBe(1);
  });

  it('a removed member loses the thread, including their own comments', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.carol, w.wsA);
    const daves = only(ok(await comment(w.dave, w.wsA, task))).id;
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    expect(await visibleIds(db(), w.dave, 'task_comments')).toEqual([]);
    expect(ok(await db().affected(w.dave, `update public.task_comments set body = 'x' where id = $1`, [daves]))).toBe(0);
    fails(await comment(w.dave, w.wsA, task), '42501');
  });
});

// ---------------------------------------------------------------------------------------------
// Time attribution
// ---------------------------------------------------------------------------------------------

function attribute(who: TestUser, ids: string[], projectId: string | null, taskId: string | null = null) {
  return db().query<{ n: number }>(who, `select public.set_time_entry_attribution($1::uuid[], $2, $3) as n`, [
    ids,
    projectId,
    taskId,
  ]);
}

async function attribution(id: string): Promise<{ project_id: string | null; task_id: string | null }> {
  return one(`select project_id, task_id from public.time_entries where id = $1`, [id]);
}

describe('attributing tracked time', () => {
  it('the owner attributes entries to a project or a task; the task decides the project', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    const other = await createProject(db(), w.alice, w.wsA, 'Other');
    const task = await createTask(db(), w.carol, w.wsA, { projectId: project });
    const loose = await createTask(db(), w.carol, w.wsA);
    const [a, b] = await syncOk(db(), w.carol, w.wsA, [entry(), entry()]);
    const measured = await one(`select started_at, ended_at, active_ms::int as active, idle_ms::int as idle from public.time_entries where id = $1`, [a]);

    expect(only(ok(await attribute(w.carol, [a!, b!], project))).n).toBe(2);
    expect(await attribution(a!)).toEqual({ project_id: project, task_id: null });

    // Choosing a task sets its project, whatever project was passed.
    expect(only(ok(await attribute(w.carol, [a!], other, task))).n).toBe(1);
    expect(await attribution(a!)).toEqual({ project_id: project, task_id: task });
    expect(only(ok(await attribute(w.carol, [b!], other, loose))).n).toBe(1);
    expect(await attribution(b!)).toEqual({ project_id: null, task_id: loose });

    // Clearing.
    expect(only(ok(await attribute(w.carol, [a!, b!], null))).n).toBe(2);
    expect(await attribution(a!)).toEqual({ project_id: null, task_id: null });
    // The measured values never change.
    expect(await one(`select started_at, ended_at, active_ms::int as active, idle_ms::int as idle from public.time_entries where id = $1`, [a])).toEqual(measured);
  });

  it('nobody attributes someone else’s entries, not even a workspace owner who can read them', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    ok(await db().affected(w.alice, `select public.set_time_entry_visibility($1, 'admins')`, [w.wsA]));
    const [carols] = await syncOk(db(), w.carol, w.wsA, [entry()]);
    for (const user of [w.alice, w.bob, w.dave, w.erin, w.mallory]) {
      const outcome = await attribute(user, [carols!], project);
      if (outcome.ok) expect(only(outcome.value).n, user.label).toBe(0);
      expect(
        ok(await db().affected(user, `update public.time_entries set project_id = $2 where id = $1`, [carols, project])),
        user.label,
      ).toBe(0);
    }
    expect(await attribution(carols!)).toEqual({ project_id: null, task_id: null });
  });

  it('only projects and tasks of the entry’s own workspace; other workspaces’ entries are left alone', async () => {
    const w = await buildWorld(db());
    const projectA = await createProject(db(), w.alice, w.wsA);
    const projectB = await createProject(db(), w.erin, w.wsB);
    const taskB = await createTask(db(), w.gina, w.wsB);
    // gina tracks time in both workspaces.
    const [inA] = await syncOk(db(), w.gina, w.wsA, [entry()]);
    const [inB] = await syncOk(db(), w.gina, w.wsB, [entry()]);

    // The RPC only touches entries of the target's workspace.
    expect(only(ok(await attribute(w.gina, [inA!, inB!], projectB))).n).toBe(1);
    expect(await attribution(inA!)).toEqual({ project_id: null, task_id: null });
    expect(await attribution(inB!)).toEqual({ project_id: projectB, task_id: null });
    // A direct update across workspaces is refused by the foreign keys.
    fails(await db().affected(w.gina, `update public.time_entries set project_id = $2 where id = $1`, [inA, projectB]), '23503');
    fails(await db().affected(w.gina, `update public.time_entries set task_id = $2 where id = $1`, [inA, taskB]), '23503');
    expect(only(ok(await attribute(w.gina, [inA!], projectA))).n).toBe(1);
    // Unknown targets are an error, not a silent no-op.
    fails(await attribute(w.gina, [inA!], '00000000-0000-4000-8000-0000000000ff'), 'P0002');
  });

  it('archived projects and tasks keep their time but take no new time', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    const task = await createTask(db(), w.carol, w.wsA, { projectId: project });
    const [kept, fresh] = await syncOk(db(), w.carol, w.wsA, [entry(), entry()]);
    ok(await attribute(w.carol, [kept!], project, task));

    ok(await db().affected(w.carol, `update public.tasks set status = 'archived' where id = $1`, [task]));
    fails(await attribute(w.carol, [fresh!], project, task), '22023');
    ok(await db().affected(w.alice, `update public.projects set status = 'archived' where id = $1`, [project]));
    fails(await attribute(w.carol, [fresh!], project), '22023');

    // History is untouched by archiving.
    expect(await attribution(kept!)).toEqual({ project_id: project, task_id: task });
    // Re-saving an existing attribution is not "new" time.
    expect(
      ok(await db().affected(w.carol, `update public.time_entries set project_id = project_id, task_id = task_id where id = $1`, [kept])),
    ).toBe(1);
  });

  it('a removed member can no longer attribute their own entries', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    const [mine] = await syncOk(db(), w.dave, w.wsA, [entry()]);
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    // The project is no longer visible to them, and their entries are outside the UPDATE policy.
    fails(await attribute(w.dave, [mine!], project), 'P0002');
    expect(
      ok(await db().affected(w.dave, `update public.time_entries set project_id = $2 where id = $1`, [mine, project])),
    ).toBe(0);
    expect(await attribution(mine!)).toEqual({ project_id: null, task_id: null });
  });

  it('refuses more than 1000 ids per call and an anonymous caller', async () => {
    const w = await buildWorld(db());
    const ids = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    fails(await attribute(w.carol, ids, null), '54000');
    const anonymous = await db().asClaims('authenticated', { role: 'authenticated' }, (s) =>
      s.query(`select public.set_time_entry_attribution($1::uuid[]) as n`, [[]]),
    );
    fails(anonymous, '28000');
  });

  it('totals count each entry once, whatever its attribution', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    const task = await createTask(db(), w.carol, w.wsA, { projectId: project });
    const payloads = [entry(), entry(), entry()];
    const ids = await syncOk(db(), w.carol, w.wsA, payloads);
    ok(await attribute(w.carol, ids.slice(0, 2), project, task));
    // A retried upload of the same intervals adds nothing and keeps the attribution.
    await syncOk(db(), w.carol, w.wsA, payloads);
    expect(await one(`select count(*)::int as n from public.time_entries where id = any($1::uuid[])`, [ids])).toEqual({ n: 3 });
    expect(await attribution(ids[0]!)).toEqual({ project_id: project, task_id: task });
    const totals = await db().query<{ project_ms: string; task_ms: string; all_ms: string }>(
      w.carol,
      `select (select coalesce(sum(active_ms), 0)::text from public.time_entries where project_id = $1) as project_ms,
              (select coalesce(sum(active_ms), 0)::text from public.time_entries where task_id = $2) as task_ms,
              (select coalesce(sum(active_ms), 0)::text from public.time_entries where id = any($3::uuid[])) as all_ms`,
      [project, task, ids],
    );
    const row = only(ok(totals));
    expect(row.project_ms).toBe(row.task_ms);
    expect(Number(row.all_ms)).toBeGreaterThan(Number(row.project_ms));
  });
});

// ---------------------------------------------------------------------------------------------
// Migration 9: former members and moved tasks
// ---------------------------------------------------------------------------------------------

describe('former members and moved tasks', () => {
  it('owners still archive, restore and edit a project whose lead left; a new lead must be active', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    ok(await db().affected(w.alice, `update public.projects set lead_id = $2 where id = $1`, [project, w.carol.id]));
    ok(await removeMember(db(), w.alice, w.wsA, w.carol));

    // Edits that keep the former lead work, also when the client sends the unchanged lead again.
    expect(ok(await db().affected(w.alice, `update public.projects set status = 'archived' where id = $1`, [project]))).toBe(1);
    expect(
      ok(
        await db().affected(w.alice, `update public.projects set status = 'active', name = 'Kept', lead_id = $2 where id = $1`, [
          project,
          w.carol.id,
        ]),
      ),
    ).toBe(1);
    // Handing the lead to someone who isn't an active member is refused; to a member it works.
    fails(await db().affected(w.alice, `update public.projects set lead_id = $2 where id = $1`, [project, w.erin.id]), '42501', /active member/);
    expect(ok(await db().affected(w.alice, `update public.projects set lead_id = $2 where id = $1`, [project, w.dave.id]))).toBe(1);
    expect(await one(`select name, status::text as status, lead_id from public.projects where id = $1`, [project])).toEqual({
      name: 'Kept',
      status: 'active',
      lead_id: w.dave.id,
    });
    // The former lead can't edit, and a lead still can't hand the project on.
    expect(ok(await db().affected(w.carol, `update public.projects set name = 'Gone' where id = $1`, [project]))).toBe(0);
    fails(await db().affected(w.dave, `update public.projects set lead_id = $2 where id = $1`, [project, w.gina.id]), '42501');
  });

  it('moving a task moves everyone’s time on it; into an archived project it is refused', async () => {
    const w = await buildWorld(db());
    const first = await createProject(db(), w.alice, w.wsA);
    const second = await createProject(db(), w.alice, w.wsA, 'Second');
    const closed = await createProject(db(), w.alice, w.wsA, 'Closed');
    const task = await createTask(db(), w.carol, w.wsA, { projectId: first });
    const [mine] = await syncOk(db(), w.carol, w.wsA, [entry()]);
    const [theirs] = await syncOk(db(), w.dave, w.wsA, [entry()]);
    ok(await attribute(w.carol, [mine!], first, task));
    ok(await attribute(w.dave, [theirs!], first, task));
    const measured = await one(`select started_at, ended_at, active_ms::int as active from public.time_entries where id = $1`, [theirs]);

    // Carol moves the task: Dave's time on it follows too, though she can't read it.
    expect(ok(await db().affected(w.carol, `update public.tasks set project_id = $2 where id = $1`, [task, second]))).toBe(1);
    expect(await attribution(mine!)).toEqual({ project_id: second, task_id: task });
    expect(await attribution(theirs!)).toEqual({ project_id: second, task_id: task });
    expect(await one(`select started_at, ended_at, active_ms::int as active from public.time_entries where id = $1`, [theirs])).toEqual(measured);

    // Into an archived project: refused, and nothing moves.
    ok(await db().affected(w.alice, `update public.projects set status = 'archived' where id = $1`, [closed]));
    fails(await db().affected(w.carol, `update public.tasks set project_id = $2 where id = $1`, [task, closed]), '22023');
    expect(await one(`select project_id from public.tasks where id = $1`, [task])).toEqual({ project_id: second });
    expect(await attribution(theirs!)).toEqual({ project_id: second, task_id: task });

    // Out of any project: the time keeps its task and has no project.
    expect(ok(await db().affected(w.carol, `update public.tasks set project_id = null where id = $1`, [task]))).toBe(1);
    expect(await attribution(mine!)).toEqual({ project_id: null, task_id: task });
  });
});
