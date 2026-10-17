/**
 * Shared fixtures for the Supabase RLS/RPC suites: assertion helpers, a two-workspace "world"
 * built only through the client-reachable RPCs, and time-entry payloads shaped exactly like the
 * desktop's `RemoteTimeEntry` (apps/desktop/src-tauri/src/cloud/api.rs, camelCase keys).
 */

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, expect, vi } from 'vitest';

import { SupabaseTestDb } from './harness';
import type { Outcome, Row, SqlError, TestUser, Who } from './harness';

// ---------------------------------------------------------------------------------------------
// Per-file database
// ---------------------------------------------------------------------------------------------

/**
 * One fresh database per test file (each test then creates its own users and workspaces, so
 * tests never observe each other's rows). Returns a getter because the database only exists
 * once `beforeAll` has run.
 */
export function useDatabase(): () => SupabaseTestDb {
  // PGlite boots a WASM Postgres (a few seconds, more while other files boot in parallel).
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
  let db: SupabaseTestDb | undefined;
  beforeAll(async () => {
    db = await SupabaseTestDb.create();
  });
  afterAll(async () => {
    await db?.close();
  });
  return () => {
    if (db === undefined) throw new Error('database not ready');
    return db;
  };
}

// ---------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------

function describeError(error: SqlError): string {
  return `${error.code}: ${error.message}${error.detail ? ` (${error.detail})` : ''}`;
}

/** The value of a successful outcome; fails the test with the SQL error otherwise. */
export function ok<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) {
    expect.fail(`expected success, got ${describeError(outcome.error)}`);
  }
  return outcome.value;
}

/** Asserts the outcome failed with `code` (and a message matching `message`, when given). */
export function fails(outcome: Outcome<unknown>, code: string, message?: RegExp): SqlError {
  if (outcome.ok) {
    expect.fail(`expected SQLSTATE ${code}, got success: ${JSON.stringify(outcome.value)}`);
  }
  expect(outcome.error.code, describeError(outcome.error)).toBe(code);
  if (message !== undefined) expect(outcome.error.message).toMatch(message);
  return outcome.error;
}

/** `42501` raised by the privilege system (no GRANT for the table, column or function). */
export const PERMISSION_DENIED = /permission denied for (table|function|schema)/;
/** `42501` raised by a WITH CHECK clause of a row-level security policy. */
export const RLS_VIOLATION = /violates row-level security policy/;

export function first<T>(rows: readonly T[]): T {
  expect(rows.length, 'expected at least one row').toBeGreaterThan(0);
  return rows[0] as T;
}

export function only<T>(rows: readonly T[]): T {
  expect(rows).toHaveLength(1);
  return rows[0] as T;
}

/** The ids of the rows `who` can see in `table` (optionally filtered by `where`). */
export async function visibleIds(
  db: SupabaseTestDb,
  who: Who,
  table: string,
  where = 'true',
  params: readonly unknown[] = [],
): Promise<string[]> {
  const rows = ok(
    await db.query<{ id: string }>(who, `select id from public.${table} where ${where}`, params),
  );
  return rows.map((row) => row.id).sort();
}

// ---------------------------------------------------------------------------------------------
// Users, workspaces, invitations (only through the RPCs a client can call)
// ---------------------------------------------------------------------------------------------

let sequence = 0;

/** A unique, obviously fake address (RFC 2606 `.test`). */
export function uniqueEmail(name: string): string {
  sequence += 1;
  return `${name}.${sequence}.${randomBytes(3).toString('hex')}@example.test`;
}

export async function newUser(db: SupabaseTestDb, name: string): Promise<TestUser> {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return db.createUser(uniqueEmail(name), { displayName, label: name });
}

export type Role = 'owner' | 'admin' | 'member';

export async function createWorkspace(
  db: SupabaseTestDb,
  owner: TestUser,
  name = 'Studio',
): Promise<string> {
  const rows = ok(
    await db.query<{ id: string }>(owner, `select id from public.create_workspace($1)`, [name]),
  );
  return only(rows).id;
}

export interface Invitation {
  invitationId: string;
  token: string;
  expiresAt: Date;
}

export async function invite(
  db: SupabaseTestDb,
  inviter: TestUser,
  workspaceId: string,
  email: string,
  role: Role = 'member',
): Promise<Outcome<Invitation>> {
  const outcome = await db.query<{ invitation_id: string; token: string; expires_at: Date }>(
    inviter,
    `select invitation_id, token, expires_at
       from public.create_invitation($1, $2, $3::public.workspace_role)`,
    [workspaceId, email, role],
  );
  if (!outcome.ok) return outcome;
  const row = only(outcome.value);
  return {
    ok: true,
    value: { invitationId: row.invitation_id, token: row.token, expiresAt: row.expires_at },
  };
}

export async function accept(
  db: SupabaseTestDb,
  user: TestUser,
  token: string | null,
): Promise<Outcome<string>> {
  const outcome = await db.query<{ ws: string }>(
    user,
    `select public.accept_invitation($1) as ws`,
    [token],
  );
  if (!outcome.ok) return outcome;
  return { ok: true, value: only(outcome.value).ws };
}

