import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compareVersions,
  connectionConfig,
  describeError,
  findTransactionUnsafeStatements,
  isTlsVerifyError,
  listMigrations,
  planMigrations,
  readMigration,
  redact,
  splitStatements,
  trustedCertificates,
} from '../../../scripts/supabase/migrations.mjs';
import type { Migration } from '../../../scripts/supabase/migrations.mjs';
import { MIGRATIONS_DIR } from './helpers';

const dirs: string[] = [];
function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-migrations-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function m(version: string, name = 'x'): Migration {
  return { version, name, file: `${version}_${name}.sql`, path: `/nowhere/${version}_${name}.sql` };
}

describe('listMigrations', () => {
  it('orders by filename (byte order) and ignores files that are not <version>_<name>.sql', () => {
    const dir = tempDir({
      '20261017090200_time_entries.sql': 'select 1;',
      '20261017090000_identity.sql': 'select 1;',
      '20261017090100_projects.sql': 'select 1;',
      'README.md': '',
      'seed.sql': '',
      '.DS_Store': '',
      '20261017090300_draft.sql.bak': '',
    });
    const { migrations, ignored } = listMigrations(dir);
    expect(migrations.map((x) => x.file)).toEqual([
      '20261017090000_identity.sql',
      '20261017090100_projects.sql',
      '20261017090200_time_entries.sql',
    ]);
    expect(migrations.map((x) => [x.version, x.name])).toEqual([
      ['20261017090000', 'identity'],
      ['20261017090100', 'projects'],
      ['20261017090200', 'time_entries'],
    ]);
    expect(ignored.sort()).toEqual(['.DS_Store', '20261017090300_draft.sql.bak', 'README.md', 'seed.sql']);
  });

  it('refuses two files with the same version', () => {
    const dir = tempDir({ '1_a.sql': 'select 1;', '1_b.sql': 'select 2;' });
    expect(() => listMigrations(dir)).toThrow(/Duplicate migration version 1/);
  });

  it('lists the repository migrations in the order the Supabase CLI applies them', () => {
    const { migrations, ignored } = listMigrations(MIGRATIONS_DIR);
    const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(migrations.map((x) => x.file)).toEqual(sqlFiles);
    expect(ignored.every((f) => f.startsWith('.'))).toBe(true);
    expect(migrations.length).toBeGreaterThanOrEqual(3);
    for (const migration of migrations) {
      const { statements } = readMigration(migration);
      expect(statements.length, migration.file).toBeGreaterThan(0);
    }
  });
});

