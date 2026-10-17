// The logic behind scripts/supabase/migrate.mjs, kept free of console output and process state so
// it can be unit-tested (tests/unit/database/migrations.test.ts, migrate.test.ts).
//
// Compatibility with the Supabase CLI: migration files are `<version>_<name>.sql` (version = the
// digits before the first underscore), applied in filename order, and recorded in
// supabase_migrations.schema_migrations(version, name, statements), the table `supabase db push`
// and `supabase migration list` read, so either tool can take over later.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import tls from 'node:tls';

/** Same pattern as the Supabase CLI. */
export const MIGRATION_FILE = /^([0-9]+)_(.*)\.sql$/;

/** DDL the Supabase CLI runs before recording a migration (idempotent). */
export const HISTORY_TABLE_DDL = [
  'create schema if not exists supabase_migrations',
  'create table if not exists supabase_migrations.schema_migrations (version text not null primary key)',
  'alter table supabase_migrations.schema_migrations add column if not exists statements text[]',
  'alter table supabase_migrations.schema_migrations add column if not exists name text',
];

/** Arbitrary constant: serialises concurrent runners on the same database. */
export const ADVISORY_LOCK_KEY = 4_215_870_311;

/**
 * @typedef {{ version: string, name: string, file: string, path: string }} Migration
 */

/**
 * Local migrations in filename order. Files that do not match `<digits>_<name>.sql` are returned
 * in `ignored` (the CLI skips them too).
 * @param {string} dir
 * @returns {{ migrations: Migration[], ignored: string[] }}
 */
export function listMigrations(dir) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(compareFilenames);
  /** @type {Migration[]} */
  const migrations = [];
  /** @type {string[]} */
  const ignored = [];
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const file of files) {
    const match = MIGRATION_FILE.exec(file);
    if (!match) {
      ignored.push(file);
      continue;
    }
    const version = match[1] ?? '';
    const name = match[2] ?? '';
    if (seen.has(version)) {
      throw new Error(`Duplicate migration version ${version}: ${seen.get(version)} and ${file}.`);
    }
    seen.set(version, file);
    migrations.push({ version, name, file, path: join(dir, file) });
  }
  return { migrations, ignored };
}

/**
 * Byte-wise filename order (what `ls` and the CLI use), independent of the OS locale.
 * @param {string} a
 * @param {string} b
 */
export function compareFilenames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Numeric order of version digits (`9` < `10`), for versions recorded remotely.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Decide what to apply.
 * - `pending`        local migrations not yet recorded remotely, in filename order
 * - `applied`        local migrations already recorded
 * - `unknownApplied` versions recorded remotely with no local file (refuse to push: the local
 *                    directory is behind the database)
 * - `outOfOrder`     pending migrations older than the newest applied one (the CLI requires
 *                    `--include-all` for these)
 * @param {readonly Migration[]} local
 * @param {Iterable<string>} appliedVersions
 */
export function planMigrations(local, appliedVersions) {
  const applied = new Set(appliedVersions);
  const localVersions = new Set(local.map((m) => m.version));
  const pending = local.filter((m) => !applied.has(m.version));
  const alreadyApplied = local.filter((m) => applied.has(m.version));
  const unknownApplied = [...applied].filter((v) => !localVersions.has(v)).sort(compareVersions);
  const newestApplied = [...applied].sort(compareVersions).at(-1);
  const outOfOrder =
    newestApplied === undefined ? [] : pending.filter((m) => compareVersions(m.version, newestApplied) < 0);
  return { pending, applied: alreadyApplied, unknownApplied, outOfOrder };
}

/**
 * Split SQL into top-level statements (without the terminating `;`), understanding `--` and
 * nested block comments, single-quoted strings (incl. E'' escapes), quoted identifiers and
 * dollar-quoted bodies. Segments containing only whitespace/comments are dropped.
 *
 * Used to fill the history table's `statements` column (as the CLI does) and to reject
 * transaction-unsafe statements; the file itself is executed as one multi-statement query.
 * @param {string} sql
 * @returns {string[]}
 */
