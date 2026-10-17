/**
 * A Supabase-shaped Postgres on PGlite, for testing supabase/migrations exactly as the hosted
 * project evaluates them: same roles, same role attributes, same default privileges, same
 * `auth.*` helpers, and requests run the way PostgREST runs them (one transaction per request,
 * `SET LOCAL ROLE`, the JWT claims in `request.jwt.claims`).
 *
 * What is emulated (and why it matters for the tests):
 * - Roles `anon`, `authenticated` (NOLOGIN, NOINHERIT, no BYPASSRLS) and `service_role`
 *   (BYPASSRLS), as in supabase/postgres.
 * - `migration_owner` plays Supabase's `postgres` role: it runs the migrations and therefore owns
 *   every table and SECURITY DEFINER function, it is NOT a superuser, and it has BYPASSRLS. A
 *   migration that silently relied on superuser powers would fail here.
 * - Supabase's default privileges in `public`: every new table, function and sequence created by
 *   the owner is granted to anon, authenticated and service_role (plus EXECUTE to PUBLIC, the
 *   Postgres default for functions). Migrations must therefore revoke what they do not intend to
 *   expose; the privilege tests check exactly that.
 * - `auth.users` (the columns the migrations use, plus a few GoTrue columns), not readable by anon
 *   or authenticated; `auth.uid()`, `auth.role()`, `auth.email()` and `auth.jwt()` copied from
 *   Supabase (including the legacy `request.jwt.claim.*` fallbacks, and returning NULL when no
 *   claims are set).
 * - Users are created the way GoTrue creates them (a privileged insert into auth.users), which
 *   fires the migrations' profile trigger.
 * - The database time zone is UTC, as on Supabase.
 *
 * Not emulated: PostgREST's HTTP layer (status codes, `select=*` expansion), GoTrue itself, and
 * concurrency (one PGlite instance is a single connection; access is serialized here).
 *
 * The harness never reads supabase/.env.local or any key: it needs none.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import type { PGliteInterface, Transaction } from '@electric-sql/pglite';

export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations',
);

/** The role that owns every migrated object (Supabase's non-superuser `postgres`). */
export const MIGRATION_OWNER = 'migration_owner';

export type Row = Record<string, unknown>;

export interface SqlError {
  /** SQLSTATE, e.g. `42501`. */
  code: string;
  message: string;
  detail: string | undefined;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: SqlError };

export interface TestUser {
  id: string;
  email: string | null;
  /** A short label for test messages (never sent anywhere). */
  label: string;
}

/** Who a request runs as: a signed-in user, the anonymous key, or the service-role key. */
export type Who = TestUser | 'anon' | 'service';

/** The statements a request can run inside its transaction. */
export interface Session {
  query<R extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<R[]>;
  /** Rows affected by an INSERT/UPDATE/DELETE (0 when RLS filtered every row). */
  affected(sql: string, params?: readonly unknown[]): Promise<number>;
}

export interface CreateUserOptions {
  /** Stored as `raw_user_meta_data.display_name`, as the desktop's sign-up does. */
  displayName?: string;
  /** Replaces the whole `raw_user_meta_data` (may be null or any JSON). */
  metadata?: unknown;
  label?: string;
}

