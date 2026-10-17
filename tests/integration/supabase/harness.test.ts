/**
 * The emulation itself: if these fail, every other suite's verdict is meaningless. Checks that
 * roles have Supabase's attributes, that requests run as the right role with the right claims,
 * that claims never leak between requests, that failed requests roll back, and that the
 * migrations are applied in filename order.
 */

import { describe, expect, it } from 'vitest';

import { buildWorld, createTask, fails, newUser, ok, only, useDatabase, visibleIds } from './fixtures';
import { MIGRATION_OWNER, migrationFiles } from './harness';

const db = useDatabase();

describe('Supabase emulation', () => {
  it('applies every migration file, in filename order', async () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect([...files].sort()).toEqual(files);
    for (const file of files) expect(file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    const [time] = await db().admin<{ tz: string }>(`select current_setting('TimeZone') as tz`);
    expect(time?.tz).toBe('UTC');
  });

  it('roles have Supabase’s attributes', async () => {
    const rows = await db().admin<Record<string, unknown>>(
      `select rolname as name, rolsuper as super, rolbypassrls as bypassrls, rolcanlogin as login,
              rolinherit as inherit
         from pg_roles where rolname = any($1::text[]) order by rolname`,
      [['anon', 'authenticated', 'service_role', MIGRATION_OWNER]],
    );
    expect(rows).toEqual([
      { name: 'anon', super: false, bypassrls: false, login: false, inherit: false },
      { name: 'authenticated', super: false, bypassrls: false, login: false, inherit: false },
      { name: MIGRATION_OWNER, super: false, bypassrls: true, login: false, inherit: false },
      { name: 'service_role', super: false, bypassrls: true, login: false, inherit: false },
    ]);
  });

  it('runs a signed-in request as authenticated with the user’s JWT claims', async () => {
    const user = await newUser(db(), 'probe');
    const row = only(
      ok(
        await db().query<Record<string, unknown>>(
          user,
          `select current_user as role, auth.uid() as uid, auth.role() as jwt_role, auth.email() as email,
                  auth.jwt() ->> 'sub' as sub`,
        ),
      ),
    );
    expect(row).toEqual({ role: 'authenticated', uid: user.id, jwt_role: 'authenticated', email: user.email, sub: user.id });
  });

  it('creates users like GoTrue: the profile trigger fires', async () => {
    const user = await db().createUser(`ana.${Date.now()}@example.test`, 'Ana Lima');
    const [profile] = await db().admin<{ display_name: string }>(
      `select display_name from public.profiles where id = $1`,
      [user.id],
    );
    expect(profile?.display_name).toBe('Ana Lima');
  });

  it('runs anon and service-role requests without a user', async () => {
    const anon = only(ok(await db().query<Record<string, unknown>>('anon', `select current_user as role, auth.uid() as uid, auth.role() as jwt_role`)));
    expect(anon).toEqual({ role: 'anon', uid: null, jwt_role: 'anon' });
    const service = only(
      ok(await db().query<Record<string, unknown>>('service', `select current_user as role, auth.uid() as uid, auth.role() as jwt_role`)),
    );
    expect(service).toEqual({ role: 'service_role', uid: null, jwt_role: 'service_role' });
  });

  it('never leaks a role or claims into the next request', async () => {
    const user = await newUser(db(), 'leaky');
    ok(await db().query(user, `select 1`));
    const [after] = await db().admin<{ role: string; uid: string | null; claims: string | null }>(
      `select current_user as role, auth.uid() as uid,
              nullif(current_setting('request.jwt.claims', true), '') as claims`,
    );
    expect(after).toEqual({ role: 'postgres', uid: null, claims: null });
    const anon = only(ok(await db().query<{ uid: string | null }>('anon', `select auth.uid() as uid`)));
    expect(anon.uid).toBeNull();
  });

  it('rolls back a request that fails part-way', async () => {
    const w = await buildWorld(db());
    const before = await visibleIds(db(), w.carol, 'tasks');
    const outcome = await db().as(w.carol, async (session) => {
      await session.query(`insert into public.tasks (workspace_id, title) values ($1, 'half-done')`, [w.wsA]);
      return session.query(`select 1 / 0`);
    });
    fails(outcome, '22012');
    expect(await visibleIds(db(), w.carol, 'tasks')).toEqual(before);
    // The connection is usable afterwards.
    await createTask(db(), w.carol, w.wsA);
  });

  it('the service role bypasses RLS (admin tooling only; never shipped to clients)', async () => {
    const w = await buildWorld(db());
    const all = ok(await db().query<{ id: string }>('service', `select id from public.workspaces where id = any($1::uuid[])`, [[w.wsA, w.wsB]]));
    expect(all.map((row) => row.id).sort()).toEqual([w.wsA, w.wsB].sort());
    expect(await visibleIds(db(), w.mallory, 'workspaces')).toEqual([]);
  });
});