export function splitStatements(sql) {
  /** @type {string[]} */
  const statements = [];
  let start = 0;
  let hasCode = false;
  let i = 0;
  const n = sql.length;
  /** @param {number} end */
  const push = (end) => {
    if (hasCode) statements.push(sql.slice(start, end).trim());
    start = end + 1;
    hasCode = false;
  };
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol < 0 ? n : eol + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) throw new Error('Unterminated block comment.');
      continue;
    }
    if (ch === "'") {
      const escapes = i > 0 && /[eE]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? '');
      i = skipQuoted(sql, i, "'", escapes);
      hasCode = true;
      continue;
    }
    if (ch === '"') {
      i = skipQuoted(sql, i, '"', false);
      hasCode = true;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      const prev = sql[i - 1] ?? '';
      if (tag && !/[A-Za-z0-9_$]/.test(prev)) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close < 0) throw new Error(`Unterminated dollar-quoted string ${tag[0]}.`);
        i = close + tag[0].length;
        hasCode = true;
        continue;
      }
    }
    if (ch === ';') {
      push(i);
      i += 1;
      continue;
    }
    if (!/\s/.test(ch ?? '')) hasCode = true;
    i += 1;
  }
  push(n);
  return statements;
}

/**
 * @param {string} sql
 * @param {number} open index of the opening quote
 * @param {string} quote
 * @param {boolean} backslashEscapes E'' string
 * @returns {number} index after the closing quote
 */