const BOOTSTRAP: readonly string[] = [
  // Supabase databases run in UTC; PGlite would otherwise inherit the host's time zone. Set for
  // this session and as the database default (so `clone()`d databases inherit it).
  `do $$ begin execute format('alter database %I set timezone to %L', current_database(), 'UTC'); end $$`,
  `set timezone to 'UTC'`,

  // Roles (supabase/postgres migrations/db/init-scripts).
  `create role anon nologin noinherit`,
  `create role authenticated nologin noinherit`,
  `create role service_role nologin noinherit bypassrls`,
  `create role ${MIGRATION_OWNER} nologin noinherit bypassrls`,

  // auth schema: a subset of GoTrue's auth.users, owned by the "auth admin" (here the session
  // superuser). anon/authenticated get schema USAGE (for auth.uid() etc.) but no table access.
  `create schema auth`,
  `create table auth.users (
     id uuid primary key,
     aud text default 'authenticated',
     role text default 'authenticated',
     email text,
     email_confirmed_at timestamptz,
     raw_app_meta_data jsonb default '{}'::jsonb,
     raw_user_meta_data jsonb default '{}'::jsonb,
     is_anonymous boolean not null default false,
     created_at timestamptz default now(),
     updated_at timestamptz default now()
   )`,
  `create function auth.uid() returns uuid language sql stable as $$
     select coalesce(
       nullif(current_setting('request.jwt.claim.sub', true), ''),
       (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
     )::uuid
   $$`,
  `create function auth.role() returns text language sql stable as $$
     select coalesce(
       nullif(current_setting('request.jwt.claim.role', true), ''),
       (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
     )::text
   $$`,
  `create function auth.email() returns text language sql stable as $$
     select coalesce(
       nullif(current_setting('request.jwt.claim.email', true), ''),
       (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
     )::text
   $$`,
  `create function auth.jwt() returns jsonb language sql stable as $$
     select coalesce(
       nullif(current_setting('request.jwt.claim', true), ''),
       nullif(current_setting('request.jwt.claims', true), '')
     )::jsonb
   $$`,
  `grant usage on schema auth to anon, authenticated, service_role, ${MIGRATION_OWNER}`,
  `grant execute on all functions in schema auth to anon, authenticated, service_role, ${MIGRATION_OWNER}`,
  // The project owner can reference and attach triggers to auth.users (the documented
  // "profiles" pattern).
  `grant all on auth.users to ${MIGRATION_OWNER}`,

  // public schema, as Supabase configures it.
  `grant usage on schema public to anon, authenticated, service_role`,
  `grant usage, create on schema public to ${MIGRATION_OWNER}`,
  `alter default privileges for role ${MIGRATION_OWNER} in schema public
     grant all on tables to anon, authenticated, service_role`,
  `alter default privileges for role ${MIGRATION_OWNER} in schema public
     grant all on functions to anon, authenticated, service_role`,
  `alter default privileges for role ${MIGRATION_OWNER} in schema public
     grant all on sequences to anon, authenticated, service_role`,
];

