// Helpers behind scripts/supabase/verify.mjs that need no network: test data builders that
// satisfy (or deliberately violate) the time_entries constraints, the PASS/FAIL recorder, the
// live-test credentials file, and redaction. Unit-tested in tests/unit/database/verify-lib.test.ts,
// including running the builders' entries through the real sync_time_entries on PGlite.
//
// Nothing here prints secrets: passwords, tokens and keys are passed in only to be redacted.

import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';

import { REPO_ROOT, parseEnv } from './env.mjs';
import { redact } from './migrations.mjs';

// ---------------------------------------------------------------------------------------------
// Identifiers and credentials
// ---------------------------------------------------------------------------------------------

/** 8 hex characters naming one verification run (in emails and workspace names). */
export function newRunId() {
  return randomBytes(4).toString('hex');
}

/** `sp-verify-<runId>-<label>@example.com` (example.com is reserved: no mail is ever delivered). */
export function verifyEmail(runId, label) {
  return `sp-verify-${runId}-${label}@example.com`;
}

/** Address of the dedicated live-test user written by `--keep-user`. */
export function liveTestEmail(runId) {
  return `sp-live-${runId}@example.com`;
}

/** Only addresses of this shape are ever deleted through the live-test file. */
export const LIVE_TEST_EMAIL_PATTERN = /^sp-live-[0-9a-f]{8}@example\.com$/;

/**
 * A random password (192 bits from the CSPRNG plus one character of each class, so any
 * password-strength policy configured on the project accepts it). Kept in memory only.
 */
export function generatePassword() {
  return `${randomBytes(24).toString('base64url')}aA1!`;
}

/**
 * A UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version 7, 74 random bits. The desktop tracker
 * uses UUIDv7 interval ids; the verification entries do too.
 * @param {number} [ms]
 */
export function uuidv7(ms = Date.now()) {
  const bytes = randomBytes(16);
  let t = BigInt(Math.trunc(ms));
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------
// sync_time_entries payloads
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{
 *   id?: string, deviceId: string, applicationId: string, applicationName: string,
 *   kind: string, startedAt: string, endedAt: string, activeMs: number, idleMs: number,
 *   endReason: string, projectId?: string | null, taskId?: string | null,
 *   revision?: number, recordedAt?: string
 * }} EntryPayload
 */

/**
 * A valid closed interval, shaped exactly as the desktop serializes it (camelCase keys read by
 * the SQL function). Synthetic: the verification never uploads real activity.
 * @param {{
 *   deviceId: string, startMs: number, durationMs: number, kind?: 'active' | 'idle',
 *   applicationId?: string, applicationName?: string, endReason?: string,
 *   projectId?: string | null, taskId?: string | null
 * }} spec
 * @returns {EntryPayload & { id: string }}
 */
export function buildEntry({
  deviceId,
  startMs,
  durationMs,
  kind = 'active',
  applicationId = 'figma',
  applicationName = 'Figma',
  endReason = kind === 'idle' ? 'inputResumed' : 'appSwitch',
  projectId = null,
  taskId = null,
}) {
  const endMs = startMs + durationMs;
  return {
    id: uuidv7(startMs),
    deviceId,
    applicationId,
    applicationName,
    kind,
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    activeMs: kind === 'active' ? durationMs : 0,
    idleMs: kind === 'idle' ? durationMs : 0,
    endReason,
    projectId,
    taskId,
    revision: 1,
    recordedAt: new Date(endMs).toISOString(),
  };
}

/**
 * Ways to make a valid entry invalid, each with the SQLSTATE the server reports for it. Every one
 * is a property of the entry itself, so `sync_time_entries` must answer `rejected` for that entry
 * and still sync its valid siblings.
 * @type {ReadonlyArray<{ name: string, sqlstate: string, apply: (entry: EntryPayload) => EntryPayload }>}
 */
export const INVALID_ENTRY_VARIANTS = [
  {
    name: 'active + idle does not equal the duration',
    sqlstate: '23514',
    apply: (e) => ({ ...e, activeMs: e.activeMs + 1000 }),
  },
  {
    name: 'idle interval with active time',
    sqlstate: '23514',
    apply: (e) => ({ ...e, kind: 'idle', activeMs: e.activeMs + e.idleMs, idleMs: 0 }),
  },
  {
    name: 'malformed application id',
    sqlstate: '23514',
    apply: (e) => ({ ...e, applicationId: 'Not An Id!' }),
  },
  {
    name: 'unknown end reason',
    sqlstate: '23514',
    apply: (e) => ({ ...e, endReason: 'crashed' }),
  },
  {
    name: 'ends before it starts',
    sqlstate: '23514',
    apply: (e) => ({ ...e, startedAt: e.endedAt, endedAt: e.startedAt, activeMs: 0, idleMs: 0 }),
  },
  {
    name: 'starts before 2020',
    sqlstate: '23514',
    apply: (e) => {
      const duration = Date.parse(e.endedAt) - Date.parse(e.startedAt);
      const start = Date.parse('2019-06-01T00:00:00.000Z');
      return { ...e, startedAt: new Date(start).toISOString(), endedAt: new Date(start + duration).toISOString() };
    },
  },
  {
    name: 'malformed timestamp',
    sqlstate: '22007',
    apply: (e) => ({ ...e, startedAt: 'not a timestamp' }),
  },
  {
    name: 'malformed device id',
    sqlstate: '22P02',
    apply: (e) => ({ ...e, deviceId: 'not-a-uuid' }),
  },
  {
    name: 'missing id',
    sqlstate: '22023',
    apply: (e) => {
      const { id: _id, ...rest } = e;
      return rest;
    },
  },
];

