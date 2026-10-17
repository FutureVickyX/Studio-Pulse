/**
 * The hand-written schema description (packages/database/src/schema.ts, which `tsc` ties to the
 * `Database` type in src/types.ts) compared with the catalog of a real Postgres after applying
 * supabase/migrations/*.sql. A migration that adds, removes or changes a table, column,
 * nullability, default, enum value, CHECK value list, foreign key or API function fails here until
 * the types are updated.
 */

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  Constants,
  FUNCTIONS,
  SYNC_ENTRY_STATUSES,
  TABLE_COLUMNS,
  TABLE_RELATIONSHIPS,
} from '@studio-pulse/database';
import type { ColumnSpec, FunctionSpec, RelationshipSpec, ReturnSpec } from '@studio-pulse/database';

import { applyMigrations, listMigrations } from '../../../scripts/supabase/migrations.mjs';
import { MIGRATIONS_DIR, MIGRATION_OWNER, asQueryable, supabaseLikeDb } from './helpers';

// PGlite (WASM Postgres) boots and migrates once per file: slow while the full suite runs in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let pg: PGlite;

beforeAll(async () => {
  pg = await supabaseLikeDb();
  await pg.exec(`set role ${MIGRATION_OWNER}`);
  const result = await applyMigrations(asQueryable(pg), listMigrations(MIGRATIONS_DIR).migrations);
  expect(result.status).toBe('applied');
  await pg.exec('reset role');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

/** `uuid`, `enum:workspace_role`, `enum:workspace_role[]`, … from a pg_type row. */
function typeName(typname: string, typtype: string, elemTypname: string | null, elemTyptype: string | null): string {
  const scalar = (name: string, kind: string | null) => {
    if (kind === 'e') return `enum:${name}`;
    const aliases: Record<string, string> = { int8: 'bigint', int4: 'integer', bool: 'boolean' };
    return aliases[name] ?? name;
  };
  if (elemTypname !== null) return `${scalar(elemTypname, elemTyptype)}[]`;
  return scalar(typname, typtype);
}

const TYPE_SQL = `
  t.typname, t.typtype,
  case when t.typcategory = 'A' then e.typname end as elem_typname,
  case when t.typcategory = 'A' then e.typtype end as elem_typtype`;

describe('tables and columns', () => {
  it('public has exactly the described tables, all with row level security', async () => {
    const tables = await pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
    );
    expect(tables.rows.map((t) => t.relname)).toEqual(Object.keys(TABLE_COLUMNS).sort());
    for (const t of tables.rows) expect(t.relrowsecurity, t.relname).toBe(true);
  });

  it.each(Object.keys(TABLE_COLUMNS))('%s: columns, order, types, nullability and defaults', async (table) => {
    const result = await pg.query<{
      attname: string;
      notnull: boolean;
      hasdefault: boolean;
      typname: string;
      typtype: string;
      elem_typname: string | null;
      elem_typtype: string | null;
    }>(
      `select a.attname, a.attnotnull as notnull, a.atthasdef as hasdefault, ${TYPE_SQL}
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_type t on t.oid = a.atttypid
       left join pg_type e on e.oid = t.typelem
       where n.nspname = 'public' and c.relname = $1 and a.attnum > 0 and not a.attisdropped
       order by a.attnum`,
      [table],
    );
    const actual = result.rows.map((r) => [
      r.attname,
      { type: typeName(r.typname, r.typtype, r.elem_typname, r.elem_typtype), nullable: !r.notnull, hasDefault: r.hasdefault },
    ]);
    const described = Object.entries(TABLE_COLUMNS[table as keyof typeof TABLE_COLUMNS]).map(([name, spec]) => {
      const { type, nullable, hasDefault } = spec as ColumnSpec;
      return [name, { type, nullable, hasDefault }];
    });
    expect(actual).toEqual(described);
  });

  it('text columns with a value list match their CHECK constraints exactly', async () => {
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      for (const [column, spec] of Object.entries(columns)) {
        const values = (spec as ColumnSpec).values;
        if (!values) continue;
        const checks = await pg.query<{ def: string }>(
          `select pg_get_constraintdef(k.oid) as def from pg_constraint k
           join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = $1 and k.contype = 'c'`,
          [table],
        );
        const lists = checks.rows
          .map((r) => r.def)
          .filter((def) => new RegExp(`^CHECK \\(\\(?${column} = `).test(def))
          .map((def) => [...def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]));
        expect(lists, `${table}.${column}`).toHaveLength(1);
        expect(lists[0], `${table}.${column}`).toEqual([...values]);
      }
    }
  });
});

describe('enums', () => {
  it('match Constants.public.Enums, values in declaration order', async () => {
    const result = await pg.query<{ typname: string; labels: string[] }>(
      `select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
       from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' group by t.typname order by t.typname`,
    );
    const actual = Object.fromEntries(result.rows.map((r) => [r.typname, r.labels]));
    expect(actual).toEqual(JSON.parse(JSON.stringify(Constants.public.Enums)));
  });
});

