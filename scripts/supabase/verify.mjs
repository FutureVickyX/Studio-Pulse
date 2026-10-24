#!/usr/bin/env node
// End-to-end verification of the REAL Supabase project in supabase/.env.local.
//
//   npm run supabase:verify                          run every check, then delete what it created
//   npm run supabase:verify -- --keep-user           also leave a dedicated live-test user behind
//   npm run supabase:verify -- --delete-live-user    delete that live-test user, run nothing else
//
// The secret key is used locally, and only to create and delete throwaway confirmed users (and to
// delete their workspaces during cleanup). Every check acts exclusively through the publishable
// key, as anonymous or as one of those users with their own session, exactly like a client.
// `runChecks` is also exported, so the same checks can run against users an operator provisioned
// another way (for example with SQL); the caller then owns user creation and cleanup.
//
// Output: one PASS/FAIL line per check, then a summary. Exit code 0 only when every check passed
// and cleanup succeeded. Keys, passwords, access/refresh tokens and invitation tokens are never
// printed (every line is also run through a redactor as a second line of defence). See
// scripts/supabase/README.md.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { DEFAULT_ENV_FILE, REPO_ROOT, describeMissing, loadEnvFile } from './env.mjs';
import { classifyKey } from './keys.mjs';
import {
  AbortRun,
  CheckFailure,
  CheckRecorder,
  INVALID_ENTRY_VARIANTS,
  LIVE_TEST_EMAIL_PATTERN,
  LIVE_TEST_FILE,
  buildEntry,
  describeSupabaseError,
  detailSqlstate,
  expect,
  formatLiveTestFile,
  generatePassword,
  isGitIgnored,
  liveTestEmail,
  newDeviceId,
  newRunId,
  normaliseProjectUrl,
  parseLiveTestFile,
  uuidv7,
  verifyEmail,
} from './verify-lib.mjs';

const USAGE = `Usage: node scripts/supabase/verify.mjs [--keep-user | --delete-live-user] [--env-path <path>]

  --keep-user         after all checks pass, create a dedicated live-test user with a workspace,
                      print its email and workspace id, and write its credentials to
                      supabase/.live-test.local (gitignored) for the Rust live test
  --delete-live-user  delete the user recorded in supabase/.live-test.local and the file
  --env-path <path>   env file (default: supabase/.env.local)`;

const REQUIRED_KEYS = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'];
const TABLES = /** @type {const} */ ([
  'profiles',
  'workspaces',
  'workspace_members',
  'workspace_invitations',
  'projects',
  'tasks',
  'notes',
  'time_entries',
]);
const REQUEST_TIMEOUT_MS = 30_000;
const MINUTE = 60_000;

/** Every value that must never be printed; the recorder redacts all of them. */
const secrets = new Set();
export const secretList = () => [...secrets];
/** Register a value (e.g. a provisioned user's password) for redaction. @param {string} value */
export const registerSecret = (value) => void secrets.add(value);

/** @param {string} line */
const say = (line) => console.log(redactText(line));
/** @param {string} line */
const warn = (line) => console.error(redactText(line));
/** @param {string} text */
function redactText(text) {
  let out = String(text);
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s.length >= 4) out = out.split(s).join('<redacted>');
  }
  return out;
}

class UsageError extends Error {}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { keepUser: false, deleteLiveUser: false, envFile: DEFAULT_ENV_FILE, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--keep-user':
        options.keepUser = true;
        break;
      case '--delete-live-user':
        options.deleteLiveUser = true;
        break;
      case '--env-path': {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new UsageError('--env-path needs a value.');
        options.envFile = v;
        i += 1;
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new UsageError(`Unknown option ${arg}.`);
    }
  }
  if (options.keepUser && options.deleteLiveUser) throw new UsageError('Use either --keep-user or --delete-live-user.');
  return options;
}

/** fetch with a per-request timeout, so a stalled request fails a check instead of hanging. */
/** @type {typeof fetch} */
const timedFetch = (input, init) =>
  fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

/**
 * A supabase-js client that keeps its session in memory only.
 * @param {string} url
 * @param {string} key
 * @param {string} storageKey
 */
function makeClient(url, key, storageKey) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey },
    global: { fetch: timedFetch },
  });
}

/** @typedef {ReturnType<typeof makeClient>} Client */
/** @typedef {{ label: string, email: string, password: string, id: string }} TestUser */

/**
 * @param {Client} admin
 * @param {string} email
 * @param {string} displayName
 * @param {(id: string) => void} [onCreated]
 * @returns {Promise<TestUser>}
 */
async function createConfirmedUser(admin, email, displayName, onCreated) {
  const password = generatePassword();
  secrets.add(password);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (error || !data.user) throw new CheckFailure(`creating a test user failed (${describeSupabaseError(error)})`);
  onCreated?.(data.user.id);
  return { label: displayName, email, password, id: data.user.id };
}

/**
 * Sign in through the publishable key; the session stays in this client's memory.
 * @param {string} url
 * @param {string} publishableKey
 * @param {TestUser} user
 * @param {string} storageKey
 */