/** Invites `user` with `role` and accepts the invitation as them. */
export async function addMember(
  db: SupabaseTestDb,
  inviter: TestUser,
  workspaceId: string,
  user: TestUser,
  role: Exclude<Role, 'owner'>,
): Promise<void> {
  if (user.email === null) throw new Error('addMember needs a user with an email');
  const invitation = ok(await invite(db, inviter, workspaceId, user.email, role));
  expect(ok(await accept(db, user, invitation.token))).toBe(workspaceId);
}

export function setMemberRole(
  db: SupabaseTestDb,
  caller: TestUser,
  workspaceId: string,
  target: TestUser,
  role: Role,
): Promise<Outcome<Row[]>> {
  return db.query(caller, `select public.set_member_role($1, $2, $3::public.workspace_role)`, [
    workspaceId,
    target.id,
    role,
  ]);
}

export function removeMember(
  db: SupabaseTestDb,
  caller: TestUser,
  workspaceId: string,
  target: TestUser,
): Promise<Outcome<Row[]>> {
  return db.query(caller, `select public.remove_member($1, $2)`, [workspaceId, target.id]);
}

export function revokeInvitation(
  db: SupabaseTestDb,
  caller: TestUser,
  invitationId: string,
): Promise<Outcome<Row[]>> {
  return db.query(caller, `select public.revoke_invitation($1)`, [invitationId]);
}

/** Sorted ids of `users`, to compare with `visibleIds`. */
export function userIds(...users: TestUser[]): string[] {
  return users.map((user) => user.id).sort();
}

export function setVisibility(
  db: SupabaseTestDb,
  caller: TestUser,
  workspaceId: string,
  visibility: 'private' | 'admins',
): Promise<Outcome<Row[]>> {
  return db.query(
    caller,
    `select public.set_time_entry_visibility($1, $2::public.time_entry_visibility)`,
    [workspaceId, visibility],
  );
}

/** The membership row as stored (inspected as superuser). */
export async function membership(
  db: SupabaseTestDb,
  workspaceId: string,
  user: TestUser,
): Promise<{ role: Role; status: 'active' | 'removed' } | undefined> {
  const rows = await db.admin<{ role: Role; status: 'active' | 'removed' }>(
    `select role::text as role, status::text as status
       from public.workspace_members where workspace_id = $1 and user_id = $2`,
    [workspaceId, user.id],
  );
  return rows[0];
}

/**
 * Two workspaces built only through client RPCs:
 * - A: alice (owner), bob (admin), carol, dave and gina (members)
 * - B: erin (owner), gina (admin), frank (member)
 * - mallory belongs to no workspace.
 * gina is an admin in B but only a member in A: her B role must never leak into A.
 */
export interface World {
  alice: TestUser;
  bob: TestUser;
  carol: TestUser;
  dave: TestUser;
  gina: TestUser;
  erin: TestUser;
  frank: TestUser;
  mallory: TestUser;
  wsA: string;
  wsB: string;
}

const WORLD_USERS = ['alice', 'bob', 'carol', 'dave', 'gina', 'erin', 'frank', 'mallory'] as const;

export async function buildWorld(db: SupabaseTestDb): Promise<World> {
  const users = {} as Record<(typeof WORLD_USERS)[number], TestUser>;
  for (const name of WORLD_USERS) users[name] = await newUser(db, name);
  const wsA = await createWorkspace(db, users.alice, 'Studio A');
  const wsB = await createWorkspace(db, users.erin, 'Studio B');
  await addMember(db, users.alice, wsA, users.bob, 'admin');
  await addMember(db, users.alice, wsA, users.carol, 'member');
  await addMember(db, users.alice, wsA, users.dave, 'member');
  await addMember(db, users.alice, wsA, users.gina, 'member');
  await addMember(db, users.erin, wsB, users.gina, 'admin');
  await addMember(db, users.erin, wsB, users.frank, 'member');
  return { ...users, wsA, wsB };
}

// ---------------------------------------------------------------------------------------------
// Projects, tasks, notes
// ---------------------------------------------------------------------------------------------

export async function createProject(
  db: SupabaseTestDb,
  who: TestUser,
  workspaceId: string,
  name = 'Project',
): Promise<string> {
  const rows = ok(
    await db.query<{ id: string }>(
      who,
      `insert into public.projects (workspace_id, name) values ($1, $2) returning id`,
      [workspaceId, name],
    ),
  );
  return only(rows).id;
}

export async function createTask(
  db: SupabaseTestDb,
  who: TestUser,
  workspaceId: string,
  fields: { title?: string; assigneeId?: string | null; projectId?: string | null; status?: string } = {},
): Promise<string> {
  const rows = ok(
    await db.query<{ id: string }>(
      who,
      `insert into public.tasks (workspace_id, title, assignee_id, project_id, status)
       values ($1, $2, $3, $4, coalesce($5, 'inbox')::public.task_status) returning id`,
      [
        workspaceId,
        fields.title ?? 'Task',
        fields.assigneeId ?? null,
        fields.projectId ?? null,
        fields.status ?? null,
      ],
    ),
  );
  return only(rows).id;
}

