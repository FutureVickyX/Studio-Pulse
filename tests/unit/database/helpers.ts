/**
 * Shared helpers for tests/unit/database: crafted (unsigned) JWTs and a Supabase-shaped Postgres on
 * PGlite for the migration runner, schema and sync-payload tests.
 *
 * The PGlite bootstrap mirrors what a hosted Supabase project provides before any migration runs:
 * the `anon` / `authenticated` / `service_role` roles, an `auth` schema with `auth.users` and the
 * `auth.uid()` / `auth.jwt()` helpers (reading `request.jwt.claims` the way PostgREST sets it), and
 * a non-superuser `migration_owner` playing Supabase's `postgres` role. Nothing here reads
 * supabase/.env.local or any key.
 */

import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '@electric-sql/pglite';

import type { Queryable } from '../../../scripts/supabase/migrations.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const MIGRATIONS_DIR = resolve(REPO_ROOT, 'supabase/migrations');

/** base64url of a UTF-8 string. */
export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** An unsigned JWT-shaped string with the given payload (the signature is random bytes). */
export function fakeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${Buffer.from(randomUUID()).toString('base64url')}`;
}

/**
 * A fake `sb_secret_…` key. Assembled at runtime so the repository holds no literal that looks
 * like a real secret key (secret scanners and push protection match those).
 */
export function fakeSecretKey(body = 'FakeTestOnlyKey0123456789abcd'): string {
  return ['sb', 'secret', body].join('_');
}

/** A legacy Supabase API key payload (`role` anon or service_role). */
export function legacyKey(role: string): string {
  return fakeJwt({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role, iat: 1_700_000_000, exp: 2_000_000_000 });
}

export const MIGRATION_OWNER = 'migration_owner';

const BOOTSTRAP: readonly string[] = [
  `create role anon nologin noinherit`,
  `create role authenticated nologin noinherit`,
  `create role service_role nologin noinherit bypassrls`,
  `create role ${MIGRATION_OWNER} nologin noinherit bypassrls`,
  `create schema auth`,
  `create table auth.users (
     id uuid primary key,
     email text,
     raw_user_meta_data jsonb default '{}'::jsonb,
     created_at timestamptz default now()
   )`,
  `create function auth.uid() returns uuid language sql stable as $$
     select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
   $$`,
  `create function auth.jwt() returns jsonb language sql stable as $$
     select nullif(current_setting('request.jwt.claims', true), '')::jsonb
   $$`,
  `grant usage on schema auth to anon, authenticated, service_role, ${MIGRATION_OWNER}`,
  `grant execute on all functions in schema auth to anon, authenticated, service_role, ${MIGRATION_OWNER}`,
  `grant all on auth.users to ${MIGRATION_OWNER}`,
  `grant usage on schema public to anon, authenticated, service_role`,
  `grant usage, create on schema public to ${MIGRATION_OWNER}`,
  // Supabase's postgres role may create schemas (the CLI's supabase_migrations).
  `do $$ begin execute format('grant create on database %I to ${MIGRATION_OWNER}', current_database()); end $$`,
  // Supabase's default privileges in public (the migrations must revoke what they do not intend).
  `alter default privileges for role ${MIGRATION_OWNER} in schema public grant all on tables to anon, authenticated, service_role`,
  `alter default privileges for role ${MIGRATION_OWNER} in schema public grant all on functions to anon, authenticated, service_role`,
];

/** A fresh in-memory Postgres shaped like a new Supabase project (no migrations applied). */
export async function supabaseLikeDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.waitReady;
  for (const statement of BOOTSTRAP) await pg.exec(statement);
  return pg;
}

/**
 * The migration runner's `Queryable` over PGlite: parameterised statements go through the
 * extended protocol, parameterless text (possibly several statements, like a migration file)
 * through `exec`, exactly like node-postgres' simple query protocol.
 */
export function asQueryable(pg: PGlite): Queryable {
  return {
    async query(text, params) {
      if (params && params.length > 0) {
        const result = await pg.query<Record<string, unknown>>(text, [...params]);
        return { rows: result.rows };
      }
      const results = await pg.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
    },
  };
}

/** Insert an auth user the way GoTrue does (fires the profile trigger). */
export async function createAuthUser(pg: PGlite, email: string): Promise<string> {
  const id = randomUUID();
  await pg.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}'::jsonb)`, [id, email]);
  return id;
}

/** Run `fn` as a signed-in user, the way PostgREST runs a request (one transaction, SET LOCAL ROLE). */
export async function asUser<T>(
  pg: PGlite,
  user: { id: string; email: string },
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return pg.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated' }),
    ]);
    await tx.exec('set local role authenticated');
    return fn(tx);
  });
}
