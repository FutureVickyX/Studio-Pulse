import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_ENV_FILE, REPO_ROOT, describeMissing, loadEnvFile, parseEnv } from '../../../scripts/supabase/env.mjs';
import { fakeSecretKey } from './helpers';

const dirs: string[] = [];
function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-env-'));
  dirs.push(dir);
  const path = join(dir, '.env.local');
  writeFileSync(path, content, 'utf8');
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseEnv', () => {
  it('reads KEY=VALUE lines, with optional quotes, export prefixes and comments', () => {
    const { values, invalidLines } = parseEnv(
      [
        '# comment',
        '',
        'SUPABASE_URL=https://ref.supabase.co',
        'SUPABASE_PUBLISHABLE_KEY = "sb_publishable_abc"  ',
        "SUPABASE_SECRET_KEY='sb_secret_xyz' # trailing comment",
        'export SUPABASE_DB_URL=postgresql://u:p%23w@h:5432/postgres',
        'UNQUOTED=value # comment after whitespace',
        'HASH_INSIDE=abc#def',
        'QUOTED_HASH="a # b"',
        'EQUALS_IN_VALUE=a=b=c',
        '   INDENTED=yes   ',
      ].join('\n'),
    );
    expect(invalidLines).toEqual([]);
    expect(values).toEqual({
      SUPABASE_URL: 'https://ref.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc',
      SUPABASE_SECRET_KEY: 'sb_secret_xyz',
      SUPABASE_DB_URL: 'postgresql://u:p%23w@h:5432/postgres',
      UNQUOTED: 'value',
      HASH_INSIDE: 'abc#def',
      QUOTED_HASH: 'a # b',
      EQUALS_IN_VALUE: 'a=b=c',
      INDENTED: 'yes',
    });
  });

  it('handles CRLF line endings and a UTF-8 byte-order mark', () => {
    const { values } = parseEnv(`${String.fromCharCode(0xfeff)}A=1\r\nB="2"\r\n`);
    expect(values).toEqual({ A: '1', B: '2' });
  });

  it('treats empty values as missing and lets the last assignment win', () => {
    const { values } = parseEnv('A=\nB=""\nC=1\nC=2\nD=1\nD=');
    expect(values).toEqual({ C: '2' });
  });

  it('reports malformed lines by number without failing the rest', () => {
    const { values, invalidLines } = parseEnv('GOOD=1\nnot a pair\n=novalue\n1BAD=x\nUNCLOSED="abc\nTRAIL="a" b\nOK=2');
    expect(values).toEqual({ GOOD: '1', OK: '2' });
    expect(invalidLines).toEqual([2, 3, 4, 5, 6]);
  });

  it('does not treat prototype keys specially', () => {
    const { values } = parseEnv('__proto__=x\nconstructor=y');
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.hasOwn(values, '__proto__')).toBe(true);
    expect(values.constructor).toBe('y');
  });
});

describe('loadEnvFile', () => {
  it('defaults to supabase/.env.local in the repository', () => {
    expect(DEFAULT_ENV_FILE).toBe(join(REPO_ROOT, 'supabase', '.env.local'));
  });

  it('returns which required keys are missing (absent or empty)', () => {
    const path = tempFile('SUPABASE_URL=https://ref.supabase.co\nSUPABASE_SECRET_KEY=\n');
    const loaded = loadEnvFile({ path, required: ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_URL'] });
    expect(loaded.exists).toBe(true);
    expect(loaded.missing).toEqual(['SUPABASE_SECRET_KEY', 'SUPABASE_DB_URL']);
    expect(loaded.values).toEqual({ SUPABASE_URL: 'https://ref.supabase.co' });
  });

  it('treats a missing file as every key missing', () => {
    const loaded = loadEnvFile({ path: join(tmpdir(), 'sp-env-does-not-exist', '.env.local'), required: ['A', 'B'] });
    expect(loaded).toMatchObject({ exists: false, missing: ['A', 'B'], values: {} });
    expect(describeMissing(loaded)).toContain('file not found');
  });

  it('describes missing keys by name only, never by value', () => {
    const secret = fakeSecretKey('DoNotPrintMe1234567890');
    const path = tempFile(`SUPABASE_SECRET_KEY=${secret}\n`);
    const loaded = loadEnvFile({ path, required: ['SUPABASE_SECRET_KEY', 'SUPABASE_DB_URL'] });
    const message = describeMissing(loaded);
    expect(message).toContain('SUPABASE_DB_URL');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('SUPABASE_SECRET_KEY');
  });
});