export async function createNote(
  db: SupabaseTestDb,
  who: TestUser,
  workspaceId: string,
  visibility: 'private' | 'workspace',
  body = 'note body',
): Promise<string> {
  const rows = ok(
    await db.query<{ id: string }>(
      who,
      `insert into public.notes (workspace_id, title, body, visibility)
       values ($1, 'Title', $2, $3::public.note_visibility) returning id`,
      [workspaceId, body, visibility],
    ),
  );
  return only(rows).id;
}

// ---------------------------------------------------------------------------------------------
// Time entries (sync payload)
// ---------------------------------------------------------------------------------------------

/** A UUIDv7 like the desktop's interval ids (48-bit ms timestamp, version 7, RFC 4122 variant). */
export function uuidv7(ms: number = Date.now()): string {
  const bytes = randomBytes(16);
  let time = ms;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Serialized shape of `RemoteTimeEntry` (apps/desktop/src-tauri/src/cloud/api.rs). */
export interface EntryPayload {
  id: string;
  deviceId: string;
  applicationId: string;
  applicationName: string;
  kind: string;
  startedAt: string;
  endedAt: string;
  activeMs: number;
  idleMs: number;
  endReason: string;
  projectId: string | null;
  taskId: string | null;
  revision: number;
  recordedAt: string;
}

export const DEVICE_ID = '7d0f4c62-3a51-4c41-9a8e-0c7f1d2b9e10';
const BASE_MS = Date.parse('2026-10-16T08:00:00.000Z');
let entrySequence = 0;

/**
 * A valid closed interval: 5 minutes of active Figma time, each call 10 minutes after the
 * previous one. `overrides` may add or replace any key (including unknown ones).
 */
export function entry(overrides: Partial<EntryPayload> & Record<string, unknown> = {}): EntryPayload {
  entrySequence += 1;
  const start = BASE_MS + entrySequence * 10 * 60_000;
  return {
    id: uuidv7(start),
    deviceId: DEVICE_ID,
    applicationId: 'figma',
    applicationName: 'Figma',
    kind: 'active',
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 5 * 60_000).toISOString(),
    activeMs: 5 * 60_000,
    idleMs: 0,
    endReason: 'appSwitch',
    projectId: null,
    taskId: null,
    revision: 3,
    recordedAt: new Date(start + 1_000).toISOString(),
    ...overrides,
  };
}

export interface SyncResult {
  entry_id: string | null;
  status: 'synced' | 'rejected';
  detail: string | null;
}

/** Calls the RPC exactly as PostgREST does for `POST /rpc/sync_time_entries`. */
export function sync(
  db: SupabaseTestDb,
  who: Who,
  workspaceId: string | null,
  entries: unknown,
): Promise<Outcome<SyncResult[]>> {
  return db.query<SyncResult & Row>(
    who,
    `select entry_id, status, detail from public.sync_time_entries($1::uuid, $2::jsonb)`,
    [workspaceId, entries === undefined ? null : JSON.stringify(entries)],
  );
}

/** Ids of the entries `who` successfully synced (fails the test on a whole-call error). */
export async function syncOk(
  db: SupabaseTestDb,
  who: TestUser,
  workspaceId: string,
  entries: readonly EntryPayload[],
): Promise<string[]> {
  const results = ok(await sync(db, who, workspaceId, entries));
  expect(results.map((result) => result.status)).toEqual(entries.map(() => 'synced'));
  return entries.map((payload) => payload.id);
}

/**
 * A direct `INSERT INTO time_entries` (not the RPC) with the columns a client may write.
 * `columns` adds or replaces snake_case columns (e.g. `user_id`, `source`).
 */
export function insertEntryDirect(
  db: SupabaseTestDb,
  who: Who,
  workspaceId: string,
  columns: Record<string, unknown> = {},
): Promise<Outcome<number>> {
  const payload = entry();
  const row: Record<string, unknown> = {
    id: payload.id,
    workspace_id: workspaceId,
    device_id: payload.deviceId,
    application_id: payload.applicationId,
    application_name: payload.applicationName,
    kind: payload.kind,
    started_at: payload.startedAt,
    ended_at: payload.endedAt,
    active_ms: payload.activeMs,
    idle_ms: payload.idleMs,
    end_reason: payload.endReason,
    local_revision: payload.revision,
    recorded_at: payload.recordedAt,
    ...columns,
  };
  const names = Object.keys(row);
  return db.affected(
    who,
    `insert into public.time_entries (${names.join(', ')})
     values (${names.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(row),
  );
}

/** Rows stored for these ids, as superuser (bypassing RLS) for exact inspection. */
export async function storedEntries(db: SupabaseTestDb, ids: readonly string[]): Promise<Row[]> {
  return db.admin(
    `select id, workspace_id, user_id, device_id, application_id, application_name, kind,
            started_at, ended_at, active_ms::text as active_ms, idle_ms::text as idle_ms,
            end_reason, source, project_id, task_id, local_revision, recorded_at
       from public.time_entries where id = any($1::uuid[]) order by started_at, id`,
    [[...ids]],
  );
}
