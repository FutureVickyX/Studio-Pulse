/**
 * The migration runner (scripts/supabase/migrations.mjs › applyMigrations) against a real Postgres
 * (PGlite) shaped like a fresh Supabase project, running as a non-superuser owner like Supabase's
 * `postgres` role. Covers: filename order, per-file transactions, the Supabase CLI history table,
 * skipping applied versions, refusal cases, and rollback of a failing file.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyMigrations, listMigrations, readAppliedVersions, splitStatements } from '../../../scripts/supabase/migrations.mjs';
import { MIGRATIONS_DIR, MIGRATION_OWNER, asQueryable, supabaseLikeDb } from './helpers';

// Each test boots a fresh PGlite (WASM Postgres): seconds alone, far more while the full suite runs in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let pg: PGlite;
const dirs: string[] = [];

beforeEach(async () => {
  pg = await supabaseLikeDb();
  await pg.exec(`set role ${MIGRATION_OWNER}`);
});
afterEach(async () => {
  await pg.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempMigrations(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'sp-migrate-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return listMigrations(dir).migrations;
}

async function history() {
  const result = await pg.query<{ version: string; name: string; statements: string[] }>(
    'select version, name, statements from supabase_migrations.schema_migrations order by version',
  );
  return result.rows;
}

async function tableExists(name: string) {
  const result = await pg.query<{ present: boolean }>('select to_regclass($1) is not null as present', [name]);
  return result.rows[0]?.present ?? false;
}

describe('applyMigrations on a fresh Supabase-shaped database', () => {
  it('applies the repository migrations in order and records them like the Supabase CLI', async () => {
    const db = asQueryable(pg);
    const { migrations } = listMigrations(MIGRATIONS_DIR);
    expect(await readAppliedVersions(db)).toEqual([]);

    const appliedNames: string[] = [];
    const result = await applyMigrations(db, migrations, { onApplied: (m) => appliedNames.push(m.file) });
    expect(result.status).toBe('applied');
    expect(appliedNames).toEqual(migrations.map((m) => m.file));

    const rows = await history();
    expect(rows.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
    expect(rows.map((r) => r.name)).toEqual(migrations.map((m) => m.name));
    rows.forEach((row, i) => {
      expect(row.statements.length).toBeGreaterThan(0);
      expect(row.statements).toEqual(splitStatements(readFileSync(migrations[i]!.path, 'utf8')));
    });
    for (const table of ['profiles', 'workspaces', 'workspace_members', 'workspace_invitations', 'projects', 'tasks', 'notes', 'time_entries']) {
      expect(await tableExists(`public.${table}`), table).toBe(true);
    }
    // The history table has the CLI's shape: version text primary key, statements text[], name text.
    const columns = await pg.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema = 'supabase_migrations' and table_name = 'schema_migrations' order by ordinal_position`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'version', data_type: 'text' },
      { column_name: 'statements', data_type: 'ARRAY' },
      { column_name: 'name', data_type: 'text' },
    ]);
  });

  it('is idempotent: a second run applies nothing and changes nothing', async () => {
    const db = asQueryable(pg);
    const { migrations } = listMigrations(MIGRATIONS_DIR);
    await applyMigrations(db, migrations);
    const before = await history();
    const second = await applyMigrations(db, migrations);
    expect(second).toEqual({ status: 'applied', applied: [], skipped: [] });
    expect(await history()).toEqual(before);
  });

  it('applies only the pending files of a partially migrated database', async () => {
    const db = asQueryable(pg);
    const { migrations } = listMigrations(MIGRATIONS_DIR);
    const first = await applyMigrations(db, migrations.slice(0, 1));
    expect(first.status === 'applied' && first.applied.map((m) => m.file)).toEqual([migrations[0]!.file]);
    const rest = await applyMigrations(db, migrations);
    expect(rest.status === 'applied' && rest.applied.map((m) => m.file)).toEqual(migrations.slice(1).map((m) => m.file));
  });

  it('rolls back a failing file completely and does not attempt later files', async () => {
    const db = asQueryable(pg);
    const migrations = tempMigrations({
      '1_first.sql': 'create table public.first_table (id int primary key);',
      '2_broken.sql': 'create table public.half_done (id int);\ninsert into public.missing_table values (1);',
      '3_later.sql': 'create table public.later_table (id int);',
    });
    const result = await applyMigrations(db, migrations);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failed.file).toBe('2_broken.sql');
    expect(result.applied.map((m) => m.file)).toEqual(['1_first.sql']);
    expect((result.error as { code?: string }).code).toBe('42P01');
    expect(await tableExists('public.first_table')).toBe(true);
    expect(await tableExists('public.half_done')).toBe(false);
    expect(await tableExists('public.later_table')).toBe(false);
    expect((await history()).map((r) => r.version)).toEqual(['1']);

    // The connection is usable afterwards (the failed transaction was rolled back) and a fixed
    // file applies on the next run.
    const fixed = tempMigrations({
      '1_first.sql': 'create table public.first_table (id int primary key);',
      '2_broken.sql': 'create table public.half_done (id int);',
      '3_later.sql': 'create table public.later_table (id int);',
    });
    const retry = await applyMigrations(db, fixed);
    expect(retry.status === 'applied' && retry.applied.map((m) => m.file)).toEqual(['2_broken.sql', '3_later.sql']);
  });

  it('refuses when the database records a version with no local file, changing nothing', async () => {
    const db = asQueryable(pg);
    await applyMigrations(db, tempMigrations({ '1_a.sql': 'create table public.a (id int);', '2_b.sql': 'create table public.b (id int);' }));
    const result = await applyMigrations(db, tempMigrations({ '1_a.sql': 'select 1;', '3_c.sql': 'create table public.c (id int);' }));
    expect(result).toEqual({ status: 'refused', reason: 'unknownApplied', versions: ['2'] });
    expect(await tableExists('public.c')).toBe(false);
  });

  it('refuses pending files older than the newest applied one unless includeAll', async () => {
    const db = asQueryable(pg);
    await applyMigrations(db, tempMigrations({ '1_a.sql': 'create table public.a (id int);', '3_c.sql': 'create table public.c (id int);' }));
    const local = tempMigrations({
      '1_a.sql': 'select 1;',
      '2_b.sql': 'create table public.b (id int);',
      '3_c.sql': 'select 1;',
    });
    expect(await applyMigrations(db, local)).toEqual({ status: 'refused', reason: 'outOfOrder', versions: ['2'] });
    expect(await tableExists('public.b')).toBe(false);
    const forced = await applyMigrations(db, local, { includeAll: true });
    expect(forced.status === 'applied' && forced.applied.map((m) => m.version)).toEqual(['2']);
    expect(await tableExists('public.b')).toBe(true);
  });

  it('skips a file another runner applied in the meantime', async () => {
    const db = asQueryable(pg);
    const migrations = tempMigrations({ '1_a.sql': 'create table public.a (id int);' });
    // Simulate a concurrent runner: the history row appears between planning and applying.
    let injected = false;
    const racing = {
      async query(text: string, params?: readonly unknown[]) {
        if (!injected && text.startsWith('select pg_advisory_xact_lock')) {
          injected = true;
          await pg.exec(
            "insert into supabase_migrations.schema_migrations (version, name, statements) values ('1', 'a', '{}')",
          );
        }
        return db.query(text, params);
      },
    };
    const skipped: string[] = [];
    const result = await applyMigrations(racing, migrations, { onSkipped: (m) => skipped.push(m.file) });
    expect(result).toEqual({ status: 'applied', applied: [], skipped: migrations });
    expect(skipped).toEqual(['1_a.sql']);
    expect(await tableExists('public.a')).toBe(false);
  });
});

