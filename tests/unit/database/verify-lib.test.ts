/**
 * scripts/supabase/verify-lib.mjs: the offline parts of the real-project verification. The entry
 * builders and invalid variants are also run through the real `sync_time_entries` (PGlite), so the
 * expectations verify.mjs has of the hosted project are known to match the migrations.
 */

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { applyMigrations, listMigrations } from '../../../scripts/supabase/migrations.mjs';
import {
  CheckFailure,
  CheckRecorder,
  INVALID_ENTRY_VARIANTS,
  LIVE_TEST_EMAIL_PATTERN,
  LIVE_TEST_FILE,
  LIVE_TEST_KEYS,
  buildEntry,
  describeSupabaseError,
  detailSqlstate,
  expect as check,
  formatLiveTestFile,
  generatePassword,
  isGitIgnored,
  liveTestEmail,
  newRunId,
  normaliseProjectUrl,
  parseLiveTestFile,
  uuidv7,
  verifyEmail,
} from '../../../scripts/supabase/verify-lib.mjs';
import { MIGRATIONS_DIR, MIGRATION_OWNER, asQueryable, asUser, createAuthUser, fakeSecretKey, supabaseLikeDb } from './helpers';

// PGlite (WASM Postgres) boots and migrates once per file: slow while the full suite runs in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const MINUTE = 60_000;

describe('identifiers and credentials', () => {
  it('run ids and emails have the documented shape', () => {
    const runId = newRunId();
    expect(runId).toMatch(/^[0-9a-f]{8}$/);
    expect(verifyEmail(runId, 'a')).toBe(`sp-verify-${runId}-a@example.com`);
    expect(liveTestEmail(runId)).toMatch(LIVE_TEST_EMAIL_PATTERN);
    expect(LIVE_TEST_EMAIL_PATTERN.test('someone@example.com')).toBe(false);
    expect(LIVE_TEST_EMAIL_PATTERN.test(`sp-live-${runId}@example.com.evil`)).toBe(false);
  });

  it('passwords are long, random and contain every character class', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(36);
    for (const re of [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]) expect(a).toMatch(re);
  });

  it('uuidv7 encodes the timestamp, version 7 and the RFC variant', () => {
    const ms = Date.parse('2026-10-17T12:34:56.789Z');
    const id = uuidv7(ms);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(ms);
    expect(uuidv7(ms)).not.toBe(id);
    expect(uuidv7(ms) < uuidv7(ms + 1)).toBe(true);
  });
});

describe('buildEntry', () => {
  it('produces a closed interval whose split equals its duration', () => {
    const start = Date.parse('2026-10-17T08:00:00.000Z');
    const active = buildEntry({ deviceId: 'd', startMs: start, durationMs: 25 * MINUTE + 7 });
    expect(active).toMatchObject({
      kind: 'active',
      activeMs: 25 * MINUTE + 7,
      idleMs: 0,
      endReason: 'appSwitch',
      startedAt: '2026-10-17T08:00:00.000Z',
      endedAt: '2026-10-17T08:25:00.007Z',
      revision: 1,
    });
    const idle = buildEntry({ deviceId: 'd', startMs: start, durationMs: MINUTE, kind: 'idle' });
    expect(idle).toMatchObject({ kind: 'idle', activeMs: 0, idleMs: MINUTE, endReason: 'inputResumed' });
    // Only the fields the SQL function reads; nothing the server assigns.
    expect(Object.keys(active).sort()).toEqual(
      ['activeMs', 'applicationId', 'applicationName', 'deviceId', 'endReason', 'endedAt', 'id', 'idleMs', 'kind', 'projectId', 'recordedAt', 'revision', 'startedAt', 'taskId'],
    );
  });
});