async function signIn(url, publishableKey, user, storageKey) {
  const client = makeClient(url, publishableKey, storageKey);
  const { data, error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (data?.session) {
    secrets.add(data.session.access_token);
    secrets.add(data.session.refresh_token);
  }
  if (error || !data.session) throw new CheckFailure(`sign-in failed (${describeSupabaseError(error)})`);
  if (data.user?.id !== user.id) throw new CheckFailure('sign-in returned a different user');
  return client;
}

/**
 * The row of an RPC that returns one composite value (PostgREST returns an object; tolerate a
 * one-element array).
 * @param {unknown} data
 */
function single(data) {
  return /** @type {Record<string, unknown> | undefined} */ (Array.isArray(data) ? data[0] : data);
}

/** @param {{ data?: unknown }} result */
function rowsOf(result) {
  return /** @type {Record<string, unknown>[]} */ (Array.isArray(result.data) ? result.data : []);
}

/**
 * Number of time entries `client` can see in `workspaceId`.
 * @param {Client} client
 * @param {string} workspaceId
 */
async function visibleEntryCount(client, workspaceId) {
  const result = await client.from('time_entries').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
  expect.ok(result, 'counting time entries');
  return result.count ?? 0;
}

/**
 * @param {Client} client
 * @param {string} workspaceId
 * @param {unknown[]} entries
 */
async function sync(client, workspaceId, entries) {
  return client.rpc('sync_time_entries', { p_workspace_id: workspaceId, p_entries: entries });
}

/**
 * Results must be one per entry, in order, all with `status` (and optionally `detail`).
 * @param {unknown} data
 * @param {readonly { id?: string }[]} entries
 * @param {'synced' | 'rejected'} status
 * @param {string | null | undefined} [detail] `undefined` = do not check
 */
function expectResults(data, entries, status, detail) {
  const results = /** @type {{ entry_id: string | null, status: string, detail: string | null }[]} */ (
    Array.isArray(data) ? data : []
  );
  expect.that(results.length === entries.length, `expected ${entries.length} result(s), got ${results.length}`);
  results.forEach((r, i) => {
    const entry = entries[i];
    expect.that(r.entry_id === (entry?.id ?? null), `result ${i + 1} is for a different entry`);
    expect.that(r.status === status, `entry ${i + 1}: expected ${status}, got ${r.status}`);
    if (detail !== undefined) expect.that(r.detail === detail, `entry ${i + 1}: unexpected detail`);
  });
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

/**
 * Creates (or looks up) one confirmed throwaway user. `main` uses the secret key; another caller
 * may hand over users it provisioned itself. Passwords must be registered with `registerSecret`.
 * @typedef {(email: string, displayName: string) => Promise<TestUser>} Provision
 */

/**
 * @param {CheckRecorder} rec
 * @param {{ url: string, publishableKey: string, provision: Provision, runId: string, state: CleanupState }} ctx
 */
export async function runChecks(rec, { url, publishableKey, provision, runId, state }) {
  // -- Setup -----------------------------------------------------------------------------------
  const users = await rec.check(
    'setup: three confirmed throwaway users',
    async () => {
      /** @type {TestUser[]} */
      const created = [];
      for (const label of ['a', 'b', 'c']) {
        const user = await provision(verifyEmail(runId, label), `SP Verify ${label.toUpperCase()}`);
        state.userIds.add(user.id);
        created.push({ ...user, label: label.toUpperCase() });
      }
      return created;
    },
    { required: true },
  );
  const [userA, userB, userC] = /** @type {[TestUser, TestUser, TestUser]} */ (users);

  // -- Authentication --------------------------------------------------------------------------
  const clients = await rec.check(
    'auth: A, B and C sign in with the publishable key and their own passwords',
    async () => ({
      A: await signIn(url, publishableKey, userA, `sp-verify-${runId}-a`),
      B: await signIn(url, publishableKey, userB, `sp-verify-${runId}-b`),
      C: await signIn(url, publishableKey, userC, `sp-verify-${runId}-c`),
    }),
    { required: true },
  );
  const { A, B, C } = /** @type {{ A: Client, B: Client, C: Client }} */ (clients);
  const anon = makeClient(url, publishableKey, `sp-verify-${runId}-anon`);

  await rec.check('auth: a wrong password is refused', async () => {
    const probe = makeClient(url, publishableKey, `sp-verify-${runId}-probe`);
    const { data, error } = await probe.auth.signInWithPassword({ email: userA.email, password: `${generatePassword()}x` });
    expect.that(error && !data.session, 'signing in with a wrong password succeeded');
  });

  await rec.check('auth: a profile row was created for each new user, readable by its owner', async () => {
    const r = await A.from('profiles').select('id, display_name').eq('id', userA.id);
    const rows = rowsOf({ data: expect.ok(r, 'reading own profile') });
    expect.that(rows.length === 1, `expected 1 own profile row, got ${rows.length}`);
  });

  // -- Workspaces -------------------------------------------------------------------------------
  const wsA = await rec.check(
    'workspaces: create_workspace makes the caller its owner',
    async () => {
      const r = await A.rpc('create_workspace', { p_name: `SP Verify ${runId} A` });
      const row = single(expect.ok(r, 'create_workspace'));
      const id = typeof row?.id === 'string' ? row.id : null;
      expect.that(id, 'create_workspace returned no id');
      state.workspaceIds.add(/** @type {string} */ (id));
      expect.that(row?.time_entry_visibility === 'private', 'a new workspace is not private by default');
      const mine = rowsOf({ data: expect.ok(await A.rpc('my_workspaces'), 'my_workspaces') });
      expect.that(
        mine.some((w) => w.workspace_id === id && w.role === 'owner'),
        'my_workspaces does not list the new workspace with role owner',
      );
      return /** @type {string} */ (id);
    },
    { required: true },
  );
  const ws = /** @type {string} */ (wsA);

  const outside = await rec.check(
    'workspaces: C creates a separate workspace with its own project and task',
    async () => {
      const r = await C.rpc('create_workspace', { p_name: `SP Verify ${runId} C` });
      const row = single(expect.ok(r, 'create_workspace'));
      const id = /** @type {string} */ (row?.id);
      expect.that(typeof id === 'string', 'create_workspace returned no id');
      state.workspaceIds.add(id);
      const p = await C.from('projects').insert({ workspace_id: id, name: 'C project' }).select('id').single();
      const project = /** @type {{ id: string }} */ (expect.ok(p, 'inserting a project'));
      const t = await C.from('tasks').insert({ workspace_id: id, project_id: project.id, title: 'C task' }).select('id').single();
      const task = /** @type {{ id: string }} */ (expect.ok(t, 'inserting a task'));
      return { workspaceId: id, projectId: project.id, taskId: task.id };
    },
    { required: true },
  );
  const wsC = /** @type {{ workspaceId: string, projectId: string, taskId: string }} */ (outside);

  const content = await rec.check(
    'workspaces: the owner creates a project, a task, a private note and a workspace note',
    async () => {
      const p = await A.from('projects').insert({ workspace_id: ws, name: 'Verify project' }).select('id').single();
      const project = /** @type {{ id: string }} */ (expect.ok(p, 'inserting a project'));
      const t = await A.from('tasks').insert({ workspace_id: ws, project_id: project.id, title: 'Verify task' }).select('id').single();
      const task = /** @type {{ id: string }} */ (expect.ok(t, 'inserting a task'));
      const np = await A.from('notes')
        .insert({ workspace_id: ws, title: 'Private', body: 'synthetic', visibility: 'private' })
        .select('id')
        .single();
      const privateNote = /** @type {{ id: string }} */ (expect.ok(np, 'inserting a private note'));
      const nw = await A.from('notes')
        .insert({ workspace_id: ws, title: 'Shared', body: 'synthetic', visibility: 'workspace' })
        .select('id, version')
        .single();
      const sharedNote = /** @type {{ id: string, version: number }} */ (expect.ok(nw, 'inserting a workspace note'));
      expect.that(sharedNote.version === 1, 'a new note does not start at version 1');
      return { projectId: project.id, taskId: task.id, privateNoteId: privateNote.id, sharedNoteId: sharedNote.id };
    },
    { required: true },
  );
  const own = /** @type {{ projectId: string, taskId: string, privateNoteId: string, sharedNoteId: string }} */ (content);

  // -- Invitations ------------------------------------------------------------------------------
  const token = await rec.check(
    'invitations: the owner invites B as member; only a hash is stored',
    async () => {
      const r = await A.rpc('create_invitation', { p_workspace_id: ws, p_email: userB.email, p_role: 'member' });
      const row = single(expect.ok(r, 'create_invitation'));
      const t = row?.token;
      expect.that(typeof t === 'string' && /^[0-9a-f]{64}$/.test(t), 'create_invitation returned no 64-hex token');
      secrets.add(/** @type {string} */ (t));
      const listed = await A.from('workspace_invitations').select('id, email, role').eq('workspace_id', ws);
      const rows = rowsOf({ data: expect.ok(listed, 'listing invitations') });
      expect.that(rows.length === 1 && rows[0]?.role === 'member', 'the invitation is not listed for the owner');
      expect.denied(await A.from('workspace_invitations').select('token_hash').eq('workspace_id', ws), 'reading token_hash', [
        '42501',
      ]);
      return /** @type {string} */ (t);
    },
    { required: true },
  );

  await rec.check('invitations: an invitation addressed to B cannot be accepted by C', async () => {
    expect.denied(await C.rpc('accept_invitation', { p_token: /** @type {string} */ (token) }), 'C accepting B\'s invitation', [
      '42501',
    ]);
  });

  await rec.check(
    'invitations: B accepts and becomes a member',
    async () => {
      const r = await B.rpc('accept_invitation', { p_token: /** @type {string} */ (token) });
      expect.that(expect.ok(r, 'accept_invitation') === ws, 'accept_invitation returned a different workspace');
      const mine = rowsOf({ data: expect.ok(await B.rpc('my_workspaces'), 'my_workspaces') });
      expect.that(mine.some((w) => w.workspace_id === ws && w.role === 'member'), 'B is not listed as a member');
    },
    { required: true },
  );

  await rec.check('invitations: a used invitation cannot be accepted again', async () => {
    expect.denied(await B.rpc('accept_invitation', { p_token: /** @type {string} */ (token) }), 'accepting twice', ['P0002']);
  });

  await rec.check('invitations: a member cannot invite', async () => {
    expect.denied(
      await B.rpc('create_invitation', { p_workspace_id: ws, p_email: userC.email, p_role: 'member' }),
      'a member inviting',
      ['42501'],
    );
  });

  // -- Role escalation ----------------------------------------------------------------------------
  await rec.check('roles: B cannot change its own or the owner\'s role', async () => {
    expect.denied(await B.rpc('set_member_role', { p_workspace_id: ws, p_user_id: userB.id, p_role: 'owner' }), 'B making itself owner', [
      '42501',
    ]);
    expect.denied(
      await B.rpc('set_member_role', { p_workspace_id: ws, p_user_id: userA.id, p_role: 'member' }),
      'B demoting the owner',
      ['42501'],
    );
    expect.denied(await B.rpc('remove_member', { p_workspace_id: ws, p_user_id: userA.id }), 'B removing the owner', ['42501']);
  });

  await rec.check('roles: B cannot write workspace_members or workspace_invitations directly', async () => {
    expect.denied(
      await B.from('workspace_members').update({ role: 'owner' }).eq('workspace_id', ws).eq('user_id', userB.id),
      'updating its own membership row',
      ['42501'],
    );
    expect.denied(
      await B.from('workspace_members').insert({ workspace_id: ws, user_id: userC.id, role: 'member' }),
      'inserting a membership for C',
      ['42501'],
    );
    expect.denied(
      await B.from('workspace_members').delete().eq('workspace_id', ws).eq('user_id', userA.id),
      'deleting the owner\'s membership',
      ['42501'],
    );
    expect.denied(
      await B.from('workspace_invitations').insert({
        workspace_id: ws,
        email: userC.email,
        role: 'admin',
        token_hash: '0'.repeat(64),
      }),
      'inserting an invitation',
      ['42501'],
    );
  });

  await rec.check('roles: C cannot add itself to A\'s workspace', async () => {
    expect.denied(
      await C.from('workspace_members').insert({ workspace_id: ws, user_id: userC.id, role: 'owner' }),
      'C inserting its own membership',
      ['42501'],
    );
  });

  await rec.check('roles: B cannot rename the workspace or change time-entry visibility', async () => {
    const rename = await B.from('workspaces').update({ name: 'renamed by a member' }).eq('id', ws).select('id');
    expect.noRows(rename, 'a member renaming the workspace');
    expect.denied(
      await B.from('workspaces').update({ time_entry_visibility: 'admins' }).eq('id', ws),
      'updating time_entry_visibility directly',
      ['42501'],
    );
    expect.denied(
      await B.rpc('set_time_entry_visibility', { p_workspace_id: ws, p_visibility: 'admins' }),
      'a member calling set_time_entry_visibility',
      ['42501'],
    );
  });

  await rec.check('roles: the owner cannot remove the last owner (itself)', async () => {
    expect.denied(await A.rpc('remove_member', { p_workspace_id: ws, p_user_id: userA.id }), 'removing the last owner', ['42501']);
  });

  await rec.check('roles: membership and settings are unchanged after the attempts', async () => {
    const r = await A.from('workspace_members').select('user_id, role, status').eq('workspace_id', ws);
    const rows = rowsOf({ data: expect.ok(r, 'reading the roster') });
    const byUser = new Map(rows.map((m) => [m.user_id, m]));
    expect.that(rows.length === 2, `expected 2 members, found ${rows.length}`);
    expect.that(byUser.get(userA.id)?.role === 'owner' && byUser.get(userA.id)?.status === 'active', 'A is no longer an active owner');
    expect.that(byUser.get(userB.id)?.role === 'member' && byUser.get(userB.id)?.status === 'active', 'B is not an active member');
    expect.that(!byUser.has(userC.id), 'C appears in the roster');
    const w = await A.from('workspaces').select('name, time_entry_visibility').eq('id', ws).single();
    const workspace = /** @type {{ name: string, time_entry_visibility: string }} */ (expect.ok(w, 'reading the workspace'));
    expect.that(workspace.name === `SP Verify ${runId} A`, 'the workspace was renamed');
    expect.that(workspace.time_entry_visibility === 'private', 'time-entry visibility changed');
  });

  // -- Sync -----------------------------------------------------------------------------------------
  const deviceA = newDeviceId();
  const deviceB = newDeviceId();
  const base = Date.now() - 6 * 60 * MINUTE;
  const batch = [
    buildEntry({ deviceId: deviceA, startMs: base, durationMs: 25 * MINUTE }),
    buildEntry({ deviceId: deviceA, startMs: base + 25 * MINUTE, durationMs: 5 * MINUTE, kind: 'idle' }),
    buildEntry({ deviceId: deviceA, startMs: base + 30 * MINUTE, durationMs: 12 * MINUTE + 345, applicationId: 'photoshop', applicationName: 'Photoshop' }),
  ];

  await rec.check(
    'sync: A uploads three entries and every one is synced',
    async () => {
      const r = await sync(A, ws, batch);
      expectResults(expect.ok(r, 'sync_time_entries'), batch, 'synced', null);
      const count = await visibleEntryCount(A, ws);
      expect.that(count === 3, `expected 3 stored entries, found ${count}`);
    },
    { required: true },
  );

  await rec.check('sync: retrying the same batch returns synced / already present, no duplicates', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const r = await sync(A, ws, batch);
      expectResults(expect.ok(r, 'retrying sync_time_entries'), batch, 'synced', 'already present');
    }
    const count = await visibleEntryCount(A, ws);
    expect.that(count === 3, `expected 3 stored entries after two retries, found ${count}`);
  });

  const valid4 = buildEntry({ deviceId: deviceA, startMs: base + 60 * MINUTE, durationMs: 7 * MINUTE });
  await rec.check('sync: invalid entries are rejected individually and valid siblings still sync', async () => {
    const template = buildEntry({ deviceId: deviceA, startMs: base + 70 * MINUTE, durationMs: 3 * MINUTE });
    const invalid = INVALID_ENTRY_VARIANTS.map((variant) => ({ ...variant.apply({ ...template, id: uuidv7() }) }));
    const entries = [valid4, ...invalid];
    const r = await sync(A, ws, entries);
    const results = /** @type {{ entry_id: string | null, status: string, detail: string | null }[]} */ (
      expect.ok(r, 'sync_time_entries with invalid entries')
    );
    expect.that(results.length === entries.length, `expected ${entries.length} results, got ${results.length}`);
    expect.that(results[0]?.status === 'synced' && results[0]?.entry_id === valid4.id, 'the valid entry was not synced');
    INVALID_ENTRY_VARIANTS.forEach((variant, i) => {
      const result = results[i + 1];
      expect.that(result?.status === 'rejected', `"${variant.name}" was not rejected`);
      const state = detailSqlstate(result?.detail);
      expect.that(state === variant.sqlstate, `"${variant.name}" was rejected with ${state ?? 'no code'}, expected ${variant.sqlstate}`);
    });
    const count = await visibleEntryCount(A, ws);
    expect.that(count === 4, `expected 4 stored entries, found ${count}`);
  });

  await rec.check('sync: stored entries keep the measured values exactly (UTC instants, split, source)', async () => {
    const all = [...batch, valid4];
    const r = await A.from('time_entries')
      .select('id, user_id, device_id, application_id, kind, started_at, ended_at, active_ms, idle_ms, end_reason, source, local_revision, recorded_at')
      .in('id', all.map((e) => e.id));
    const rows = rowsOf({ data: expect.ok(r, 'reading back entries') });
    expect.that(rows.length === all.length, `expected ${all.length} rows, got ${rows.length}`);
    for (const entry of all) {
      const row = rows.find((x) => x.id === entry.id);
      expect.that(row, 'an uploaded entry is missing');
      const ok =
        row?.user_id === userA.id &&
        row.device_id === entry.deviceId &&
        row.application_id === entry.applicationId &&
        row.kind === entry.kind &&
        Date.parse(String(row.started_at)) === Date.parse(entry.startedAt) &&
        Date.parse(String(row.ended_at)) === Date.parse(entry.endedAt) &&
        Number(row.active_ms) === entry.activeMs &&
        Number(row.idle_ms) === entry.idleMs &&
        row.end_reason === entry.endReason &&
        row.source === 'automatic' &&
        row.local_revision === 1 &&
        Date.parse(String(row.recorded_at)) === Date.parse(/** @type {string} */ (entry.recordedAt));
      expect.that(ok, 'a stored entry differs from what was uploaded');
    }
  });

  await rec.check('sync: a batch over 500 entries is refused as a whole', async () => {
    const big = Array.from({ length: 501 }, (_, i) =>
      buildEntry({ deviceId: deviceA, startMs: base + 120 * MINUTE + i * 2000, durationMs: 1000 }),
    );
    expect.denied(await sync(A, ws, big), 'syncing 501 entries', ['54000']);
    const count = await visibleEntryCount(A, ws);
    expect.that(count === 4, `the refused batch changed the stored entries (${count})`);
  });

  await rec.check('sync: an id that belongs to another user is rejected, not overwritten', async () => {
    const first = /** @type {(typeof batch)[number]} */ (batch[0]);
    const stolen = { ...buildEntry({ deviceId: deviceB, startMs: base, durationMs: 60_000, applicationId: 'blender', applicationName: 'Blender' }), id: first.id };
    const r = await sync(B, ws, [stolen]);
    expectResults(expect.ok(r, 'sync_time_entries'), [stolen], 'rejected');
    const row = await A.from('time_entries').select('user_id, application_id').eq('id', first.id).single();
    const stored = /** @type {{ user_id: string, application_id: string }} */ (expect.ok(row, 'reading the original entry'));
    expect.that(stored.user_id === userA.id && stored.application_id === first.applicationId, 'the original entry was changed');
  });

  await rec.check('sync: references to another workspace\'s project or task are rejected', async () => {
    const inOwn = buildEntry({ deviceId: deviceA, startMs: base + 200 * MINUTE, durationMs: MINUTE, projectId: own.projectId, taskId: own.taskId });
    const foreignProject = buildEntry({ deviceId: deviceA, startMs: base + 202 * MINUTE, durationMs: MINUTE, projectId: wsC.projectId });
    const foreignTask = buildEntry({ deviceId: deviceA, startMs: base + 204 * MINUTE, durationMs: MINUTE, taskId: wsC.taskId });
    const r = await sync(A, ws, [inOwn, foreignProject, foreignTask]);
    const results = /** @type {{ status: string, detail: string | null }[]} */ (expect.ok(r, 'sync_time_entries'));
    expect.that(results[0]?.status === 'synced', 'an entry attributed to the own workspace\'s project/task was not synced');
    expect.that(results[1]?.status === 'rejected' && detailSqlstate(results[1]?.detail) === '23503', 'a foreign project id was accepted');
    expect.that(results[2]?.status === 'rejected' && detailSqlstate(results[2]?.detail) === '23503', 'a foreign task id was accepted');
    expect.denied(
      await A.from('tasks').insert({ workspace_id: ws, project_id: wsC.projectId, title: 'cross-workspace' }),
      'a task referencing another workspace\'s project',
      ['23503'],
    );
    expect.denied(await sync(A, wsC.workspaceId, [buildEntry({ deviceId: deviceA, startMs: base + 210 * MINUTE, durationMs: MINUTE })]), 'syncing into a workspace A is not a member of', ['42501']);
  });

  await rec.check('sync: direct writes cannot impersonate another user or change synced entries', async () => {
    const e = buildEntry({ deviceId: deviceB, startMs: base + 220 * MINUTE, durationMs: MINUTE });
    expect.denied(
      await B.from('time_entries').insert({
        id: e.id,
        workspace_id: ws,
        user_id: userA.id,
        device_id: e.deviceId,
        application_id: e.applicationId,
        application_name: e.applicationName,
        kind: 'active',
        started_at: e.startedAt,
        ended_at: e.endedAt,
        active_ms: e.activeMs,
        idle_ms: 0,
        end_reason: e.endReason,
        recorded_at: /** @type {string} */ (e.recordedAt),
      }),
      'inserting an entry as another user',
      ['42501'],
    );
    const first = /** @type {(typeof batch)[number]} */ (batch[0]);
    expect.denied(await A.from('time_entries').update({ active_ms: 1 }).eq('id', first.id), 'updating a synced entry', ['42501']);
  });

  // -- Isolation (C is outside A's workspace) ---------------------------------------------------
  await rec.check('isolation: C cannot read anything in A\'s workspace', async () => {
    expect.noRows(await C.from('workspaces').select('id').eq('id', ws), 'C reading the workspace');
    for (const table of ['workspace_members', 'projects', 'tasks', 'notes', 'time_entries']) {
      expect.noRows(await C.from(table).select('workspace_id').eq('workspace_id', ws), `C reading ${table}`);
    }
    expect.noRows(await C.from('workspace_invitations').select('id').eq('workspace_id', ws), 'C reading invitations');
    expect.noRows(await C.from('profiles').select('id').eq('id', userA.id), 'C reading A\'s profile');
    const mine = rowsOf({ data: expect.ok(await C.rpc('my_workspaces'), 'my_workspaces') });
    expect.that(!mine.some((w) => w.workspace_id === ws), 'my_workspaces lists A\'s workspace for C');
  });

  await rec.check('isolation: C cannot write into A\'s workspace', async () => {
    expect.denied(await C.from('projects').insert({ workspace_id: ws, name: 'intruder' }), 'C inserting a project', ['42501']);
    expect.denied(await C.from('tasks').insert({ workspace_id: ws, title: 'intruder' }), 'C inserting a task', ['42501']);
    expect.denied(await C.from('notes').insert({ workspace_id: ws, title: 'intruder' }), 'C inserting a note', ['42501']);
    expect.denied(await sync(C, ws, [buildEntry({ deviceId: newDeviceId(), startMs: base, durationMs: MINUTE })]), 'C syncing into the workspace', [
      '42501',
    ]);
  });

  // -- Privacy -------------------------------------------------------------------------------------
  const entryB = buildEntry({ deviceId: deviceB, startMs: base + 300 * MINUTE, durationMs: 9 * MINUTE, applicationId: 'blender', applicationName: 'Blender' });
  await rec.check('privacy: time entries are private by default (members and the owner see only their own)', async () => {
    expectResults(expect.ok(await sync(B, ws, [entryB]), 'B syncing'), [entryB], 'synced', null);
    const seenByB = rowsOf({ data: expect.ok(await B.from('time_entries').select('id, user_id').eq('workspace_id', ws), 'B reading entries') });
    expect.that(seenByB.length === 1 && seenByB[0]?.id === entryB.id, `B sees ${seenByB.length} entries instead of only its own`);
    expect.noRows(await A.from('time_entries').select('id').eq('id', entryB.id), 'the owner reading B\'s entry');
    expect.noRows(await C.from('time_entries').select('id').eq('id', entryB.id), 'C reading B\'s entry');
    expect.noRows(await B.from('profiles').select('id').eq('id', userC.id), 'B reading C\'s profile');
    const teammates = rowsOf({ data: expect.ok(await B.from('profiles').select('id').eq('id', userA.id), 'B reading A\'s profile') });
    expect.that(teammates.length === 1, 'teammates cannot see each other\'s profile');
  });

  await rec.check('privacy: only the owner can let admins read members\' entries, and can turn it off again', async () => {
    expect.ok(await A.rpc('set_time_entry_visibility', { p_workspace_id: ws, p_visibility: 'admins' }), 'set_time_entry_visibility');
    const visible = rowsOf({ data: expect.ok(await A.from('time_entries').select('id').eq('id', entryB.id), 'owner reading B\'s entry') });
    expect.that(visible.length === 1, 'with visibility "admins" the owner still cannot read B\'s entry');
    const first = /** @type {(typeof batch)[number]} */ (batch[0]);
    expect.noRows(await B.from('time_entries').select('id').eq('id', first.id), 'a member reading the owner\'s entry');
    expect.ok(await A.rpc('set_time_entry_visibility', { p_workspace_id: ws, p_visibility: 'private' }), 'set_time_entry_visibility');
    expect.noRows(await A.from('time_entries').select('id').eq('id', entryB.id), 'the owner reading B\'s entry after switching back');
  });

  await rec.check('privacy: private notes stay private, workspace notes are shared, only the owner edits', async () => {
    const seenByB = rowsOf({ data: expect.ok(await B.from('notes').select('id').eq('workspace_id', ws), 'B reading notes') });
    const ids = new Set(seenByB.map((n) => n.id));
    expect.that(ids.has(own.sharedNoteId), 'B cannot read the workspace note');
    expect.that(!ids.has(own.privateNoteId), 'B can read A\'s private note');
    expect.noRows(await B.from('notes').update({ title: 'edited by B' }).eq('id', own.sharedNoteId).select('id'), 'B editing A\'s note');
    expect.noRows(await B.from('notes').delete().eq('id', own.sharedNoteId).select('id'), 'B deleting A\'s note');
    const nb = await B.from('notes').insert({ workspace_id: ws, title: 'B private', visibility: 'private' }).select('id').single();
    const noteB = /** @type {{ id: string }} */ (expect.ok(nb, 'B inserting a private note'));
    expect.noRows(await A.from('notes').select('id').eq('id', noteB.id), 'the owner reading B\'s private note');
    const edited = await A.from('notes').update({ title: 'Shared (edited)' }).eq('id', own.sharedNoteId).select('version').single();
    const version = /** @type {{ version: number }} */ (expect.ok(edited, 'the owner editing its note')).version;
    expect.that(version === 2, `an edit did not bump the note version (got ${version})`);
  });

  // -- Anonymous access ---------------------------------------------------------------------------
  await rec.check('anon: the publishable key without a session cannot read any table', async () => {
    for (const table of TABLES) {
      expect.denied(await anon.from(table).select('*').limit(1), `anonymous read of ${table}`, ['42501']);
    }
  });

  await rec.check('anon: the publishable key without a session cannot call the RPCs', async () => {
    expect.denied(await anon.rpc('my_workspaces'), 'anonymous my_workspaces', ['42501', 'PGRST202']);
    expect.denied(await anon.rpc('create_workspace', { p_name: 'anon' }), 'anonymous create_workspace', ['42501', 'PGRST202']);
    expect.denied(await anon.rpc('accept_invitation', { p_token: '0'.repeat(64) }), 'anonymous accept_invitation', ['42501', 'PGRST202']);
    expect.denied(await sync(anon, ws, []), 'anonymous sync_time_entries', ['42501', 'PGRST202']);
  });

  // -- Removal ----------------------------------------------------------------------------------------
  await rec.check('removal: the owner removes B, and B loses access to the workspace', async () => {
    expect.ok(await A.rpc('remove_member', { p_workspace_id: ws, p_user_id: userB.id }), 'remove_member');
    const mine = rowsOf({ data: expect.ok(await B.rpc('my_workspaces'), 'my_workspaces') });
    expect.that(!mine.some((w) => w.workspace_id === ws), 'my_workspaces still lists the workspace for B');
    expect.noRows(await B.from('projects').select('id').eq('workspace_id', ws), 'B reading projects after removal');
    expect.noRows(await B.from('notes').select('id').eq('id', own.sharedNoteId), 'B reading the workspace note after removal');
    expect.noRows(await B.from('profiles').select('id').eq('id', userA.id), 'B reading A\'s profile after removal');
  });

  await rec.check('removal: a removed member cannot sync into the workspace but keeps its own history', async () => {
    const late = buildEntry({ deviceId: deviceB, startMs: base + 320 * MINUTE, durationMs: MINUTE });
    expect.denied(await sync(B, ws, [late]), 'a removed member syncing', ['42501']);
    const ownRows = rowsOf({ data: expect.ok(await B.from('time_entries').select('id').eq('id', entryB.id), 'B reading its own entry') });
    expect.that(ownRows.length === 1, 'B can no longer read its own entry');
  });
}

