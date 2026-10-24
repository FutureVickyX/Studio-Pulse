/**
 * Privilege hygiene, checked from the catalog rather than by example: anon and authenticated
 * hold exactly the intended table, column, function and schema privileges (Supabase's default
 * privileges grant everything new in `public` to both, so anything a migration forgets to revoke
 * shows up here); every table has RLS with policies only for `authenticated`; every function pins
 * its search_path; SECURITY DEFINER is used exactly where intended, by a non-superuser owner.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { PERMISSION_DENIED, fails, newUser, useDatabase } from './fixtures';
import { MIGRATION_OWNER } from './harness';

const db = useDatabase();

type ColumnPrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'REFERENCES';
type TablePrivilege = ColumnPrivilege | 'DELETE' | 'TRUNCATE' | 'TRIGGER';

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
type Table = (typeof TABLES)[number];

const ALL = '*';

/** Table-level privileges of `authenticated` (anon has none anywhere). */
const TABLE_GRANTS: Record<Table, TablePrivilege[]> = {
  notes: ['DELETE', 'SELECT'],
  profiles: ['SELECT'],
  projects: ['DELETE', 'SELECT'],
  tasks: ['DELETE', 'SELECT'],
  time_entries: ['DELETE', 'SELECT'],
  workspace_invitations: [],
  workspace_members: ['SELECT'],
  workspaces: ['DELETE', 'SELECT'],
};

/** Effective column privileges of `authenticated` (table- or column-level). */
const COLUMN_GRANTS: Record<Table, Partial<Record<ColumnPrivilege, typeof ALL | string[]>>> = {
  notes: {
    SELECT: ALL,
    INSERT: ['body', 'owner_id', 'pinned', 'project_id', 'title', 'visibility', 'workspace_id'],
    UPDATE: ['body', 'pinned', 'project_id', 'title', 'visibility'],
  },
  profiles: { SELECT: ALL, UPDATE: ['display_name'] },
  projects: {
    SELECT: ALL,
    INSERT: ['created_by', 'description', 'name', 'status', 'workspace_id'],
    UPDATE: ['description', 'name', 'status'],
  },
  tasks: {
    SELECT: ALL,
    INSERT: [
      'assignee_id',
      'created_by',
      'description',
      'due_date',
      'estimated_minutes',
      'priority',
      'project_id',
      'start_date',
      'status',
      'title',
      'workspace_id',
    ],
    UPDATE: [
      'assignee_id',
      'description',
      'due_date',
      'estimated_minutes',
      'priority',
      'project_id',
      'start_date',
      'status',
      'title',
    ],
  },
  time_entries: {
    SELECT: ALL,
    INSERT: [
      'active_ms',
      'application_id',
      'application_name',
      'device_id',
      'end_reason',
      'ended_at',
      'id',
      'idle_ms',
      'kind',
      'local_revision',
      'project_id',
      'recorded_at',
      'source',
      'started_at',
      'task_id',
      'user_id',
      'workspace_id',
    ],
  },
  workspace_invitations: {
    // Everything except token_hash.
    SELECT: [
      'accepted_at',
      'accepted_by',
      'created_at',
      'email',
      'expires_at',
      'id',
      'invited_by',
      'revoked_at',
      'role',
      'workspace_id',
    ],
  },
  workspace_members: { SELECT: ALL },
  workspaces: { SELECT: ALL, UPDATE: ['name'] },
};

/** Policy commands per table (all `to authenticated`). */
const POLICY_COMMANDS: Record<Table, string[]> = {
  notes: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  profiles: ['SELECT', 'UPDATE'],
  projects: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  tasks: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  time_entries: ['DELETE', 'INSERT', 'SELECT'],
  workspace_invitations: ['SELECT'],
  workspace_members: ['SELECT'],
  workspaces: ['DELETE', 'SELECT', 'UPDATE'],
};

/** Functions in `public` that `authenticated` may execute: exactly the RPCs. */
const AUTHENTICATED_FUNCTIONS = [
  'accept_invitation',
  'create_invitation',
  'create_workspace',
  'my_workspaces',
  'remove_member',
  'revoke_invitation',
  'set_member_role',
  'set_time_entry_visibility',
  'sync_time_entries',
].sort();

/**
 * The RLS helpers policies call as the user. They live in `private`, which PostgREST does not
 * expose, so they are not `/rest/v1/rpc/*` endpoints (migration 5/5).
 */