describe('planMigrations', () => {
  const local = [m('20261017090000'), m('20261017090100'), m('20261017090200')];

  it('applies everything on a fresh database', () => {
    const plan = planMigrations(local, []);
    expect(plan.pending.map((x) => x.version)).toEqual(['20261017090000', '20261017090100', '20261017090200']);
    expect(plan.applied).toEqual([]);
    expect(plan.unknownApplied).toEqual([]);
    expect(plan.outOfOrder).toEqual([]);
  });

  it('skips applied versions and keeps filename order for the rest', () => {
    const plan = planMigrations(local, ['20261017090000']);
    expect(plan.pending.map((x) => x.version)).toEqual(['20261017090100', '20261017090200']);
    expect(plan.applied.map((x) => x.version)).toEqual(['20261017090000']);
  });

  it('has nothing to do when every version is recorded', () => {
    const plan = planMigrations(local, ['20261017090200', '20261017090000', '20261017090100']);
    expect(plan.pending).toEqual([]);
    expect(plan.applied).toHaveLength(3);
  });

  it('flags versions recorded remotely without a local file', () => {
    expect(planMigrations(local, ['20261017090000', '20991231000000', '20200101000000']).unknownApplied).toEqual([
      '20200101000000',
      '20991231000000',
    ]);
  });

  it('flags pending files older than the newest applied version', () => {
    const plan = planMigrations(local, ['20261017090000', '20261017090200']);
    expect(plan.pending.map((x) => x.version)).toEqual(['20261017090100']);
    expect(plan.outOfOrder.map((x) => x.version)).toEqual(['20261017090100']);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('9', '10')).toBeLessThan(0);
    expect(compareVersions('20261017090100', '20261017090100')).toBe(0);
    expect(compareVersions('20261017090200', '20261017090100')).toBeGreaterThan(0);
  });
});

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    const sql = `
      -- a comment; with a semicolon
      create table t (a text default 'x;y', "we;ird" int);
      /* block ; /* nested ; */ still comment ; */
      create function f() returns text language plpgsql as $$ begin return 'a;b'; end; $$;
      create function g() returns text language sql as $body$ select $$;$$ $body$;
      select E'it\\'s; fine', 'it''s; fine';
      select 1
    `;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toMatch(/^-- a comment; with a semicolon\s+create table t .*int\)$/s);
    expect(statements[1]).toMatch(/^\/\* block/);
    expect(statements[1]).toMatch(/create function f\(\).*end; \$\$$/s);
    expect(statements[2]).toMatch(/\$body\$$/);
    expect(statements[3]).toMatch(/^select E'it/);
    expect(statements[4]).toBe('select 1');
  });

  it('drops comment-only and empty segments', () => {
    expect(splitStatements('-- only a comment\n;;  ;\n/* x */')).toEqual([]);
  });

  it('does not mistake $1 parameters or identifiers containing $ for dollar quotes', () => {
    expect(splitStatements('select $1; select a$b$ from t; select 2')).toEqual(['select $1', 'select a$b$ from t', 'select 2']);
  });

  it('rejects unterminated quotes and comments', () => {
    expect(() => splitStatements("select 'abc")).toThrow(/Unterminated string literal/);
    expect(() => splitStatements('select "abc')).toThrow(/Unterminated quoted identifier/);
    expect(() => splitStatements('select $$abc')).toThrow(/Unterminated dollar-quoted/);
    expect(() => splitStatements('/* never closed')).toThrow(/Unterminated block comment/);
  });
});