function skipQuoted(sql, open, quote, backslashEscapes) {
  let i = open + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (backslashEscapes && ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw new Error(`Unterminated ${quote === "'" ? 'string literal' : 'quoted identifier'}.`);
}

/**
 * The statement with leading comments removed, lower-cased and whitespace-collapsed (for
 * classification only).
 * @param {string} statement
 */
function head(statement) {
  let s = statement;
  for (;;) {
    const trimmed = s.trimStart();
    if (trimmed.startsWith('--')) {
      const eol = trimmed.indexOf('\n');
      s = eol < 0 ? '' : trimmed.slice(eol + 1);
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      s = end < 0 ? '' : trimmed.slice(end + 2);
    } else {
      return trimmed.replace(/\s+/g, ' ').toLowerCase();
    }
  }
}

/**
 * Statements that cannot run inside the per-file transaction the runner wraps around each
 * migration (or would end that transaction early).
 * @param {readonly string[]} statements
 * @returns {{ index: number, reason: string }[]}
 */
export function findTransactionUnsafeStatements(statements) {
  /** @type {{ index: number, reason: string }[]} */
  const problems = [];
  statements.forEach((statement, index) => {
    const h = head(statement);
    if (/\bbegin atomic\b/.test(h)) {
      // SQL-standard bodies contain unquoted `;`, which this splitter does not follow.
      problems.push({ index, reason: 'BEGIN ATOMIC bodies are not supported here; use a dollar-quoted ($$) body' });
    } else if (/^(begin|commit|rollback|abort|end|start transaction|savepoint|release|prepare transaction)\b/.test(h)) {
      problems.push({ index, reason: 'transaction control (the runner already wraps each file in a transaction)' });
    } else if (/^(create|drop|reindex)( unique)? index concurrently\b|^(reindex|refresh materialized view) .*\bconcurrently\b/.test(h)) {
      problems.push({ index, reason: 'CONCURRENTLY cannot run inside a transaction' });
    } else if (/^(vacuum|create database|drop database|alter system|create tablespace|drop tablespace)\b/.test(h)) {
      problems.push({ index, reason: 'cannot run inside a transaction' });
    }
  });
  return problems;
}

/**
 * Read a migration file, split it, and reject transaction-unsafe statements.
 * @param {Migration} migration
 * @returns {{ sql: string, statements: string[] }}
 */
export function readMigration(migration) {
  const text = readFileSync(migration.path, 'utf8');
  const sql = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const statements = splitStatements(sql);
  const unsafe = findTransactionUnsafeStatements(statements);
  const first = unsafe[0];
  if (first) throw new Error(`${migration.file}: statement ${first.index + 1}: ${first.reason}.`);
  if (statements.length === 0) throw new Error(`${migration.file}: no SQL statements.`);
  return { sql, statements };
}

// ---------------------------------------------------------------------------------------------
// Applying migrations through any client with a node-postgres-like `query`
// ---------------------------------------------------------------------------------------------

/**
 * The part of `pg.Client` the runner uses. `query(text)` without parameters may contain several
 * statements (node-postgres sends it with the simple query protocol).
 * @typedef {{ query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> }} Queryable
 */

/**
 * Versions recorded in supabase_migrations.schema_migrations (none when the table does not exist
 * yet). Read-only.
 * @param {Queryable} db
 * @returns {Promise<string[]>}
 */
export async function readAppliedVersions(db) {
  const { rows } = await db.query(
    "select to_regclass('supabase_migrations.schema_migrations') is not null as present",
  );
  if (!rows[0]?.present) return [];
  const history = await db.query('select version from supabase_migrations.schema_migrations order by version');
  return history.rows.map((r) => String(r.version));
}

/**
 * @typedef {(
 *   | { status: 'applied', applied: Migration[], skipped: Migration[] }
 *   | { status: 'refused', reason: 'unknownApplied' | 'outOfOrder', versions: string[] }
 *   | { status: 'failed', applied: Migration[], failed: Migration, error: unknown }
 * )} ApplyResult
 */

/**
 * Apply every pending migration, each file in its own transaction together with its history row,
 * under a transaction-scoped advisory lock (a concurrent runner waits, then skips what the other
 * one applied). Stops at the first failing file, which is rolled back; later files are not
 * attempted.
 *
 * Refuses (changing nothing) when the database records versions with no local file, or when a
 * pending file is older than the newest applied version (unless `includeAll`).
 *
 * @param {Queryable} db
 * @param {readonly Migration[]} migrations local migrations in filename order
 * @param {{ includeAll?: boolean, onApplied?: (migration: Migration, statementCount: number) => void, onSkipped?: (migration: Migration) => void }} [options]
 * @returns {Promise<ApplyResult>}
 */
export async function applyMigrations(db, migrations, { includeAll = false, onApplied, onSkipped } = {}) {
  const plan = planMigrations(migrations, await readAppliedVersions(db));
  if (plan.unknownApplied.length > 0) {
    return { status: 'refused', reason: 'unknownApplied', versions: plan.unknownApplied };
  }
  if (plan.outOfOrder.length > 0 && !includeAll) {
    return { status: 'refused', reason: 'outOfOrder', versions: plan.outOfOrder.map((m) => m.version) };
  }
  /** @type {Migration[]} */
  const applied = [];
  /** @type {Migration[]} */
  const skipped = [];
  if (plan.pending.length === 0) return { status: 'applied', applied, skipped };

  for (const statement of HISTORY_TABLE_DDL) await db.query(statement);

  for (const migration of plan.pending) {
    let open = false;
    try {
      const { sql, statements } = readMigration(migration);
      await db.query('begin');
      open = true;
      await db.query('select pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);
      const done = await db.query('select 1 as present from supabase_migrations.schema_migrations where version = $1', [
        migration.version,
      ]);
      if (done.rows.length > 0) {
        await db.query('rollback');
        open = false;
        skipped.push(migration);
        onSkipped?.(migration);
        continue;
      }
      await db.query(sql);
      await db.query('insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)', [
        migration.version,
        migration.name,
        statements,
      ]);
      await db.query('commit');
      open = false;
      applied.push(migration);
      onApplied?.(migration, statements.length);
    } catch (error) {
      if (open) await db.query('rollback').catch(() => {});
      return { status: 'failed', applied, failed: migration, error };
    }
  }
  return { status: 'applied', applied, skipped };
}

// ---------------------------------------------------------------------------------------------
// Connection settings
// ---------------------------------------------------------------------------------------------

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Certificates trusted for the database connection: Node's bundled Mozilla store plus the
 * operating system's store (Windows certificate store, macOS keychain, …) when this Node exposes
 * it, plus `extraPem` (e.g. the Supabase root CA downloaded from the dashboard).
 * @param {string} [extraPem]
 * @returns {string[]}
 */
export function trustedCertificates(extraPem) {
  /** @type {string[]} */
  let base;
  const getCACertificates = /** @type {((type: string) => string[]) | undefined} */ (
    /** @type {{ getCACertificates?: unknown }} */ (tls).getCACertificates
  );
  if (typeof getCACertificates === 'function') {
    base = [...getCACertificates('default')];
    try {
      base.push(...getCACertificates('system'));
    } catch {
      // No readable system store: the bundled store (and extraPem) still apply.
    }
  } else {
    base = [...tls.rootCertificates];
  }
  return extraPem ? [...base, extraPem] : base;
}

/**
 * node-postgres connection settings from a `postgres(ql)://` URL, built explicitly so that no
 * `sslmode` query parameter can silently weaken certificate verification.
 *
 * TLS: remote hosts always use TLS with certificate *and* hostname verification
 * (`rejectUnauthorized: true`) against {@link trustedCertificates} (bundled + system store, plus
 * `ca` when given: Supabase's database certificates chain to Supabase's own root CA, which is in
 * neither store, see scripts/supabase/README.md). `noVerify` (opt-in `--ssl-no-verify`) keeps
 * encryption but skips verification. Local hosts (`supabase start`) use plain TCP unless
 * `sslmode=require` or stronger is in the URL.
 *
 * Errors never contain the URL or the password.
 * @param {string} url
 * @param {{ ca?: string, noVerify?: boolean, applicationName?: string }} [options]
 */
export function connectionConfig(url, { ca, noVerify = false, applicationName = 'studio-pulse-migrate' } = {}) {
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(
      'SUPABASE_DB_URL is not a valid URL. Use the "Session pooler" connection string and percent-encode special characters in the password.',
    );
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('SUPABASE_DB_URL must start with postgresql:// or postgres://.');
  }
  if (parsed.hash !== '') {
    throw new Error('SUPABASE_DB_URL contains "#": percent-encode special characters in the password (# → %23).');
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === '') throw new Error('SUPABASE_DB_URL has no host.');
  const user = safeDecode(parsed.username);
  const password = safeDecode(parsed.password);
  if (user === '' || password === '') {
    throw new Error('SUPABASE_DB_URL must include the user and the database password.');
  }
  const database = safeDecode(parsed.pathname.replace(/^\//, '')) || 'postgres';
  const port = parsed.port === '' ? 5432 : Number(parsed.port);
  const sslmode = (parsed.searchParams.get('sslmode') ?? '').toLowerCase();
  const local = LOCAL_DB_HOSTS.has(host);
  if (!local && sslmode === 'disable') {
    throw new Error('SUPABASE_DB_URL has sslmode=disable; a remote database is only reached over TLS.');
  }
  /** @type {false | { rejectUnauthorized: boolean, ca?: string[] }} */
  let ssl;
  if (local && !['require', 'verify-ca', 'verify-full'].includes(sslmode)) {
    ssl = false;
  } else if (noVerify) {
    ssl = { rejectUnauthorized: false };
  } else {
    ssl = { rejectUnauthorized: true, ca: trustedCertificates(ca) };
  }
  return {
    config: { host, port, user, password, database, ssl, application_name: applicationName, connectionTimeoutMillis: 20000 },
    /** Values to scrub from any message before printing. */
    secrets: [url.trim(), password, parsed.password].filter((s) => s.length >= 4),
    local,
  };
}

/** @param {string} value */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('SUPABASE_DB_URL has an invalid percent-encoding in the user or password.');
  }
}

/** Node / OpenSSL error codes meaning "the server certificate could not be verified". */
export const TLS_VERIFY_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Replace every occurrence of each secret (longest first), and anything shaped like a connection
 * string, with `<redacted>`.
 * @param {string} text
 * @param {readonly string[]} secrets
 */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret && secret.length >= 4) out = out.split(secret).join('<redacted>');
  }
  return out.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '<redacted-connection-string>');
}

/**
 * A one-line description of an error for the console: SQLSTATE / Node code plus message, with
 * `secrets` and connection strings redacted.
 * @param {unknown} error
 * @param {readonly string[]} secrets
 */
export function describeError(error, secrets) {
  if (error && typeof error === 'object') {
    const e = /** @type {{ code?: unknown, message?: unknown }} */ (error);
    const code = typeof e.code === 'string' ? `${e.code}: ` : '';
    return redact(`${code}${typeof e.message === 'string' ? e.message : String(error)}`, secrets);
  }
  return redact(String(error), secrets);
}

/** @param {unknown} error */
export function isTlsVerifyError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && TLS_VERIFY_ERRORS.has(String(error.code)));
}