const PRIVATE_FUNCTIONS = [
  'has_workspace_role',
  'is_active_member',
  'is_workspace_member',
  'shares_workspace_with',
].sort();

const TRIGGER_FUNCTIONS = [
  'handle_new_user',
  'notes_bump_version',
  'notes_owner_fixed',
  'prevent_workspace_change',
  'promote_successor_owner',
  'set_updated_at',
  'tasks_track_completion',
  'trim_bounded_text',
].sort();

/** SECURITY DEFINER exactly where the migrations intend it (sync_time_entries is INVOKER). */
const SECURITY_DEFINER_FUNCTIONS = [
  'accept_invitation',
  'create_invitation',
  'create_workspace',
  'handle_new_user',
  'my_workspaces',
  'promote_successor_owner',
  'remove_member',
  'revoke_invitation',
  'set_member_role',
  'set_time_entry_visibility',
].sort();

/** A role with no grants and no memberships: what PUBLIC (every role) can do. */
const NOBODY = 'probe_nobody';

let columnsOf: Record<string, string[]>;

beforeAll(async () => {
  await db().admin(`create role ${NOBODY} nologin noinherit`);
  const rows = await db().admin<{ table: string; column: string }>(
    `select c.relname as table, a.attname as column
       from pg_class c
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      order by 1, 2`,
  );
  columnsOf = {};
  for (const row of rows) (columnsOf[row.table] ??= []).push(row.column);
});

async function tablePrivileges(role: string): Promise<Record<string, string[]>> {
  const rows = await db().admin<{ table: string; privileges: string[] }>(
    `select c.relname as table,
            array_remove(array_agg(p.priv order by p.priv), null) as privileges
       from pg_class c
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_table_privilege($1, c.oid, p.priv)
      group by c.relname`,
    [role],
  );
  return Object.fromEntries(rows.map((row) => [row.table, row.privileges]));
}

async function columnPrivileges(role: string): Promise<Record<string, Record<string, string[]>>> {
  const rows = await db().admin<{ table: string; priv: string; columns: string[] }>(
    `select c.relname as table, p.priv, array_agg(a.attname::text order by a.attname) as columns
       from pg_class c
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p(priv)
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_column_privilege($1, c.oid, a.attnum, p.priv)
      group by c.relname, p.priv`,
    [role],
  );
  const result: Record<string, Record<string, string[]>> = {};
  for (const row of rows) (result[row.table] ??= {})[row.priv] = row.columns;
  return result;
}

interface FunctionInfo {
  name: string;
  security_definer: boolean;
  config: string[] | null;
  owner: string;
  owner_is_superuser: boolean;
  is_trigger: boolean;
  anon: boolean;
  authenticated: boolean;
  nobody: boolean;
}

async function functions(schema: 'public' | 'private' = 'public'): Promise<FunctionInfo[]> {
  return db().admin<FunctionInfo & Record<string, unknown>>(
    `select p.proname as name, p.prosecdef as security_definer, p.proconfig as config,
            r.rolname as owner, r.rolsuper as owner_is_superuser,
            p.prorettype = 'trigger'::regtype as is_trigger,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
            has_function_privilege('${NOBODY}', p.oid, 'EXECUTE') as nobody
       from pg_proc p
       join pg_roles r on r.oid = p.proowner
      where p.pronamespace = $1::regnamespace
      order by p.proname`,
    [schema],
  );
}