describe('findTransactionUnsafeStatements', () => {
  it('flags transaction control and statements that cannot run in a transaction', () => {
    const statements = [
      'create table a (id int)',
      'begin',
      '-- note\nCOMMIT',
      'create index concurrently i on a (id)',
      'create unique index concurrently j on a (id)',
      'vacuum a',
      'alter system set work_mem = 1',
      'create function f() returns int language sql begin atomic select 1',
      'create index ok on a (id)',
      "do $$ begin perform 1; end $$",
    ];
    expect(findTransactionUnsafeStatements(statements).map((p) => p.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('accepts every repository migration', () => {
    for (const migration of listMigrations(MIGRATIONS_DIR).migrations) {
      expect(() => readMigration(migration), migration.file).not.toThrow();
    }
  });

  it('readMigration refuses a file with transaction control, naming the statement', () => {
    const dir = tempDir({ '1_bad.sql': 'create table a (id int);\nbegin;\ncreate table b (id int);\ncommit;' });
    const [migration] = listMigrations(dir).migrations;
    expect(() => readMigration(migration!)).toThrow(/1_bad\.sql: statement 2: transaction control/);
  });

  it('readMigration refuses an empty file and strips a byte-order mark', () => {
    const dir = tempDir({ '1_empty.sql': '-- nothing\n', '2_bom.sql': `${String.fromCharCode(0xfeff)}select 1;` });
    const [empty, bom] = listMigrations(dir).migrations;
    expect(() => readMigration(empty!)).toThrow(/no SQL statements/);
    expect(readMigration(bom!).statements).toEqual(['select 1']);
  });
});

describe('connectionConfig', () => {
  const PASSWORD = 'S3cr3t#Pa:ss@word';
  const encoded = encodeURIComponent(PASSWORD);
  const POOLER = `postgresql://postgres.abcdefghijklmnopqrst:${encoded}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;

  it('parses the session-pooler URL and verifies TLS (certificate and host) by default', () => {
    const { config, secrets, local } = connectionConfig(POOLER);
    expect(local).toBe(false);
    expect(config).toMatchObject({
      host: 'aws-0-eu-central-1.pooler.supabase.com',
      port: 5432,
      user: 'postgres.abcdefghijklmnopqrst',
      password: PASSWORD,
      database: 'postgres',
    });
    expect(config.ssl).not.toBe(false);
    const ssl = config.ssl as { rejectUnauthorized: boolean; ca?: string[] };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca?.length).toBeGreaterThan(50);
    expect(secrets).toContain(PASSWORD);
    expect(secrets).toContain(encoded);
  });

  it('adds a configured CA to the trusted set instead of replacing it', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const ssl = connectionConfig(POOLER, { ca: pem }).config.ssl as { rejectUnauthorized: boolean; ca: string[] };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain(pem);
    expect(ssl.ca.length).toBe(trustedCertificates().length + 1);
  });

  it('cannot be weakened by sslmode in the URL; only the explicit opt-in skips verification', () => {
    for (const mode of ['require', 'prefer', 'allow', 'no-verify']) {
      const ssl = connectionConfig(`${POOLER}?sslmode=${mode}`).config.ssl as { rejectUnauthorized: boolean };
      expect(ssl.rejectUnauthorized, mode).toBe(true);
    }
    expect(() => connectionConfig(`${POOLER}?sslmode=disable`)).toThrow(/sslmode=disable/);
    expect(connectionConfig(POOLER, { noVerify: true }).config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('uses plain TCP for a local stack unless TLS is requested', () => {
    expect(connectionConfig('postgresql://postgres:postgres@127.0.0.1:54322/postgres').config.ssl).toBe(false);
    expect(connectionConfig('postgres://postgres:postgres@localhost:54322/postgres').local).toBe(true);
    const ssl = connectionConfig('postgresql://postgres:postgres@[::1]:54322/postgres?sslmode=require').config.ssl;
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it('rejects malformed URLs without echoing them', () => {
    const cases = [
      'not a url',
      `mysql://u:${encoded}@host/db`,
      `postgresql://postgres.ref:Zq9#Kx7@host:5432/postgres`,
      'postgresql://postgres.ref@host:5432/postgres',
      'postgresql://host:5432/postgres',
      'postgresql://u:%E0%A4%A@host/db',
    ];
    for (const url of cases) {
      let message = '';
      try {
        connectionConfig(url);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, url).not.toBe('');
      expect(message).not.toContain('Zq9');
      expect(message).not.toContain('Kx7');
      expect(message).not.toContain(encoded);
      expect(message).not.toContain('host:5432');
    }
  });
});

describe('redaction', () => {
  it('removes secrets and anything shaped like a connection string', () => {
    const text = 'password authentication failed for S3cr3t#Pa:ss@word at postgresql://u:p@h:5432/db and "postgres://x"';
    const out = redact(text, ['S3cr3t#Pa:ss@word']);
    expect(out).not.toContain('S3cr3t');
    expect(out).not.toContain('u:p@h');
    expect(out).toContain('<redacted>');
    expect(out).toContain('<redacted-connection-string>');
  });

  it('replaces longer secrets first so a shorter one cannot leave a fragment', () => {
    expect(redact('abcd-efgh', ['abcd', 'abcd-efgh'])).toBe('<redacted>');
  });

  it('describeError keeps the SQLSTATE and message and redacts', () => {
    const error = Object.assign(new Error('relation "x" already exists (hunter22)'), { code: '42P07' });
    expect(describeError(error, ['hunter22'])).toBe('42P07: relation "x" already exists (<redacted>)');
    expect(describeError('plain', [])).toBe('plain');
  });

  it('recognises certificate verification failures', () => {
    expect(isTlsVerifyError(Object.assign(new Error('x'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }))).toBe(true);
    expect(isTlsVerifyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(isTlsVerifyError(null)).toBe(false);
  });
});