describe('sync_time_entries accepts the builders and rejects every invalid variant (PGlite)', () => {
  let pg: PGlite;
  let workspaceId = '';
  const user = { id: '', email: 'sp-verify-unit-a@example.com' };
  const other = { id: '', email: 'sp-verify-unit-b@example.com' };

  beforeAll(async () => {
    pg = await supabaseLikeDb();
    await pg.exec(`set role ${MIGRATION_OWNER}`);
    const result = await applyMigrations(asQueryable(pg), listMigrations(MIGRATIONS_DIR).migrations);
    expect(result.status).toBe('applied');
    await pg.exec('reset role');
    user.id = await createAuthUser(pg, user.email);
    other.id = await createAuthUser(pg, other.email);
    workspaceId = await asUser(pg, user, async (tx) => {
      const r = await tx.query<{ id: string }>(`select id from public.create_workspace('Unit')`);
      return r.rows[0]!.id;
    });
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  async function sync(as: { id: string; email: string }, entries: unknown[]) {
    return asUser(pg, as, async (tx) => {
      const r = await tx.query<{ entry_id: string | null; status: string; detail: string | null }>(
        'select * from public.sync_time_entries($1, $2::jsonb)',
        [workspaceId, JSON.stringify(entries)],
      );
      return r.rows;
    });
  }

  const base = Date.parse('2026-10-17T06:00:00.000Z');

  it('valid entries sync, and a retry answers already present without duplicates', async () => {
    const batch = [
      buildEntry({ deviceId: crypto.randomUUID(), startMs: base, durationMs: 25 * MINUTE }),
      buildEntry({ deviceId: crypto.randomUUID(), startMs: base + 25 * MINUTE, durationMs: 5 * MINUTE + 1, kind: 'idle' }),
    ];
    expect(await sync(user, batch)).toEqual(batch.map((e) => ({ entry_id: e.id, status: 'synced', detail: null })));
    expect(await sync(user, batch)).toEqual(batch.map((e) => ({ entry_id: e.id, status: 'synced', detail: 'already present' })));
    const count = await pg.query<{ n: number }>('select count(*)::int as n from public.time_entries where id = any($1::uuid[])', [
      batch.map((e) => e.id),
    ]);
    expect(count.rows[0]!.n).toBe(2);
  });

  it.each(INVALID_ENTRY_VARIANTS.map((v) => [v.name, v] as const))('rejects "%s" with its SQLSTATE', async (_name, variant) => {
    const valid = buildEntry({ deviceId: crypto.randomUUID(), startMs: base + 60 * MINUTE, durationMs: 3 * MINUTE });
    const invalid = variant.apply({ ...buildEntry({ deviceId: crypto.randomUUID(), startMs: base + 70 * MINUTE, durationMs: MINUTE }) });
    const results = await sync(user, [valid, invalid]);
    expect(results[0]).toEqual({ entry_id: valid.id, status: 'synced', detail: null });
    expect(results[1]?.status).toBe('rejected');
    expect(results[1]?.entry_id).toBe(invalid.id ?? null);
    expect(detailSqlstate(results[1]?.detail)).toBe(variant.sqlstate);
  });

  it('an id owned by someone else is rejected (not overwritten) once that user is a member', async () => {
    const original = buildEntry({ deviceId: crypto.randomUUID(), startMs: base + 90 * MINUTE, durationMs: MINUTE });
    await sync(user, [original]);
    // Make `other` a member the privileged way (invitation → acceptance).
    const token = await asUser(pg, user, async (tx) => {
      const r = await tx.query<{ token: string }>(`select token from public.create_invitation($1, $2, 'member')`, [workspaceId, other.email]);
      return r.rows[0]!.token;
    });
    await asUser(pg, other, (tx) => tx.query('select public.accept_invitation($1)', [token]));
    const stolen = { ...buildEntry({ deviceId: crypto.randomUUID(), startMs: base, durationMs: MINUTE, applicationId: 'blender', applicationName: 'Blender' }), id: original.id };
    const [result] = await sync(other, [stolen]);
    expect(result?.status).toBe('rejected');
    expect(detailSqlstate(result?.detail)).toBe('23505');
    const row = await pg.query<{ user_id: string; application_id: string }>('select user_id, application_id from public.time_entries where id = $1', [original.id]);
    expect(row.rows[0]).toEqual({ user_id: user.id, application_id: 'figma' });
  });
});

describe('CheckRecorder', () => {
  it('prints PASS/FAIL per check, tallies, and redacts secrets from every line', async () => {
    const lines: string[] = [];
    const secret = fakeSecretKey('TopSecretValue123456');
    const rec = new CheckRecorder({ out: (l) => lines.push(l), secrets: () => [secret] });
    expect(await rec.check('passes', () => 42)).toBe(42);
    expect(await rec.check('fails cleanly', () => {
      throw new CheckFailure(`token ${secret} leaked`);
    })).toBeUndefined();
    await rec.check('crashes', async () => {
      throw new TypeError('boom');
    });
    expect(lines).toEqual(['PASS  passes', 'FAIL  fails cleanly: token <redacted> leaked', 'FAIL  crashes: unexpected error: TypeError: boom']);
    expect(rec.summary()).toBe('1 passed, 2 failed.');
  });

  it('a failing required step aborts the run', async () => {
    const rec = new CheckRecorder({ out: () => {} });
    await expect(
      rec.check('setup', () => {
        throw new CheckFailure('no');
      }, { required: true }),
    ).rejects.toThrow(/a required step failed \(setup\)/);
    expect(rec.failed).toBe(1);
  });
});

describe('assertion helpers', () => {
  it('ok / denied / noRows', () => {
    expect(check.ok({ data: [1], error: null }, 'x')).toEqual([1]);
    expect(() => check.ok({ data: null, error: { code: '42501', message: 'permission denied' } }, 'reading')).toThrow(
      'reading failed (42501: permission denied)',
    );
    expect(() => check.denied({ data: [], error: null }, 'escalating')).toThrow('escalating was allowed');
    expect(() => check.denied({ error: { code: 'P0002' } }, 'x', ['42501'])).toThrow(/failed with P0002, expected 42501/);
    expect(() => check.denied({ error: { code: '42501' } }, 'x', ['42501'])).not.toThrow();
    expect(() => check.noRows({ data: [], error: null }, 'x')).not.toThrow();
    expect(() => check.noRows({ data: null, error: { code: '42501' } }, 'x')).not.toThrow();
    expect(() => check.noRows({ data: [{ id: 1 }], error: null }, 'C reading')).toThrow('C reading returned 1 row(s)');
  });

  it('describeSupabaseError keeps the code and the first line of the message only', () => {
    expect(describeSupabaseError({ code: '23514', message: 'new row violates\nFailing row contains (secret data)', details: 'x' })).toBe(
      '23514: new row violates',
    );
    expect(describeSupabaseError({ status: 400, message: 'Invalid login credentials' })).toBe('HTTP 400: Invalid login credentials');
  });

  it('detailSqlstate reads the code at the start of a rejection detail', () => {
    expect(detailSqlstate('23514: new row for relation "time_entries" violates check constraint')).toBe('23514');
    expect(detailSqlstate('already present')).toBeNull();
    expect(detailSqlstate(null)).toBeNull();
  });
});

describe('live-test file', () => {
  it('round-trips and is parsed only when complete', () => {
    const creds = { email: 'sp-live-0a1b2c3d@example.com', password: generatePassword(), userId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
    const text = formatLiveTestFile(creds);
    expect(parseLiveTestFile(text)).toEqual(creds);
    expect(parseLiveTestFile(text.replace(/SP_LIVE_PASSWORD=.*\n/, ''))).toBeNull();
  });

  it('uses the environment variable names the Rust live test reads, plus the public values', () => {
    const creds = { email: 'sp-live-0a1b2c3d@example.com', password: generatePassword(), userId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
    const text = formatLiveTestFile({
      ...creds,
      url: 'https://abcdefghijklmnopqrst.supabase.co',
      publishableKey: 'sb_publishable_AbCdEf0123456789',
    });
    const keys = text
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.slice(0, line.indexOf('=')));
    // apps/desktop/src-tauri/tests/supabase_live.rs: VARS
    expect(keys).toEqual([
      'STUDIO_PULSE_SUPABASE_URL',
      'STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY',
      'SP_LIVE_EMAIL',
      'SP_LIVE_PASSWORD',
      'SP_LIVE_USER_ID',
      'SP_LIVE_WORKSPACE_ID',
    ]);
    expect(LIVE_TEST_KEYS.password).toBe('SP_LIVE_PASSWORD');
    expect(parseLiveTestFile(text)).toEqual(creds);
    // The secret key never goes into this file.
    expect(text).not.toMatch(/SECRET|service_role|sb_secret_/i);
  });

  it('lives at supabase/.live-test.local, which git ignores', () => {
    expect(LIVE_TEST_FILE.replaceAll('\\', '/')).toMatch(/\/supabase\/\.live-test\.local$/);
    const ignored = isGitIgnored(LIVE_TEST_FILE);
    // null only when git is unavailable; then verify.mjs refuses to write the file.
    expect(ignored === null || ignored === true).toBe(true);
  });
});

describe('normaliseProjectUrl', () => {
  it('applies the same URL rule as the TypeScript package, without echoing the URL', () => {
    expect(normaliseProjectUrl('https://abcdefghijklmnopqrst.supabase.co/')).toBe('https://abcdefghijklmnopqrst.supabase.co');
    expect(normaliseProjectUrl('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321');
    for (const bad of ['http://secret-host.example', 'https://u:p@secret-host.example', 'https://secret-host.example/rest', 'nope']) {
      let message = '';
      try {
        normaliseProjectUrl(bad);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('secret-host');
    }
  });
});