describe('relationships', () => {
  it.each(Object.keys(TABLE_RELATIONSHIPS))('%s: foreign keys', async (table) => {
    const result = await pg.query<{
      conname: string;
      columns: string[];
      referenced_relation: string;
      referenced_columns: string[];
      one_to_one: boolean;
    }>(
      `select k.conname,
         array(select a.attname from unnest(k.conkey) with ordinality u(attnum, ord)
               join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum order by u.ord) as columns,
         rc.relname as referenced_relation,
         array(select a.attname from unnest(k.confkey) with ordinality u(attnum, ord)
               join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum order by u.ord) as referenced_columns,
         exists (select 1 from pg_index i where i.indrelid = k.conrelid and i.indisunique
                 and (select array_agg(x order by x) from unnest(i.indkey::int2[]) x)
                   = (select array_agg(x order by x) from unnest(k.conkey) x)) as one_to_one
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_class rc on rc.oid = k.confrelid
       where n.nspname = 'public' and c.relname = $1 and k.contype = 'f'
       order by k.conname`,
      [table],
    );
    const actual = result.rows.map((r) => ({
      foreignKeyName: r.conname,
      columns: r.columns,
      isOneToOne: r.one_to_one,
      referencedRelation: r.referenced_relation,
      referencedColumns: r.referenced_columns,
    }));
    const described = (TABLE_RELATIONSHIPS[table as keyof typeof TABLE_RELATIONSHIPS] as readonly RelationshipSpec[]).map((r) => ({
      foreignKeyName: r.foreignKeyName,
      columns: [...r.columns],
      isOneToOne: r.isOneToOne,
      referencedRelation: r.referencedRelation,
      referencedColumns: [...r.referencedColumns],
    }));
    expect(actual).toEqual(described);
  });
});

describe('functions', () => {
  interface ArgRow {
    proname: string;
    secdef: boolean;
    retset: boolean;
    nargdefaults: number;
    ret_typname: string;
    ret_typtype: string;
    ret_relname: string | null;
    args: { name: string; mode: string; typname: string; typtype: string; elem_typname: string | null; elem_typtype: string | null }[];
  }

  async function catalog(): Promise<ArgRow[]> {
    const result = await pg.query<ArgRow>(
      `select p.proname, p.prosecdef as secdef, p.proretset as retset, p.pronargdefaults as nargdefaults,
         rt.typname as ret_typname, rt.typtype as ret_typtype, rr.relname as ret_relname,
         coalesce((
           select json_agg(json_build_object(
                    'name', coalesce(p.proargnames[u.ord], ''),
                    'mode', coalesce(p.proargmodes[u.ord]::text, 'i'),
                    'typname', t.typname, 'typtype', t.typtype,
                    'elem_typname', case when t.typcategory = 'A' then e.typname end,
                    'elem_typtype', case when t.typcategory = 'A' then e.typtype end)
                  order by u.ord)
           from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality u(typ, ord)
           join pg_type t on t.oid = u.typ left join pg_type e on e.oid = t.typelem
         ), '[]'::json) as args
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_type rt on rt.oid = p.prorettype
       left join pg_class rr on rr.oid = rt.typrelid and rt.typtype = 'c'
       where n.nspname = 'public' and rt.typname <> 'trigger'
       order by p.proname`,
    );
    return result.rows;
  }

  it('every callable function in public is described (trigger functions excluded), none overloaded', async () => {
    const names = (await catalog()).map((f) => f.proname);
    expect(names).toEqual(Object.keys(FUNCTIONS).sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(Object.keys(FUNCTIONS))('%s: arguments, defaults, return shape and security', async (name) => {
    const fn = (await catalog()).find((f) => f.proname === name);
    expect(fn).toBeDefined();
    const spec = FUNCTIONS[name as keyof typeof FUNCTIONS] as FunctionSpec;

    const inputs = fn!.args.filter((a) => a.mode === 'i');
    expect(inputs.map((a) => [a.name, typeName(a.typname, a.typtype, a.elem_typname, a.elem_typtype)])).toEqual(
      Object.entries(spec.args).map(([argName, s]) => [argName, (s as ColumnSpec).type]),
    );
    // Parameters with defaults are the trailing ones.
    const withDefault = Object.values(spec.args).map((s) => (s as ColumnSpec).hasDefault);
    expect(withDefault.filter(Boolean).length).toBe(fn!.nargdefaults);
    expect(withDefault.slice(withDefault.length - fn!.nargdefaults).every(Boolean)).toBe(true);

    expect(fn!.secdef).toBe(spec.securityDefiner);

    const returns = spec.returns as ReturnSpec;
    switch (returns.kind) {
      case 'void':
        expect(fn!.ret_typname).toBe('void');
        expect(fn!.retset).toBe(false);
        break;
      case 'scalar':
        expect(typeName(fn!.ret_typname, fn!.ret_typtype, null, null)).toBe(returns.type);
        expect(fn!.retset).toBe(false);
        break;
      case 'row':
        expect(fn!.ret_relname).toBe(returns.table);
        expect(fn!.retset).toBe(false);
        break;
      case 'table': {
        expect(fn!.retset).toBe(true);
        const outputs = fn!.args.filter((a) => a.mode === 't');
        expect(outputs.map((a) => [a.name, typeName(a.typname, a.typtype, a.elem_typname, a.elem_typtype)])).toEqual(
          Object.entries(returns.columns).map(([col, s]) => [col, s.type]),
        );
        break;
      }
    }
  });

  it('sync_time_entries can only answer synced or rejected', () => {
    expect([...SYNC_ENTRY_STATUSES]).toEqual(['synced', 'rejected']);
  });
});
