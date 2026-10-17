/**
 * The command-line behaviour of scripts/supabase/migrate.mjs and verify.mjs that can be checked
 * without a Supabase project: refusing to run without configuration, refusing wrong keys, and never
 * printing the connection string, password or keys, even when the connection fails.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { REPO_ROOT, fakeSecretKey, legacyKey } from './helpers';

// Each test spawns node processes: slow while the full suite runs in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const MIGRATE = join(REPO_ROOT, 'scripts/supabase/migrate.mjs');
const VERIFY = join(REPO_ROOT, 'scripts/supabase/verify.mjs');

const dirs: string[] = [];
function envFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-cli-'));
  dirs.push(dir);
  const path = join(dir, '.env.local');
  writeFileSync(path, content, 'utf8');
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const PASSWORD = 'Vx9-NotPrinted-Pw7';
const SECRET = fakeSecretKey('NeverPrintThisValue_123456');
const PUBLISHABLE = 'sb_publishable_AbCdEfGhIjKlMnOpQrStUv_1234567';

describe('migrate.mjs', () => {
  it('refuses to run without SUPABASE_DB_URL, for every mode', () => {
    const empty = envFile('# nothing configured\nSUPABASE_DB_URL=\n');
    for (const mode of [[], ['--dry-run'], ['--status']]) {
      const { code, output } = run(MIGRATE, [...mode, '--env-path', empty]);
      expect(code, mode.join(' ')).toBe(2);
      expect(output).toMatch(/Missing in .*: SUPABASE_DB_URL/);
      expect(output).toMatch(/Refusing to run/);
      expect(output).toMatch(/local migration file\(s\)/);
    }
    const { code, output } = run(MIGRATE, ['--status', '--env-path', join(tmpdir(), 'sp-no-such-dir', '.env.local')]);
    expect(code).toBe(2);
    expect(output).toMatch(/file not found/);
  });

  it('rejects unknown and conflicting options', () => {
    expect(run(MIGRATE, ['--bogus']).code).toBe(2);
    expect(run(MIGRATE, ['--dry-run', '--status']).code).toBe(2);
    expect(run(MIGRATE, ['--ssl-ca', 'x.pem', '--ssl-no-verify']).code).toBe(2);
    const help = run(MIGRATE, ['--help']);
    expect(help.code).toBe(0);
    expect(help.output).toMatch(/--ssl-no-verify/);
  });

  it('never prints the URL or the password, even when connecting fails', () => {
    // Port 1 on loopback: refused immediately, no network traffic leaves the machine.
    const url = `postgresql://postgres.abcdefghijklmnopqrst:${encodeURIComponent(PASSWORD)}@127.0.0.1:1/postgres`;
    const path = envFile(`SUPABASE_DB_URL="${url}"\nSUPABASE_SECRET_KEY=${SECRET}\n`);
    const { code, output } = run(MIGRATE, ['--status', '--env-path', path]);
    expect(code).toBe(1);
    expect(output).toMatch(/Could not connect to the database/);
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain(encodeURIComponent(PASSWORD));
    expect(output).not.toContain('postgresql://');
    expect(output).not.toContain('abcdefghijklmnopqrst');
    expect(output).not.toContain(SECRET);
  });

  it('reports a malformed URL without echoing it', () => {
    const path = envFile(`SUPABASE_DB_URL=postgresql://postgres:${PASSWORD}#frag@db.example.com:5432/postgres\n`);
    const { code, output } = run(MIGRATE, ['--dry-run', '--env-path', path]);
    expect(code).toBe(2);
    expect(output).toMatch(/percent-encode/);
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain('db.example.com');
  });

  it('refuses sslmode=disable for a remote host', () => {
    const path = envFile(`SUPABASE_DB_URL=postgresql://postgres:${PASSWORD}@db.example.com:5432/postgres?sslmode=disable\n`);
    const { code, output } = run(MIGRATE, ['--status', '--env-path', path]);
    expect(code).toBe(2);
    expect(output).toMatch(/only reached over TLS/);
    expect(output).not.toContain(PASSWORD);
  });
});

describe('verify.mjs', () => {
  it('refuses to run without the URL and both keys, naming only the missing keys', () => {
    const path = envFile(`SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\nSUPABASE_SECRET_KEY=${SECRET}\n`);
    const { code, output } = run(VERIFY, ['--env-path', path]);
    expect(code).toBe(2);
    expect(output).toMatch(/Missing in .*: SUPABASE_PUBLISHABLE_KEY\./);
    expect(output).not.toContain(SECRET);
  });

  it('refuses a secret key in the publishable slot and a publishable key in the secret slot', () => {
    const swapped = envFile(
      `SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\nSUPABASE_PUBLISHABLE_KEY=${SECRET}\nSUPABASE_SECRET_KEY=${SECRET}\n`,
    );
    const a = run(VERIFY, ['--env-path', swapped]);
    expect(a.code).toBe(2);
    expect(a.output).toMatch(/SUPABASE_PUBLISHABLE_KEY holds a secret/);
    expect(a.output).not.toContain(SECRET);

    const legacy = legacyKey('service_role');
    const swappedLegacy = envFile(
      `SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\nSUPABASE_PUBLISHABLE_KEY=${legacy}\nSUPABASE_SECRET_KEY=${legacy}\n`,
    );
    const b = run(VERIFY, ['--env-path', swappedLegacy]);
    expect(b.code).toBe(2);
    expect(b.output).not.toContain(legacy);

    const notSecret = envFile(
      `SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\nSUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE}\nSUPABASE_SECRET_KEY=${PUBLISHABLE}\n`,
    );
    const c = run(VERIFY, ['--env-path', notSecret]);
    expect(c.code).toBe(2);
    expect(c.output).toMatch(/SUPABASE_SECRET_KEY is not a secret key/);
    expect(c.output).not.toContain(PUBLISHABLE);
  });

  it('refuses a non-https project URL', () => {
    const path = envFile(
      `SUPABASE_URL=http://abcdefghijklmnopqrst.supabase.co\nSUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE}\nSUPABASE_SECRET_KEY=${SECRET}\n`,
    );
    const { code, output } = run(VERIFY, ['--env-path', path]);
    expect(code).toBe(2);
    expect(output).toMatch(/must use https/);
  });

  it('rejects unknown and conflicting options', () => {
    expect(run(VERIFY, ['--bogus']).code).toBe(2);
    expect(run(VERIFY, ['--keep-user', '--delete-live-user']).code).toBe(2);
    expect(run(VERIFY, ['--help']).code).toBe(0);
  });
});