// ---------------------------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------------------------

/** @typedef {{ userIds: Set<string>, workspaceIds: Set<string> }} CleanupState */

/**
 * Delete what this run created: workspaces first (cascading to projects, tasks, notes, entries,
 * memberships, invitations), then the users (cascading to profiles). Also sweeps workspaces
 * created by the run's users and users with the run's email prefix, in case a response was lost
 * after the server had acted.
 * @param {Client} admin
 * @param {CleanupState} state
 * @param {string} runId
 * @returns {Promise<{ workspaces: number, users: number, problems: string[] }>}
 */
async function cleanup(admin, state, runId) {
  /** @type {string[]} */
  const problems = [];
  let workspaces = 0;
  let users = 0;

  const prefix = `sp-verify-${runId}-`;
  try {
    const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listed.error) problems.push(`listing users: ${describeSupabaseError(listed.error)}`);
    for (const u of listed.data?.users ?? []) {
      if (typeof u.email === 'string' && u.email.startsWith(prefix)) state.userIds.add(u.id);
    }
  } catch (error) {
    problems.push(`listing users: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    if (state.workspaceIds.size > 0) {
      const r = await admin.from('workspaces').delete().in('id', [...state.workspaceIds]).select('id');
      if (r.error) problems.push(`deleting workspaces: ${describeSupabaseError(r.error)}`);
      else workspaces += r.data.length;
    }
    if (state.userIds.size > 0) {
      const r = await admin.from('workspaces').delete().in('created_by', [...state.userIds]).select('id');
      if (r.error) problems.push(`deleting workspaces by creator: ${describeSupabaseError(r.error)}`);
      else workspaces += r.data.length;
    }
  } catch (error) {
    problems.push(`deleting workspaces: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const id of state.userIds) {
    try {
      const r = await admin.auth.admin.deleteUser(id);
      if (r.error) problems.push(`deleting a user: ${describeSupabaseError(r.error)}`);
      else users += 1;
    } catch (error) {
      problems.push(`deleting a user: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { workspaces, users, problems };
}

// ---------------------------------------------------------------------------------------------
// Live-test user
// ---------------------------------------------------------------------------------------------

/**
 * Delete the live-test user recorded in supabase/.live-test.local (and its workspaces), then the
 * file. Only addresses created by --keep-user are ever deleted.
 * @param {Client} admin
 * @returns {Promise<boolean>} true when there was nothing to do or it succeeded
 */
async function deleteLiveUser(admin) {
  if (!existsSync(LIVE_TEST_FILE)) {
    say('No live-test user recorded (supabase/.live-test.local does not exist).');
    return true;
  }
  const recorded = parseLiveTestFile(readFileSync(LIVE_TEST_FILE, 'utf8'));
  if (!recorded) {
    warn('supabase/.live-test.local is incomplete; delete the user in the dashboard and remove the file by hand.');
    return false;
  }
  secrets.add(recorded.password);
  if (!LIVE_TEST_EMAIL_PATTERN.test(recorded.email)) {
    warn('supabase/.live-test.local names an address not created by --keep-user; refusing to delete it.');
    return false;
  }
  const lookup = await admin.auth.admin.getUserById(recorded.userId);
  if (lookup.error && lookup.error.status !== 404) {
    warn(`Looking up the live-test user failed (${describeSupabaseError(lookup.error)}).`);
    return false;
  }
  if (lookup.data?.user) {
    if (lookup.data.user.email !== recorded.email) {
      warn('The recorded live-test user id belongs to a different address; refusing to delete it.');
      return false;
    }
    const ws = await admin.from('workspaces').delete().eq('created_by', recorded.userId).select('id');
    if (ws.error) {
      warn(`Deleting the live-test workspaces failed (${describeSupabaseError(ws.error)}).`);
      return false;
    }
    const del = await admin.auth.admin.deleteUser(recorded.userId);
    if (del.error) {
      warn(`Deleting the live-test user failed (${describeSupabaseError(del.error)}).`);
      return false;
    }
  }
  rmSync(LIVE_TEST_FILE, { force: true });
  say(`Deleted live-test user ${recorded.email} and removed supabase/.live-test.local.`);
  return true;
}

/**
 * Create the dedicated live-test user (confirmed, with its own workspace created through its own
 * session) and write supabase/.live-test.local. Prints only the email and the workspace id.
 * @param {Client} admin
 * @param {string} url
 * @param {string} publishableKey
 * @param {string} runId
 * @returns {Promise<boolean>}
 */
async function keepLiveUser(admin, url, publishableKey, runId) {
  const ignored = isGitIgnored(LIVE_TEST_FILE);
  if (ignored !== true) {
    warn(
      ignored === false
        ? 'supabase/.live-test.local is not gitignored; refusing to write a password there.'
        : 'Cannot confirm with git that supabase/.live-test.local is ignored; refusing to write a password there.',
    );
    return false;
  }
  if (!(await deleteLiveUser(admin))) return false;

  /** @type {string | null} */
  let createdId = null;
  try {
    const user = await createConfirmedUser(admin, liveTestEmail(runId), 'Studio Pulse live test', (id) => {
      createdId = id;
    });
    const client = await signIn(url, publishableKey, user, `sp-live-${runId}`);
    const r = await client.rpc('create_workspace', { p_name: 'Studio Pulse live test' });
    const row = single(expect.ok(r, 'create_workspace'));
    const workspaceId = /** @type {string} */ (row?.id);
    expect.that(typeof workspaceId === 'string', 'create_workspace returned no id');
    const text = formatLiveTestFile({
      email: user.email,
      password: user.password,
      userId: user.id,
      workspaceId,
      url,
      publishableKey,
    });
    writeFileSync(LIVE_TEST_FILE, text, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(LIVE_TEST_FILE, 0o600);
    } catch {
      // Windows: POSIX modes are not applicable; the file lives in the user's checkout.
    }
    say(`Live-test user: ${user.email}`);
    say(`Live-test workspace: ${workspaceId}`);
    say(`Credentials written to ${relative(REPO_ROOT, LIVE_TEST_FILE).replaceAll('\\', '/')} (gitignored).`);
    return true;
  } catch (error) {
    warn(`Creating the live-test user failed: ${error instanceof Error ? error.message : String(error)}`);
    if (createdId) {
      await admin.from('workspaces').delete().eq('created_by', createdId);
      await admin.auth.admin.deleteUser(createdId);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  /** @type {ReturnType<typeof parseArgs>} */
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const env = loadEnvFile({ path: options.envFile, required: REQUIRED_KEYS });
  if (env.missing.length > 0) {
    console.error(`${describeMissing(env)}\nRefusing to run: the verification needs the project URL, the publishable key and the secret key.`);
    return 2;
  }
  const secretKey = /** @type {string} */ (env.values.SUPABASE_SECRET_KEY);
  const publishableKey = /** @type {string} */ (env.values.SUPABASE_PUBLISHABLE_KEY);
  secrets.add(secretKey);
  secrets.add(publishableKey);
  if (env.values.SUPABASE_DB_URL) secrets.add(env.values.SUPABASE_DB_URL);

  /** @type {string} */
  let url;
  try {
    url = normaliseProjectUrl(/** @type {string} */ (env.values.SUPABASE_URL));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const publishableKind = classifyKey(publishableKey);
  if (publishableKind === 'secret') {
    console.error('SUPABASE_PUBLISHABLE_KEY holds a secret (service-role) key. Put the publishable key there.');
    return 2;
  }
  if (publishableKind !== 'publishable') {
    console.error('SUPABASE_PUBLISHABLE_KEY is not a publishable key (expected sb_publishable_… or the legacy anon key).');
    return 2;
  }
  if (classifyKey(secretKey) !== 'secret') {
    console.error('SUPABASE_SECRET_KEY is not a secret key (expected sb_secret_… or the legacy service_role key).');
    return 2;
  }

  const admin = makeClient(url, secretKey, 'sp-verify-admin');

  if (options.deleteLiveUser) return (await deleteLiveUser(admin)) ? 0 : 1;

  const runId = newRunId();
  /** @type {CleanupState} */
  const state = { userIds: new Set(), workspaceIds: new Set() };
  const rec = new CheckRecorder({ out: (line) => console.log(line), secrets: secretList });

  say(`Studio Pulse Supabase verification, run ${runId}, project ${new URL(url).host}`);
  say('');

  /** @type {Promise<Awaited<ReturnType<typeof cleanup>>> | null} */
  let cleaning = null;
  const cleanupOnce = () => {
    cleaning ??= cleanup(admin, state, runId);
    return cleaning;
  };
  const onSignal = () => {
    warn('\nInterrupted: cleaning up what this run created…');
    cleanupOnce().then(
      (c) => {
        warn(`Cleanup: deleted ${c.workspaces} workspace(s) and ${c.users} user(s).${c.problems.length ? ` Problems: ${c.problems.join('; ')}` : ''}`);
        process.exit(130);
      },
      () => process.exit(130),
    );
  };
  process.once('SIGINT', onSignal);

  let aborted = null;
  try {
    /** @type {Provision} */
    const provision = (email, displayName) => createConfirmedUser(admin, email, displayName);
    await runChecks(rec, { url, publishableKey, provision, runId, state });
  } catch (error) {
    aborted = error instanceof AbortRun ? error.message : `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    const c = await cleanupOnce();
    process.removeListener('SIGINT', onSignal);
    say('');
    if (aborted) say(`Stopped early: ${aborted}; the remaining checks were not run.`);
    say(rec.summary());
    say(`Cleanup: deleted ${c.workspaces} workspace(s) and ${c.users} user(s) created by run ${runId}.`);
    if (c.problems.length > 0) {
      warn(`CLEANUP INCOMPLETE: ${c.problems.join('; ')}`);
      warn(`Delete users whose email starts with sp-verify-${runId}- in the dashboard (Authentication › Users).`);
      rec.results.push({ name: 'cleanup', ok: false, reason: 'incomplete' });
    }
  }

  const success = rec.failed === 0 && !aborted;
  if (options.keepUser) {
    if (!success) say('Not creating the live-test user because the verification did not pass.');
    else if (!(await keepLiveUser(admin, url, publishableKey, runId))) return 1;
  }
  return success ? 0 : 1;
}

// Run only as a script, not when another module imports `runChecks`.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