describe('tables', () => {
  it('public contains exactly the tested tables, and no views, sequences or foreign tables', async () => {
    const rows = await db().admin<{ name: string; kind: string }>(
      `select relname as name, relkind::text as kind from pg_class
        where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'S', 'f')
        order by 1`,
    );
    expect(rows).toEqual(TABLES.map((name) => ({ name, kind: 'r' })));
  });

  it('every table has row level security enabled', async () => {
    const rows = await db().admin<{ name: string; rls: boolean }>(
      `select relname as name, relrowsecurity as rls from pg_class
        where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by 1`,
    );
    expect(rows).toEqual(TABLES.map((name) => ({ name, rls: true })));
  });

  it('every policy applies to authenticated only, with the intended commands', async () => {
    const rows = await db().admin<{ table: string; roles: string; cmd: string; qual: string | null; with_check: string | null }>(
      `select tablename as table, roles::text as roles, cmd, qual, with_check
         from pg_policies where schemaname = 'public' order by 1, 3`,
    );
    for (const row of rows) {
      expect(row.roles, `${row.table} ${row.cmd}`).toBe('{authenticated}');
      // No policy is unconditionally true.
      expect(row.qual?.trim(), `${row.table} ${row.cmd}`).not.toBe('true');
      expect(row.with_check?.trim(), `${row.table} ${row.cmd}`).not.toBe('true');
    }
    const commands: Record<string, string[]> = {};
    for (const row of rows) (commands[row.table] ??= []).push(row.cmd);
    for (const list of Object.values(commands)) list.sort();
    expect(commands).toEqual(POLICY_COMMANDS);
  });

  it('policies evaluate auth.uid() once per statement, as (select auth.uid())', async () => {
    const rows = await db().admin<{ name: string; qual: string | null; with_check: string | null }>(
      `select tablename || '.' || policyname as name, qual, with_check
         from pg_policies where schemaname = 'public' order by 1`,
    );
    for (const row of rows) {
      for (const expression of [row.qual, row.with_check]) {
        // Postgres prints a scalar subquery as `( SELECT auth.uid() AS uid)`.
        expect(expression ?? '', row.name).not.toMatch(/(?<!SELECT )auth\.uid\(\)/);
      }
    }
  });

  it('every foreign key has an index leading with its columns', async () => {
    const rows = await db().admin<{ name: string }>(
      `select c.conrelid::regclass::text || '.' || c.conname as name
         from pg_constraint c
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace
          and not exists (
            select 1 from pg_index i
             where i.indrelid = c.conrelid
               and (select array_agg(k order by k)
                      from unnest((string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)]) k)
                 = (select array_agg(k order by k) from unnest(c.conkey) k))
        order by 1`,
    );
    expect(rows).toEqual([]);
  });

  it('anon and PUBLIC hold no privilege on any table or column', async () => {
    for (const role of ['anon', NOBODY]) {
      expect(await tablePrivileges(role), role).toEqual({});
      expect(await columnPrivileges(role), role).toEqual({});
    }
  });

  it('authenticated holds exactly the intended table-level privileges', async () => {
    const actual = await tablePrivileges('authenticated');
    const expected = Object.fromEntries(
      Object.entries(TABLE_GRANTS)
        .filter(([, privileges]) => privileges.length > 0)
        .map(([table, privileges]) => [table, [...privileges].sort()]),
    );
    expect(actual).toEqual(expected);
  });

  it('authenticated holds exactly the intended column privileges', async () => {
    const expected: Record<string, Record<string, string[]>> = {};
    for (const table of TABLES) {
      const columns = columnsOf[table] ?? [];
      for (const [privilege, grant] of Object.entries(COLUMN_GRANTS[table])) {
        const list = grant === ALL ? [...columns] : [...grant];
        // The expectation itself must name real columns.
        for (const column of list) expect(columns, `${table}.${column}`).toContain(column);
        (expected[table] ??= {})[privilege] = list.sort();
      }
    }
    expect(await columnPrivileges('authenticated')).toEqual(expected);
  });

  it('time entries are never updatable and invitation token hashes never readable', async () => {
    const rows = await db().admin<{ update_any: boolean; hash_select: boolean }>(
      `select has_any_column_privilege('authenticated', 'public.time_entries', 'UPDATE') as update_any,
              has_column_privilege('authenticated', 'public.workspace_invitations', 'token_hash', 'SELECT') as hash_select`,
    );
    expect(rows).toEqual([{ update_any: false, hash_select: false }]);
  });

  it('auth.users is not readable or writable by clients', async () => {
    const rows = await db().admin<{ role: string; any: boolean }>(
      `select r as role,
              has_table_privilege(r, 'auth.users', 'SELECT') or has_any_column_privilege(r, 'auth.users', 'SELECT')
              or has_table_privilege(r, 'auth.users', 'INSERT') or has_table_privilege(r, 'auth.users', 'UPDATE')
              or has_table_privilege(r, 'auth.users', 'DELETE') as any
         from unnest(array['anon', 'authenticated']) as r`,
    );
    expect(rows).toEqual([
      { role: 'anon', any: false },
      { role: 'authenticated', any: false },
    ]);
  });
});