/** The SQLSTATE at the start of a `rejected` result's detail (`'23514: new row ...'`). */
export function detailSqlstate(detail) {
  const match = /^([0-9A-Z]{5}):/.exec(String(detail ?? ''));
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------------------------
// PASS / FAIL recording
// ---------------------------------------------------------------------------------------------

/** Thrown inside a check to fail it with a message (never containing secrets or user data). */
export class CheckFailure extends Error {}

/** Thrown when a step that later checks depend on failed: the remaining checks are not run. */
export class AbortRun extends Error {}

/**
 * Runs named checks, prints `PASS name` / `FAIL name: reason` as they finish, and keeps the tally.
 * Every printed line goes through `redactLine`.
 */
export class CheckRecorder {
  /**
   * @param {{ out?: (line: string) => void, secrets?: () => readonly string[] }} [options]
   */
  constructor({ out = (line) => console.log(line), secrets = () => [] } = {}) {
    this.out = out;
    this.secrets = secrets;
    /** @type {{ name: string, ok: boolean, reason?: string }[]} */
    this.results = [];
  }

  /** @param {string} text */
  redactLine(text) {
    return redact(text, this.secrets());
  }

  /**
   * Run one check. Returns the check's value, or `undefined` when it failed.
   * @template T
   * @param {string} name
   * @param {() => Promise<T> | T} fn
   * @param {{ required?: boolean }} [options] `required`: a failure aborts the run (AbortRun)
   * @returns {Promise<T | undefined>}
   */
  async check(name, fn, { required = false } = {}) {
    try {
      const value = await fn();
      this.results.push({ name, ok: true });
      this.out(this.redactLine(`PASS  ${name}`));
      return value;
    } catch (error) {
      const reason =
        error instanceof CheckFailure || error instanceof AbortRun
          ? error.message
          : `unexpected error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      this.results.push({ name, ok: false, reason });
      this.out(this.redactLine(`FAIL  ${name}: ${reason}`));
      if (required) throw new AbortRun(`a required step failed (${name})`);
      return undefined;
    }
  }

  get passed() {
    return this.results.filter((r) => r.ok).length;
  }

  get failed() {
    return this.results.filter((r) => !r.ok).length;
  }

  summary() {
    return `${this.passed} passed, ${this.failed} failed.`;
  }
}

/**
 * Assertion helpers that throw CheckFailure with short, data-free messages.
 */
export const expect = {
  /** @param {unknown} condition @param {string} message */
  that(condition, message) {
    if (!condition) throw new CheckFailure(message);
  },
  /**
   * A supabase-js result must have succeeded.
   * @template T
   * @param {{ data?: T, error?: unknown }} result
   * @param {string} what
   * @returns {T}
   */
  ok(result, what) {
    if (result.error) throw new CheckFailure(`${what} failed (${describeSupabaseError(result.error)})`);
    return /** @type {T} */ (result.data);
  },
  /**
   * A supabase-js result must have failed, optionally with one of `codes` (SQLSTATE / PostgREST
   * code).
   * @param {{ data?: unknown, error?: unknown }} result
   * @param {string} what
   * @param {readonly string[]} [codes]
   */
  denied(result, what, codes) {
    if (!result.error) throw new CheckFailure(`${what} was allowed`);
    const code = errorCode(result.error);
    if (codes && codes.length > 0 && !codes.includes(code ?? '')) {
      throw new CheckFailure(`${what} failed with ${code ?? 'no code'}, expected ${codes.join(' or ')}`);
    }
  },
  /**
   * A read must return nothing: either an error (no privilege) or zero rows (filtered by RLS).
   * @param {{ data?: unknown, error?: unknown }} result
   * @param {string} what
   */
  noRows(result, what) {
    if (result.error) return;
    const rows = Array.isArray(result.data) ? result.data : result.data == null ? [] : [result.data];
    if (rows.length > 0) throw new CheckFailure(`${what} returned ${rows.length} row(s)`);
  },
};

/** @param {unknown} error */
export function errorCode(error) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return null;
}

/**
 * `code: message` of a supabase-js / PostgREST / Auth error, without details or hints (which can
 * echo row values).
 * @param {unknown} error
 */
export function describeSupabaseError(error) {
  if (error && typeof error === 'object') {
    const e = /** @type {{ code?: unknown, message?: unknown, status?: unknown }} */ (error);
    const code = typeof e.code === 'string' && e.code !== '' ? e.code : typeof e.status === 'number' ? `HTTP ${e.status}` : 'error';
    const message = typeof e.message === 'string' ? e.message.split('\n')[0] : '';
    return `${code}${message ? `: ${message.slice(0, 160)}` : ''}`;
  }
  return String(error).slice(0, 160);
}

// ---------------------------------------------------------------------------------------------
// Live-test credentials file (supabase/.live-test.local)
// ---------------------------------------------------------------------------------------------

/** Where `--keep-user` writes the dedicated live-test user's credentials (gitignored). */
export const LIVE_TEST_FILE = resolve(REPO_ROOT, 'supabase', '.live-test.local');

/**
 * Keys of the live-test file. They are the environment variable names the Rust live test
 * (apps/desktop/src-tauri/tests/supabase_live.rs) reads, so the file can be loaded into the
 * environment as is (scripts/supabase/README.md shows how).
 */
export const LIVE_TEST_KEYS = Object.freeze({
  email: 'SP_LIVE_EMAIL',
  password: 'SP_LIVE_PASSWORD',
  userId: 'SP_LIVE_USER_ID',
  workspaceId: 'SP_LIVE_WORKSPACE_ID',
});

/** Public values the Rust live test also needs (the desktop's build-time variable names). */
export const LIVE_TEST_PUBLIC_KEYS = Object.freeze({
  url: 'STUDIO_PULSE_SUPABASE_URL',
  publishableKey: 'STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY',
});

/**
 * @param {{ email: string, password: string, userId: string, workspaceId: string, url?: string, publishableKey?: string }} creds
 *   `url` / `publishableKey`: the project's public values, written so the file alone is enough
 *   to run the Rust live test.
 */
export function formatLiveTestFile({ email, password, userId, workspaceId, url, publishableKey }) {
  return [
    '# Studio Pulse live-test user, written by `npm run supabase:verify -- --keep-user`.',
    '# Local only: gitignored, never commit, never share. Remove the user with',
    '# `npm run supabase:verify -- --delete-live-user`.',
    ...(url ? [`${LIVE_TEST_PUBLIC_KEYS.url}=${url}`] : []),
    ...(publishableKey ? [`${LIVE_TEST_PUBLIC_KEYS.publishableKey}=${publishableKey}`] : []),
    `${LIVE_TEST_KEYS.email}=${email}`,
    `${LIVE_TEST_KEYS.password}=${password}`,
    `${LIVE_TEST_KEYS.userId}=${userId}`,
    `${LIVE_TEST_KEYS.workspaceId}=${workspaceId}`,
    '',
  ].join('\n');
}

/**
 * @param {string} text
 * @returns {{ email: string, password: string, userId: string, workspaceId: string } | null}
 */
export function parseLiveTestFile(text) {
  const { values } = parseEnv(text);
  const email = values[LIVE_TEST_KEYS.email];
  const password = values[LIVE_TEST_KEYS.password];
  const userId = values[LIVE_TEST_KEYS.userId];
  const workspaceId = values[LIVE_TEST_KEYS.workspaceId];
  if (!email || !password || !userId || !workspaceId) return null;
  return { email, password, userId, workspaceId };
}

/**
 * Is `path` ignored by git in this repository? `true` / `false`, or `null` when git cannot tell
 * (not installed, not a repository).
 * @param {string} path
 */
export function isGitIgnored(path) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', relative(REPO_ROOT, path).replaceAll('\\', '/')], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Configuration checks (same rules as packages/database/src/config.ts)
// ---------------------------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The bare project URL (`https://<ref>.supabase.co`, or local http), or throws an Error that
 * does not contain the URL.
 * @param {string} raw
 */
export function normaliseProjectUrl(raw) {
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(raw.trim().replace(/\/+$/, ''));
  } catch {
    throw new Error('SUPABASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname))) {
    throw new Error('SUPABASE_URL must use https (plain http only for localhost).');
  }
  if (parsed.username !== '' || parsed.password !== '') throw new Error('SUPABASE_URL must not contain credentials.');
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('SUPABASE_URL must be the bare project URL (no path, query or fragment).');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/** A random device id for one run's synthetic entries. */
export function newDeviceId() {
  return randomUUID();
}
