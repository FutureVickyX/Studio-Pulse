/**
 * Length limits bound what is stored, not just the trimmed value (migration 7/7): padding a name
 * with spaces cannot smuggle an arbitrarily large value past the 80/120/200-character checks.
 */

import { describe, expect, it } from 'vitest';

import { createProject, createTask, createWorkspace, entry, fails, invite, newUser, ok, syncOk, useDatabase } from './fixtures';

const db = useDatabase();

const PAD = ' '.repeat(10_000);

async function stored(sql: string, id: string): Promise<string> {
  const [row] = await db().admin<{ v: string }>(sql, [id]);
  return row?.v ?? '';
}

describe('names and titles are stored trimmed, so their limits hold', () => {
  it('profiles.display_name', async () => {
    const user = await newUser(db(), 'pad');
    expect(
      ok(await db().affected(user, `update public.profiles set display_name = $2 where id = $1`, [user.id, `X${PAD}`])),
    ).toBe(1);
    expect(await stored(`select display_name as v from public.profiles where id = $1`, user.id)).toBe('X');
    fails(
      await db().affected(user, `update public.profiles set display_name = $2 where id = $1`, [user.id, 'x'.repeat(81)]),
      '23514',
    );
  });

  it('workspaces.name', async () => {
    const owner = await newUser(db(), 'owner');
    const ws = await createWorkspace(db(), owner);
    ok(await db().affected(owner, `update public.workspaces set name = $2 where id = $1`, [ws, `  W${PAD}`]));
    expect(await stored(`select name as v from public.workspaces where id = $1`, ws)).toBe('W');
  });

  it('projects.name and tasks.title', async () => {
    const owner = await newUser(db(), 'owner');
    const ws = await createWorkspace(db(), owner);
    const project = await createProject(db(), owner, ws, `P${PAD}`);
    expect(await stored(`select name as v from public.projects where id = $1`, project)).toBe('P');
    const task = await createTask(db(), owner, ws, { title: `T${PAD}` });
    expect(await stored(`select title as v from public.tasks where id = $1`, task)).toBe('T');
    ok(await db().affected(owner, `update public.tasks set title = $2 where id = $1`, [task, `${PAD}U${PAD}`]));
    expect(await stored(`select title as v from public.tasks where id = $1`, task)).toBe('U');
    fails(
      await db().affected(owner, `insert into public.tasks (workspace_id, title) values ($1, $2)`, [ws, 't'.repeat(201)]),
      '23514',
    );
  });

  it('time_entries.application_name uploaded through sync_time_entries', async () => {
    const owner = await newUser(db(), 'owner');
    const ws = await createWorkspace(db(), owner);
    const padded = entry({ applicationName: `Figma${PAD}` });
    await syncOk(db(), owner, ws, [padded]);
    expect(await stored(`select application_name as v from public.time_entries where id = $1`, padded.id)).toBe('Figma');
  });
});

describe('invitation emails', () => {
  it('are at most 320 characters', async () => {
    const owner = await newUser(db(), 'owner');
    const ws = await createWorkspace(db(), owner);
    fails(await invite(db(), owner, ws, `${'a'.repeat(320)}@example.test`, 'member'), '23514');
    ok(await invite(db(), owner, ws, `${'a'.repeat(64)}@example.test`, 'member'));
  });
});