describe('functions', () => {
  it('anon and PUBLIC execute no function in public', async () => {
    const list = await functions();
    expect(list.filter((fn) => fn.anon).map((fn) => fn.name)).toEqual([]);
    expect(list.filter((fn) => fn.nobody).map((fn) => fn.name)).toEqual([]);
  });

  it('authenticated executes exactly the intended functions (no trigger functions)', async () => {
    const list = await functions();
    expect(list.filter((fn) => fn.authenticated).map((fn) => fn.name).sort()).toEqual(AUTHENTICATED_FUNCTIONS);
    expect(list.filter((fn) => fn.is_trigger).map((fn) => fn.name).sort()).toEqual(TRIGGER_FUNCTIONS);
    // Every function is accounted for.
    expect(list.map((fn) => fn.name).sort()).toEqual([...AUTHENTICATED_FUNCTIONS, ...TRIGGER_FUNCTIONS].sort());
  });

  it('SECURITY DEFINER exactly where intended, owned by the non-superuser migration owner', async () => {
    const list = await functions();
    expect(list.filter((fn) => fn.security_definer).map((fn) => fn.name).sort()).toEqual(SECURITY_DEFINER_FUNCTIONS);
    for (const fn of list) {
      expect(fn.owner, fn.name).toBe(MIGRATION_OWNER);
      expect(fn.owner_is_superuser, fn.name).toBe(false);
    }
  });

  it('every function pins an empty search_path (SECURITY DEFINER ones above all)', async () => {
    for (const fn of await functions()) {
      expect(fn.config ?? [], fn.name).toContain('search_path=""');
    }
  });

  it('the RLS helpers live in private: authenticated executes exactly them, anon and PUBLIC none', async () => {
    const list = await functions('private');
    expect(list.map((fn) => fn.name).sort()).toEqual(PRIVATE_FUNCTIONS);
    for (const fn of list) {
      expect(fn.authenticated, fn.name).toBe(true);
      expect(fn.anon, fn.name).toBe(false);
      expect(fn.nobody, fn.name).toBe(false);
      expect(fn.security_definer, fn.name).toBe(true);
      expect(fn.config ?? [], fn.name).toContain('search_path=""');
      expect(fn.owner, fn.name).toBe(MIGRATION_OWNER);
    }
    const objects = await db().admin<{ name: string }>(
      `select relname as name from pg_class where relnamespace = 'private'::regnamespace`,
    );
    expect(objects).toEqual([]);
  });

  it('the RLS helpers are not callable under public (no /rest/v1/rpc endpoint)', async () => {
    const user = await newUser(db(), 'rpc-prober');
    for (const name of PRIVATE_FUNCTIONS) {
      const outcome = await db().query(user, `select public.${name}(null)`);
      expect(outcome.ok, name).toBe(false);
      if (!outcome.ok) expect(outcome.error.code, name).toBe('42883');
    }
  });

  it('trigger functions cannot be called directly', async () => {
    const user = await newUser(db(), 'caller');
    for (const name of TRIGGER_FUNCTIONS) {
      const outcome = await db().query(user, `select public.${name}()`);
      expect(outcome.ok, name).toBe(false);
    }
  });
});

describe('schemas', () => {
  it('clients may use but not create objects in public or auth', async () => {
    const rows = await db().admin<{ role: string; schema: string; usage: boolean; create: boolean }>(
      `select r as role, s as schema,
              has_schema_privilege(r, s, 'USAGE') as usage,
              has_schema_privilege(r, s, 'CREATE') as create
         from unnest(array['anon', 'authenticated']) as r, unnest(array['auth', 'private', 'public']) as s
        order by 1, 2`,
    );
    expect(rows).toEqual([
      { role: 'anon', schema: 'auth', usage: true, create: false },
      { role: 'anon', schema: 'private', usage: false, create: false },
      { role: 'anon', schema: 'public', usage: true, create: false },
      { role: 'authenticated', schema: 'auth', usage: true, create: false },
      { role: 'authenticated', schema: 'private', usage: true, create: false },
      { role: 'authenticated', schema: 'public', usage: true, create: false },
    ]);
    const user = await newUser(db(), 'builder');
    fails(await db().query(user, `create table public.sneaky (id int)`), '42501', PERMISSION_DENIED);
    fails(
      await db().query(user, `create function public.sneaky() returns int language sql as 'select 1'`),
      '42501',
      PERMISSION_DENIED,
    );
  });
});