/** The migration files in the order Supabase applies them (lexicographic by timestamp). */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function isDatabaseError(error: unknown): error is Error & { code: string; detail?: string } {
  if (!(error instanceof Error)) return false;
  const code: unknown = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

function toSqlError(error: Error & { code: string; detail?: string }): SqlError {
  return { code: error.code, message: error.message, detail: error.detail };
}

function claimsFor(user: TestUser): Record<string, unknown> {
  // The claims of a Supabase access token that the database can see.
  return {
    aud: 'authenticated',
    role: 'authenticated',
    sub: user.id,
    email: user.email ?? '',
    is_anonymous: false,
    app_metadata: { provider: 'email' },
  };
}

export class SupabaseTestDb {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly pg: PGliteInterface) {}

  /** A new in-memory database with the Supabase emulation and every migration applied. */
  static async create(): Promise<SupabaseTestDb> {
    const pg = new PGlite();
    await pg.waitReady;
    for (const statement of BOOTSTRAP) await pg.exec(statement);
    for (const file of migrationFiles()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await pg.exec(`set role ${MIGRATION_OWNER}`);
      try {
        await pg.exec(sql);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`migration ${file} failed: ${reason}`);
      } finally {
        await pg.exec('reset role');
      }
    }
    return new SupabaseTestDb(pg);
  }

  /** An independent copy of this database in its current state (for per-test isolation). */
  async clone(): Promise<SupabaseTestDb> {
    return this.exclusive(async () => new SupabaseTestDb(await this.pg.clone()));
  }

  async close(): Promise<void> {
    await this.exclusive(() => this.pg.close());
  }

  /**
   * Creates a user the way GoTrue does (privileged insert into auth.users), which fires the
   * profile trigger. `email` may be null (e.g. phone sign-up). A string second argument is the
   * display name (`createUser(email, 'Ana')`).
   */
  async createUser(
    email: string | null,
    displayNameOrOptions: string | CreateUserOptions = {},
  ): Promise<TestUser> {
    const options: CreateUserOptions =
      typeof displayNameOrOptions === 'string'
        ? { displayName: displayNameOrOptions }
        : displayNameOrOptions;
    const id = randomUUID();
    const metadata =
      'metadata' in options
        ? options.metadata
        : options.displayName === undefined
          ? {}
          : { display_name: options.displayName };
    await this.admin(
      `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
       values ($1, $2, now(), $3::jsonb)`,
      [id, email, metadata === null ? null : JSON.stringify(metadata)],
    );
    return { id, email, label: options.label ?? email ?? id };
  }

  /** Deletes a user the way GoTrue does (cascades to everything that references them). */
  async deleteUser(user: TestUser): Promise<void> {
    await this.admin(`delete from auth.users where id = $1`, [user.id]);
  }

  /** Runs `fn` as a signed-in user (role `authenticated`, the user's JWT claims). */
  as<T>(user: TestUser, fn: (session: Session) => Promise<T>): Promise<Outcome<T>> {
    return this.asClaims('authenticated', claimsFor(user), fn);
  }

  /** Runs `fn` with the anonymous (publishable/anon) key and no user session. */
  asAnon<T>(fn: (session: Session) => Promise<T>): Promise<Outcome<T>> {
    return this.asClaims('anon', { role: 'anon' }, fn);
  }

  /** Runs `fn` with the service-role key (BYPASSRLS). Only admin tooling ever does this. */
  asService<T>(fn: (session: Session) => Promise<T>): Promise<Outcome<T>> {
    return this.asClaims('service_role', { role: 'service_role' }, fn);
  }

  /**
   * Runs `fn` in one transaction as PostgREST would: `request.jwt.claims` set locally, then
   * `SET LOCAL ROLE`. Commits on success; on a database error rolls back and returns the error.
   * Errors that are not database errors (e.g. a simulated dropped connection) roll back and are
   * rethrown.
   */
  asClaims<T>(
    role: 'anon' | 'authenticated' | 'service_role',
    claims: Record<string, unknown> | null,
    fn: (session: Session) => Promise<T>,
  ): Promise<Outcome<T>> {
    return this.exclusive(async () => {
      try {
        const value = await this.pg.transaction(async (tx) => {
          if (claims !== null) {
            await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
              JSON.stringify(claims),
            ]);
          }
          await tx.exec(`set local role ${role}`);
          return fn(sessionOf(tx));
        });
        return { ok: true as const, value };
      } catch (error) {
        if (isDatabaseError(error)) return { ok: false as const, error: toSqlError(error) };
        throw error;
      }
    });
  }

  /** One statement as `who`, returning its rows or its error. */
  query<R extends Row = Row>(
    who: Who,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<Outcome<R[]>> {
    return this.run(who, (session) => session.query<R>(sql, params));
  }

  /** One INSERT/UPDATE/DELETE as `who`, returning the affected row count or its error. */
  affected(who: Who, sql: string, params: readonly unknown[] = []): Promise<Outcome<number>> {
    return this.run(who, (session) => session.affected(sql, params));
  }

  /**
   * Fixture setup and inspection as the database superuser (like the SQL editor). Never used to
   * exercise a client path. Throws on error.
   */
  admin<R extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.exclusive(async () => {
      const result = await this.pg.query<R>(sql, [...params]);
      return result.rows;
    });
  }

  private run<T>(who: Who, fn: (session: Session) => Promise<T>): Promise<Outcome<T>> {
    if (who === 'anon') return this.asAnon(fn);
    if (who === 'service') return this.asService(fn);
    return this.as(who, fn);
  }

  /** PGlite is a single connection: serialize every request. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function sessionOf(tx: Transaction): Session {
  return {
    async query<R extends Row = Row>(sql: string, params: readonly unknown[] = []) {
      const result = await tx.query<R>(sql, [...params]);
      return result.rows;
    },
    async affected(sql: string, params: readonly unknown[] = []) {
      const result = await tx.query(sql, [...params]);
      return result.affectedRows ?? 0;
    },
  };
}
