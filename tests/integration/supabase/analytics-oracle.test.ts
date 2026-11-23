/**
 * Oracle cross-check (docs/analytics.md): `public.analytics_time_summary` against the time-engine's
 * `summarizeReport`, row for row and in order. Any difference is a bug in one of them.
 *
 * - Data: two workspaces seeded through the client paths (`sync`, plus `insertEntryDirect` for
 *   microsecond timestamps). A holds 2026 around the DST changes of the zones below; B holds 2021
 *   (Amman and Gaza repeat midnight on 29 October) and one member's entries on 2020-01-01. Several
 *   people and devices; random overlaps, active and idle rows, rows crossing midnight and lasting
 *   days; identical, contained, contiguous and zero-length rows; rows starting or ending exactly
 *   at a local midnight. Time on projects, on tasks, on a task later moved out of its project (no
 *   project) or into another one, and on nothing. Projects and tasks archived after their time was
 *   recorded; a member removed after syncing. A seeded PRNG makes every run identical.
 * - Calls: owner, admin and member (and gina, an admin in B but a member in A) under 'private' and
 *   then 'admins', each in every zone over seven ranges (three days around each DST change, the
 *   DST days alone, both together, and twice with no first day: p_from null) by day, week and
 *   month. The project, unattributed and application filters (every combination) and the user list
 *   (none, self, a teammate, both, a removed member, empty, everyone) turn from call to call, so
 *   that each caller under each visibility has every filter with every bucket and with no first
 *   day, and every user list; 'covers what it claims to cover' checks that. Then the limits and the
 *   refused arguments.
 * - Oracle input: chosen by rules written here, never by reading through RLS: the caller's own
 *   rows of the workspace, or all of the workspace's rows for an owner or admin under 'admins'.
 * - Host time zones: the oracle runs under the process's own zone, then again under UTC, Los
 *   Angeles and Kiritimati, switched in process (Node re-reads process.env.TZ) with the engine
 *   re-imported each time. A sample of the calls also runs in a database session whose TimeZone is
 *   not UTC: the function must not depend on it either.
 * - Zones: UTC, America/New_York, America/Havana, America/Santiago, Atlantic/Azores,
 *   Europe/London, Australia/Lord_Howe, Asia/Kathmandu, Asia/Amman, Asia/Gaza (and Etc/GMT+3 once).
 *   Zones whose tzdata differs between PGlite (PostgreSQL 18.6) and Node's ICU are left out, for
 *   example America/Edmonton from November 2026 and Africa/Casablanca from September 2026; the
 *   first test checks that the zones used here agree.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as processEngine from '@studio-pulse/time-engine';
import type { ReportBucket, ReportInterval, ReportRow } from '@studio-pulse/time-engine';

import {
  addMember,
  buildWorld,
  createProject,
  createTask,
  entry,
  insertEntryDirect,
  newUser,
  ok,
  removeMember,
  setVisibility,
  syncOk,
  useDatabase,
} from './fixtures';
import type { EntryPayload, World } from './fixtures';
import type { Outcome, Row, TestUser } from './harness';

type Engine = typeof processEngine;

const db = useDatabase();

const SEED = 20261112;
const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------------------------
// Seeded randomness and calendar arithmetic (independent of the code under test)
// ---------------------------------------------------------------------------------------------

/** Small, fast, seedable PRNG (mulberry32). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function int(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

/** A lowercase UUIDv7 (time prefix, then seeded bits), like the desktop's interval ids. */
function seededUuid(random: () => number, ms: number): string {
  const hex = (digits: number) => Array.from({ length: digits }, () => Math.floor(random() * 16).toString(16)).join('');
  const time = Math.floor(ms).toString(16).padStart(12, '0');
  const variant = (8 + Math.floor(random() * 4)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/** Calendar arithmetic on `YYYY-MM-DD`. */
function shiftDay(day: string, amount: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (date ?? 1) + amount)).toISOString().slice(0, 10);
}

const at = (iso: string) => Date.parse(iso);

/** ISO instant with `micros` extra microseconds after the millisecond. */
function isoAt(ms: number, micros = 0): string {
  const iso = new Date(ms).toISOString();
  return micros === 0 ? iso : `${iso.slice(0, 23)}${String(micros).padStart(3, '0')}Z`;
}

// ---------------------------------------------------------------------------------------------
// Seeding plan
// ---------------------------------------------------------------------------------------------

const APPLICATIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['figma', ['Figma', 'Figma Desktop', 'Figma Beta']],
  ['blender', ['Blender', 'Blender 4.2']],
  ['photoshop', ['Photoshop', 'Adobe Photoshop 2026']],
  ['after-effects', ['After Effects']],
  ['cinema-4d', ['Cinema 4D']],
];

interface Attribution {
  projectId: string | null;
  /** A task decides the project (the attribution trigger copies it), so it is sent alone. */
  taskId: string | null;
}

const NONE: Attribution = { projectId: null, taskId: null };

interface Planned {
  user: TestUser;
  workspaceId: string;
  id: string;
  deviceId: string;
  applicationId: string;
  applicationName: string;
  kind: 'active' | 'idle';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  attribution: Attribution;
  /** Microsecond timestamps go in by a direct insert; everything else through the sync RPC. */
  direct: boolean;
}

interface Person {
  user: TestUser;
  devices: readonly [string, string];
}

interface RowOptions {
  kind?: 'active' | 'idle';
  device?: 0 | 1;
  application?: number;
  attribution?: Attribution;
  /** Extra microseconds on the start and the end. */
  micros?: readonly [number, number];
}

class Planner {
  readonly rows: Planned[] = [];

  constructor(
    private readonly random: () => number,
    private readonly workspaceId: string,
    private readonly attributions: readonly Attribution[],
  ) {}

  add(person: Person, startMs: number, endMs: number, options: RowOptions = {}): void {
    const random = this.random;
    const [applicationId, names] = APPLICATIONS[options.application ?? int(random, 0, APPLICATIONS.length - 1)] ?? APPLICATIONS[0]!;
    const kind = options.kind ?? (random() < 0.7 ? 'active' : 'idle');
    const [startMicros, endMicros] = options.micros ?? [0, 0];
    this.rows.push({
      user: person.user,
      workspaceId: this.workspaceId,
      id: seededUuid(random, startMs),
      deviceId: (options.device ?? int(random, 0, 1)) === 0 ? person.devices[0] : person.devices[1],
      applicationId,
      applicationName: pick(random, names),
      kind,
      startedAt: isoAt(startMs, startMicros),
      endedAt: isoAt(endMs, endMicros),
      durationMs: Math.round(((endMs - startMs) * 1000 + endMicros - startMicros) / 1000),
      attribution: options.attribution ?? pick(random, this.attributions),
      direct: options.micros !== undefined,
    });
  }

  /** Random rows within 36 hours of `centerIso`, plus one of each overlap shape. */
  cluster(person: Person, centerIso: string, count: number): void {
    const random = this.random;
    const center = at(centerIso);
    for (let index = 0; index < count; index += 1) {
      const raw = center + (random() * 2 - 1) * 36 * HOUR;
      const grain = random();
      const start = grain < 0.5 ? Math.floor(raw / MINUTE) * MINUTE : grain < 0.8 ? Math.floor(raw / SECOND) * SECOND : Math.floor(raw);
      const shape = random();
      const length =
        shape < 0.45
          ? int(random, 1, 30) * MINUTE + int(random, 0, 59) * SECOND
          : shape < 0.7
            ? int(random, 30, 180) * MINUTE
            : shape < 0.85
              ? int(random, 180, 1800) * MINUTE // 3 to 30 hours: usually across midnight
              : shape < 0.9
                ? int(random, 30, 80) * HOUR
                : shape < 0.95
                  ? int(random, 0, 999) // under a second, sometimes zero
                  : int(random, 1, 120) * MINUTE + int(random, 0, 999);
      // About one row in twelve has microseconds (the CHECK accepts them; reports truncate).
      const micros = random() < 0.08 ? ([int(random, 0, 999), int(random, 0, 999)] as const) : undefined;
      if (micros && length === 0 && micros[1] < micros[0]) continue;
      this.add(person, start, start + length, micros ? { micros } : {});
    }

    const base = Math.floor((center + (random() * 2 - 1) * 24 * HOUR) / (5 * MINUTE)) * 5 * MINUTE;
    const t = (minutes: number) => base + minutes * MINUTE;
    // Identical rows (only the id breaks the tie) and rows with the same start.
    this.add(person, t(0), t(40), { kind: 'active', device: 0 });
    this.add(person, t(0), t(40), { kind: 'active', device: 1 });
    this.add(person, t(120), t(150), { kind: 'idle', device: 0 });
    this.add(person, t(120), t(180), { kind: 'idle', device: 1 });
    // Contained rows: idle under active, active inside idle.
    this.add(person, t(240), t(360), { kind: 'active', device: 0 });
    this.add(person, t(270), t(300), { kind: 'idle', device: 1 });
    this.add(person, t(210), t(420), { kind: 'idle', device: 1 });
    // Contiguous rows.
    this.add(person, t(480), t(500), { kind: 'active', device: 0 });
    this.add(person, t(500), t(540), { kind: 'active', device: 0 });
    // Zero-length rows: exactly, and only after truncation to milliseconds (0.8 ms long).
    this.add(person, t(550), t(550), { kind: 'active', device: 1 });
    this.add(person, t(555), t(555), { kind: 'idle', device: 1, micros: [100, 900] });
    // Several active pieces inside one idle row.
    this.add(person, t(600), t(720), { kind: 'idle', device: 0 });
    this.add(person, t(615), t(630), { kind: 'active', device: 1 });
    this.add(person, t(660), t(670), { kind: 'active', device: 1 });
  }

  /** Rows ending at, starting at and straddling an instant (a local midnight somewhere). */
  boundary(person: Person, instantIso: string): void {
    const x = at(instantIso);
    this.add(person, x - 30 * MINUTE, x, { kind: 'active', device: 0 });
    this.add(person, x, x + 20 * MINUTE, { kind: 'idle', device: 0 });
    this.add(person, x - 10 * MINUTE, x + 10 * MINUTE, { kind: 'active', device: 1 });
  }
}

/** Every local midnight of the DST days used below (UTC instants), plus the transitions. */
const BOUNDARIES_2026 = [
  '2026-03-08T05:00:00Z', // New York and Havana: 8 March (Havana skips midnight)
  '2026-03-08T07:00:00Z', // New York: clocks go forward
  '2026-03-09T04:00:00Z',
  '2026-03-29T00:00:00Z', // London 29 March
  '2026-03-29T01:00:00Z', // Azores 29 March (skips midnight); London clocks go forward
  '2026-04-04T13:00:00Z', // Lord Howe 5 April (24.5 h)
  '2026-04-04T18:15:00Z', // Kathmandu 5 April
  '2026-04-05T03:00:00Z', // Santiago: clocks go back at 24:00
  '2026-04-05T04:00:00Z', // Santiago 5 April
  '2026-04-05T13:30:00Z', // Lord Howe 6 April
  '2026-09-06T04:00:00Z', // Santiago 6 September (skips midnight)
  '2026-10-03T13:30:00Z', // Lord Howe 4 October (23.5 h)
  '2026-10-24T23:00:00Z', // London 25 October
  '2026-10-25T00:00:00Z', // Azores 25 October (repeats midnight: the earlier one)
  '2026-10-25T01:00:00Z', // Azores: the repeated midnight
  '2026-11-01T04:00:00Z', // New York 1 November; Havana's first midnight
  '2026-11-01T05:00:00Z', // Havana's repeated midnight
  '2026-11-02T05:00:00Z',
];

const BOUNDARIES_2021 = [
  '2021-03-25T22:00:00Z', // Amman 26 March (skips midnight); Gaza 26 March
  '2021-03-26T22:00:00Z', // Gaza 27 March (skips midnight); Amman 27 March
  '2021-10-28T21:00:00Z', // Amman and Gaza 29 October: the first midnight
  '2021-10-28T22:00:00Z', // the repeated midnight
  '2021-10-29T22:00:00Z',
];

const CLUSTERS_2026 = [
  '2026-03-08T06:00:00Z',
  '2026-03-29T01:00:00Z',
  '2026-04-05T00:00:00Z',
  '2026-09-06T04:00:00Z',
  '2026-10-04T00:00:00Z',
  '2026-10-25T01:00:00Z',
  '2026-11-01T05:00:00Z',
];

const CLUSTERS_2021 = ['2021-03-26T12:00:00Z', '2021-10-29T00:00:00Z'];

/** Zones of each workspace, with the days whose start or length a DST change moves. */
const ZONES_2026: ReadonlyArray<readonly [string, string, string]> = [
  ['UTC', '2026-03-08', '2026-10-25'],
  ['America/New_York', '2026-03-08', '2026-11-01'],
  ['America/Havana', '2026-03-08', '2026-11-01'],
  ['America/Santiago', '2026-04-05', '2026-09-06'],
  ['Atlantic/Azores', '2026-03-29', '2026-10-25'],
  ['Europe/London', '2026-03-29', '2026-10-25'],
  ['Australia/Lord_Howe', '2026-04-05', '2026-10-04'],
  ['Asia/Kathmandu', '2026-04-05', '2026-09-06'],
];

const ZONES_2021: ReadonlyArray<readonly [string, string, string]> = [
  ['Asia/Amman', '2021-03-26', '2021-10-29'],
  ['Asia/Gaza', '2021-03-27', '2021-10-29'],
  ['UTC', '2021-03-26', '2021-10-29'],
  ['America/New_York', '2021-03-26', '2021-10-29'],
];

// ---------------------------------------------------------------------------------------------
// Calling the RPC and the oracle
// ---------------------------------------------------------------------------------------------

interface Args {
  to: string;
  timeZone: string;
  from?: string | null;
  bucket?: string;
  userIds?: string[] | null;
  projectId?: string | null;
  unattributed?: boolean;
  applicationId?: string | null;
}

const OPTIONAL_ARGS: ReadonlyArray<readonly [keyof Args, string, string]> = [
  ['from', 'p_from', 'date'],
  ['bucket', 'p_bucket', 'text'],
  ['userIds', 'p_user_ids', 'uuid[]'],
  ['projectId', 'p_project_id', 'uuid'],
  ['unattributed', 'p_unattributed', 'boolean'],
  ['applicationId', 'p_application_id', 'text'],
];

interface RpcRow extends Row {
  dimension: ReportRow['dimension'];
  bucket_start: string | null;
  user_id: string | null;
  application_id: string | null;
  application_name: string | null;
  project_id: string | null;
  task_id: string | null;
  unattributed: boolean | null;
  active_ms: string;
  idle_ms: string;
  entry_count: number;
  overlap_ms: string;
  teammates_visible: boolean | null;
}

/** The same fields in the same order, so rows from either side compare and print alike. */
function canonical(row: ReportRow): ReportRow {
  return {
    dimension: row.dimension,
    bucketStart: row.bucketStart,
    userId: row.userId,
    applicationId: row.applicationId,
    applicationName: row.applicationName,
    projectId: row.projectId,
    taskId: row.taskId,
    unattributed: row.unattributed,
    activeMs: row.activeMs,
    idleMs: row.idleMs,
    entryCount: row.entryCount,
    overlapMs: row.overlapMs,
    teammatesVisible: row.teammatesVisible,
  };
}

/** Calls the RPC as PostgREST does (named arguments; omitted ones take their defaults). */
async function callRpc(who: TestUser, workspaceId: string, args: Args, sessionTimeZone?: string): Promise<Outcome<ReportRow[]>> {
  const params: unknown[] = [workspaceId, args.to, args.timeZone];
  const named = ['p_workspace_id => $1::uuid', 'p_to => $2::date', 'p_time_zone => $3::text'];
  for (const [key, name, type] of OPTIONAL_ARGS) {
    if (!(key in args)) continue;
    params.push(args[key]);
    named.push(`${name} => $${params.length}::${type}`);
  }
  const sql = `select dimension, bucket_start::text as bucket_start, user_id::text as user_id, application_id,
                      application_name, project_id::text as project_id, task_id::text as task_id, unattributed,
                      active_ms::text as active_ms, idle_ms::text as idle_ms, entry_count,
                      overlap_ms::text as overlap_ms, teammates_visible
                 from public.analytics_time_summary(${named.join(', ')})`;
  const outcome = await db().as(who, async (session) => {
    if (sessionTimeZone !== undefined) await session.query(`select set_config('TimeZone', $1, true)`, [sessionTimeZone]);
    return session.query<RpcRow>(sql, params);
  });
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    value: outcome.value.map((row) =>
      canonical({
        dimension: row.dimension,
        bucketStart: row.bucket_start,
        userId: row.user_id,
        applicationId: row.application_id,
        applicationName: row.application_name,
        projectId: row.project_id,
        taskId: row.task_id,
        unattributed: row.unattributed,
        activeMs: Number(row.active_ms),
        idleMs: Number(row.idle_ms),
        entryCount: row.entry_count,
        overlapMs: Number(row.overlap_ms),
        teammatesVisible: row.teammates_visible,
      }),
    ),
  };
}

type OracleOutcome = { ok: true; rows: ReportRow[] } | { ok: false; message: string };

function runOracle(engine: Engine, input: readonly ReportInterval[], args: Args, teammatesVisible: boolean): OracleOutcome {
  try {
    const rows = engine.summarizeReport(input, {
      fromDay: args.from ?? null,
      toDay: args.to,
      timeZone: args.timeZone,
      bucket: (args.bucket ?? 'day') as ReportBucket,
      userIds: args.userIds ?? null,
      projectId: args.projectId ?? null,
      unattributed: args.unattributed ?? false,
      applicationId: args.applicationId ?? null,
      teammatesVisible,
    });
    return { ok: true, rows: rows.map(canonical) };
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, message: error.message };
    throw error;
  }
}

const show = (row: ReportRow | undefined) => (row === undefined ? '(none)' : JSON.stringify(row));

/** Null when both sides agree; otherwise what differs. */
function difference(rpc: Outcome<ReportRow[]>, oracle: OracleOutcome): string | null {
  if (rpc.ok && oracle.ok) {
    const length = Math.max(rpc.value.length, oracle.rows.length);
    for (let index = 0; index < length; index += 1) {
      const a = rpc.value[index];
      const b = oracle.rows[index];
      if (show(a) !== show(b)) {
        return `row ${index} of ${rpc.value.length} (rpc) / ${oracle.rows.length} (oracle): rpc ${show(a)} oracle ${show(b)}`;
      }
    }
    return null;
  }
  if (!rpc.ok && !oracle.ok) {
    if (rpc.error.code !== '22023') return `rpc refused with ${rpc.error.code}: ${rpc.error.message}`;
    const rpcZone = rpc.error.message.includes('time zone');
    const oracleZone = oracle.message.includes('time zone');
    return rpcZone === oracleZone ? null : `refusal reasons differ: rpc "${rpc.error.message}", oracle "${oracle.message}"`;
  }
  return rpc.ok
    ? `rpc answered (${rpc.value.length} rows) but the oracle refused: ${oracle.ok ? '' : oracle.message}`
    : `rpc refused (${rpc.error.code}: ${rpc.error.message}) but the oracle answered (${oracle.ok ? oracle.rows.length : 0} rows)`;
}

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------

type Visibility = 'private' | 'admins';
type Role = 'owner' | 'admin' | 'member';

interface Caller {
  name: string;
  user: TestUser;
  role: Role;
  /** Someone else in the workspace, for user lists. */
  teammate: TestUser;
}

interface Workspace {
  name: string;
  id: string;
  callers: Caller[];
  removed: TestUser;
  everyone: TestUser[];
  zones: ReadonlyArray<readonly [string, string, string]>;
  filters: ReadonlyArray<{ label: string; args: Partial<Args> }>;
  /** Calls made so far (it advances across phases). */
  counter: number;
  /** Blocks of calls (visibility × caller × zone) made so far: it turns the filters and user lists. */
  block: number;
}

interface Case {
  label: string;
  workspaceId: string;
  caller: TestUser;
  callerName: string;
  role: Role;
  phase: Visibility;
  teammatesVisible: boolean;
  args: Args;
  bucket: string;
  /** Index into the workspace's filters; -1 for the hand-picked edge cases. */
  filter: number;
  /** Index into RANGES; -1 for the hand-picked edge cases. */
  range: number;
  scope: string;
  rpc: Outcome<ReportRow[]>;
  session?: { timeZone: string; rpc: Outcome<ReportRow[]> };
}

const BUCKETS = ['day', 'week', 'month'] as const;
/** The ranges of every caller in every zone, around the zone's two DST days. */
const RANGES = ['3 days (first)', '3 days (second)', 'first', 'second', 'both', 'to first', 'to second'] as const;
/** The last two have no first day (p_from null: from the first row in scope). */
const NO_FIRST_DAY = RANGES.length - 2;
const SCOPES = ['all', 'self', 'teammate', 'self+teammate', 'removed', 'empty', 'everyone'] as const;
const SESSION_TIME_ZONES = ['America/Los_Angeles', 'Asia/Kathmandu', 'Pacific/Kiritimati', 'Australia/Lord_Howe'];

function userList(scope: (typeof SCOPES)[number], caller: Caller, workspace: Workspace): Partial<Args> {
  switch (scope) {
    case 'all':
      return {};
    case 'self':
      return { userIds: [caller.user.id] };
    case 'teammate':
      return { userIds: [caller.teammate.id] };
    case 'self+teammate':
      return { userIds: [caller.teammate.id, caller.user.id] };
    case 'removed':
      return { userIds: [workspace.removed.id] };
    case 'empty':
      return { userIds: [] };
    case 'everyone':
      return { userIds: workspace.everyone.map((user) => user.id) };
  }
}

/**
 * The oracle's input, by the access rules (never by reading through RLS): an owner or admin
 * under 'admins' reads every row of the workspace (removed members' too); everyone else reads
 * their own rows only.
 */
function readableBy(
  intervals: readonly (ReportInterval & { workspaceId: string })[],
  workspaceId: string,
  caller: TestUser,
  teammatesVisible: boolean,
): ReportInterval[] {
  return intervals.filter(
    (interval) => interval.workspaceId === workspaceId && (teammatesVisible || interval.userId === caller.id),
  );
}

// ---------------------------------------------------------------------------------------------
// The world, the seeded rows and every call
// ---------------------------------------------------------------------------------------------

let world: World;
let stored: Array<ReportInterval & { workspaceId: string }> = [];
const cases: Case[] = [];
const projects: Record<string, string> = {};
const tasks: Record<string, string> = {};

async function seed(planner: Planner): Promise<void> {
  const synced = new Map<TestUser, EntryPayload[]>();
  for (const row of planner.rows) {
    if (row.direct) {
      const outcome = await insertEntryDirect(db(), row.user, row.workspaceId, {
        id: row.id,
        device_id: row.deviceId,
        application_id: row.applicationId,
        application_name: row.applicationName,
        kind: row.kind,
        started_at: row.startedAt,
        ended_at: row.endedAt,
        active_ms: row.kind === 'active' ? row.durationMs : 0,
        idle_ms: row.kind === 'idle' ? row.durationMs : 0,
        project_id: row.attribution.projectId,
        task_id: row.attribution.taskId,
        recorded_at: row.endedAt,
      });
      expect(ok(outcome)).toBe(1);
      continue;
    }
    const batch = synced.get(row.user) ?? [];
    batch.push(
      entry({
        id: row.id,
        deviceId: row.deviceId,
        applicationId: row.applicationId,
        applicationName: row.applicationName,
        kind: row.kind,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        activeMs: row.kind === 'active' ? row.durationMs : 0,
        idleMs: row.kind === 'idle' ? row.durationMs : 0,
        projectId: row.attribution.projectId,
        taskId: row.attribution.taskId,
        recordedAt: row.endedAt,
      }),
    );
    synced.set(row.user, batch);
  }
  const workspaceId = planner.rows[0]?.workspaceId ?? '';
  for (const [user, batch] of synced) {
    for (let index = 0; index < batch.length; index += 500) {
      await syncOk(db(), user, workspaceId, batch.slice(index, index + 500));
    }
  }
}

async function runCase(
  workspace: Workspace,
  caller: Caller,
  phase: Visibility,
  args: Args,
  meta: { bucket: string; filter: number; filterLabel: string; range: number; scope: string },
  sessionTimeZone?: string,
): Promise<void> {
  const teammatesVisible = phase === 'admins' && (caller.role === 'owner' || caller.role === 'admin');
  const range = `${'from' in args ? (args.from ?? 'null') : '(none)'}..${args.to}`;
  const label = `${phase} ${caller.name} (${caller.role}) ${workspace.name} ${args.timeZone} ${range} ${meta.bucket} ${meta.filterLabel} users=${meta.scope}`;
  const rpc = await callRpc(caller.user, workspace.id, args);
  const item: Case = {
    label,
    workspaceId: workspace.id,
    caller: caller.user,
    callerName: caller.name,
    role: caller.role,
    phase,
    teammatesVisible,
    args,
    bucket: meta.bucket,
    filter: meta.filter,
    range: meta.range,
    scope: meta.scope,
    rpc,
  };
  if (sessionTimeZone !== undefined) {
    item.session = { timeZone: sessionTimeZone, rpc: await callRpc(caller.user, workspace.id, args, sessionTimeZone) };
  }
  cases.push(item);
}

/**
 * Every caller × zone × range × bucket, with the filter and the user list turning on two counters:
 * the call's place `j` in its block of 21 (range × bucket) and the block's number `n` (visibility ×
 * caller × zone). A plain running counter would not do: 21 calls a block against 14 filters pairs
 * each range with only six of them (no first day would never meet "no filter"). With
 * `filter = (j + 5n) mod 14` and `list = (2j + n + 3⌊n/14⌋) mod 7`, a block has every filter, and
 * every user list with every bucket; a caller under one visibility has every filter with every
 * bucket and with no first day; and a workspace has every filter with every range × bucket and
 * every user list. (The ⌊n/14⌋ term gives a range × bucket × filter, which recurs every 14 blocks,
 * a different user list each time.) 'covers what it claims to cover' checks all of that, so a
 * change here cannot quietly lose it.
 */
async function runPhase(workspace: Workspace, phase: Visibility): Promise<void> {
  for (const caller of workspace.callers) {
    for (const [timeZone, first, second] of workspace.zones) {
      const ranges: Array<Pick<Args, 'from' | 'to'>> = [
        { from: shiftDay(first, -1), to: shiftDay(first, 1) },
        { from: shiftDay(second, -1), to: shiftDay(second, 1) },
        { from: first, to: first },
        { from: second, to: second },
        { from: shiftDay(first, -3), to: shiftDay(second, 2) },
        // No first day: from the first row in scope.
        { to: shiftDay(first, 1) },
        { to: shiftDay(second, 1) },
      ];
      if (ranges.length !== RANGES.length) throw new Error('RANGES names every range');
      const filters = workspace.filters.length;
      const n = workspace.block;
      workspace.block += 1;
      let j = 0;
      for (const [rangeIndex, range] of ranges.entries()) {
        for (const bucket of BUCKETS) {
          const k = workspace.counter;
          workspace.counter += 1;
          const filter = (j + 5 * n) % filters;
          const scope = SCOPES[(2 * j + n + 3 * Math.floor(n / filters)) % SCOPES.length] ?? 'all';
          j += 1;
          const { label: filterLabel, args: filterArgs } = workspace.filters[filter] ?? { label: '?', args: {} };
          const args: Args = { ...range, timeZone, ...filterArgs, ...userList(scope, caller, workspace) };
          if (!('from' in range) && k % 2 === 1) args.from = null; // explicit null as well as omitted
          if (bucket !== 'day' || k % 2 === 0) args.bucket = bucket; // 'day' is also the default
          const sessionTimeZone = k % 11 === 0 ? SESSION_TIME_ZONES[(k / 11) % SESSION_TIME_ZONES.length] : undefined;
          await runCase(workspace, caller, phase, args, { bucket, filter, filterLabel, range: rangeIndex, scope }, sessionTimeZone);
        }
      }
    }
  }
}

/** Hand-picked arguments: limits, refusals, and the first day resolving before 2020. */
async function runEdges(a: Workspace, b: Workspace, phase: Visibility): Promise<void> {
  const [alice] = a.callers;
  const [erin, , frank] = b.callers;
  if (!alice || !erin || !frank) throw new Error('callers missing');
  const p1 = projects.P1 ?? '';
  const q1 = projects.Q1 ?? '';
  const ivan = b.removed;
  const ids = (count: number) =>
    Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  const edges: Array<[Workspace, Caller, Args]> = [
    // frank's first entries are at 2020-01-01 00:00Z and 02:00Z: 31 December 2019 in New York.
    [b, frank, { to: '2020-01-02', timeZone: 'America/New_York' }],
    [b, frank, { to: '2020-01-01', timeZone: 'America/New_York', bucket: 'week' }],
    [b, frank, { to: '2020-01-01', timeZone: 'America/New_York', bucket: 'month', from: null }],
    [b, frank, { to: '2020-01-01', timeZone: 'Asia/Kathmandu' }],
    [b, erin, { to: '2020-01-02', timeZone: 'America/New_York', userIds: [frank.user.id] }],
    // The resolved first day makes the span too long, unless a filter leaves out 2020.
    [b, frank, { to: '2021-10-31', timeZone: 'UTC' }],
    [b, frank, { to: '2021-10-31', timeZone: 'UTC', applicationId: 'figma' }],
    [b, erin, { to: '2021-10-31', timeZone: 'Asia/Amman', bucket: 'month' }],
    // ivan (removed from B) has a zero-length photoshop row on 1 January 2020 and, the next day, an
    // idle Poster row lying wholly under an active row. Neither holds any time in any report, but
    // with no first day each is the first row in scope. Under 'admins' erin reads them, and the
    // span is then too long (photoshop: 452 days; Poster by day: 451, though not by week; and 367
    // but not 366 days to the end of 2020). Under 'private' she cannot, and the report is empty.
    [b, erin, { to: '2021-03-27', timeZone: 'UTC', applicationId: 'photoshop', userIds: [ivan.id, erin.user.id] }],
    [b, erin, { to: '2021-03-27', timeZone: 'UTC', projectId: q1, userIds: [ivan.id] }],
    [b, erin, { to: '2021-03-27', timeZone: 'UTC', projectId: q1, userIds: [ivan.id], bucket: 'week' }],
    [b, erin, { to: '2020-12-31', timeZone: 'UTC', applicationId: 'photoshop', userIds: [ivan.id] }],
    [b, erin, { to: '2021-01-01', timeZone: 'UTC', applicationId: 'photoshop', userIds: [ivan.id], from: null }],
    // A last day before 2020 with no first day.
    [a, alice, { to: '2019-12-31', timeZone: 'UTC' }],
    [a, alice, { to: '2019-12-31', timeZone: 'America/New_York', from: null }],
    // Refused arguments.
    [a, alice, { to: '2026-10-26', timeZone: 'UTC', from: '2026-10-24', bucket: 'year' }],
    [a, alice, { to: '2026-10-26', timeZone: 'UTC+3', from: '2026-10-24' }],
    [a, alice, { to: '2026-10-26', timeZone: 'CET', from: '2026-10-24' }],
    [a, alice, { to: '2026-10-26', timeZone: 'EST', from: '2026-10-24' }],
    [a, alice, { to: '2026-10-26', timeZone: 'Not/AZone', from: '2026-10-24' }],
    [a, alice, { to: '2026-10-25', timeZone: 'UTC', from: '2026-10-26' }],
    [a, alice, { to: '2020-01-02', timeZone: 'UTC', from: '2019-12-31' }],
    [a, alice, { to: '2100-01-01', timeZone: 'UTC', from: '2099-12-31' }],
    [a, alice, { to: '2026-10-26', timeZone: 'UTC', from: shiftDay('2026-10-26', -366), bucket: 'month' }],
    [a, alice, { to: '2026-10-26', timeZone: 'UTC', userIds: [...ids(500), alice.user.id] }],
    [a, alice, { to: '2026-10-26', timeZone: 'UTC', projectId: p1, unattributed: true }],
    [a, alice, { to: '2026-11-02', timeZone: 'UTC', from: shiftDay('2026-11-02', -1100), bucket: 'week', projectId: p1 }],
    [a, alice, { to: '2030-12-31', timeZone: 'UTC', from: shiftDay('2030-12-31', -3660), bucket: 'month', projectId: p1 }],
    [a, alice, { to: '2026-11-02', timeZone: 'UTC', from: shiftDay('2026-11-02', -366), bucket: 'day', projectId: p1 }],
    // Accepted at the limits.
    [a, alice, { to: '2026-10-26', timeZone: 'UTC', from: shiftDay('2026-10-26', -365), bucket: 'month' }],
    [a, alice, { to: '2026-10-26', timeZone: 'UTC', userIds: [...ids(499), alice.user.id] }],
    [a, alice, { to: '2026-10-26', timeZone: 'UTC', from: '2026-10-24', userIds: [alice.user.id, a.removed.id, alice.user.id] }],
    [a, alice, { to: '2020-01-01', timeZone: 'UTC', from: '2020-01-01' }],
    [a, alice, { to: '2099-12-31', timeZone: 'UTC', from: '2099-12-31', bucket: 'week' }],
    [a, alice, { to: '2026-11-02', timeZone: 'Asia/Kathmandu', from: shiftDay('2026-11-02', -1099), bucket: 'week', projectId: p1 }],
    [a, alice, { to: '2030-12-31', timeZone: 'America/Santiago', from: shiftDay('2030-12-31', -3659), bucket: 'month', projectId: p1 }],
    [a, alice, { to: '2026-03-09', timeZone: 'Etc/GMT+3', from: '2026-03-07' }],
  ];
  for (const [workspace, caller, args] of edges) {
    await runCase(workspace, caller, phase, args, { bucket: args.bucket ?? 'day', filter: -1, filterLabel: 'edge', range: -1, scope: 'edge' });
  }
}

beforeAll(async () => {
  world = await buildWorld(db());
  const { alice, bob, carol, dave, gina, erin, frank, wsA, wsB } = world;
  const ivan = await newUser(db(), 'ivan');
  await addMember(db(), erin, wsB, ivan, 'member');

  // Projects and tasks (B's project P1 of A is "another workspace's project").
  projects.P1 = await createProject(db(), alice, wsA, 'Brand');
  projects.P2 = await createProject(db(), alice, wsA, 'Web');
  projects.P3 = await createProject(db(), alice, wsA, 'Motion');
  tasks.T1 = await createTask(db(), alice, wsA, { title: 'Logo', projectId: projects.P1 });
  tasks.T2 = await createTask(db(), alice, wsA, { title: 'Palette', projectId: projects.P1 });
  tasks.T3 = await createTask(db(), alice, wsA, { title: 'Admin' });
  tasks.T4 = await createTask(db(), alice, wsA, { title: 'Landing', projectId: projects.P2 });
  tasks.T5 = await createTask(db(), alice, wsA, { title: 'Storyboard', projectId: projects.P3 });
  tasks.T6 = await createTask(db(), alice, wsA, { title: 'Render', projectId: projects.P3 });
  projects.Q1 = await createProject(db(), erin, wsB, 'Poster');
  projects.Q2 = await createProject(db(), erin, wsB, 'Leaflet');
  tasks.U1 = await createTask(db(), erin, wsB, { title: 'Layout', projectId: projects.Q1 });
  tasks.U2 = await createTask(db(), erin, wsB, { title: 'Copy' });
  tasks.U3 = await createTask(db(), erin, wsB, { title: 'Fold', projectId: projects.Q2 });

  const random = prng(SEED);
  const people = (users: TestUser[]): Person[] =>
    users.map((user) => ({ user, devices: [seededUuid(random, 0), seededUuid(random, 0)] as const }));

  const task = (id: string | undefined): Attribution => ({ projectId: null, taskId: id ?? null });
  const project = (id: string | undefined): Attribution => ({ projectId: id ?? null, taskId: null });
  const planA = new Planner(random, wsA, [
    NONE,
    NONE,
    NONE,
    NONE,
    project(projects.P1),
    project(projects.P2),
    project(projects.P3),
    task(tasks.T1),
    task(tasks.T2),
    task(tasks.T3),
    task(tasks.T4),
    task(tasks.T5),
    task(tasks.T6),
  ]);
  const peopleA = people([alice, bob, carol, dave, gina]);
  for (const member of peopleA) {
    for (const center of CLUSTERS_2026) planA.cluster(member, center, 14);
  }
  BOUNDARIES_2026.forEach((instant, index) => planA.boundary(peopleA[index % peopleA.length]!, instant));
  // Long rows: an idle row over three weeks (it starts before every March range) and a 10-day one.
  planA.add(peopleA[2]!, at('2026-03-01T09:00:00Z'), at('2026-03-21T09:00:00Z'), { kind: 'idle', attribution: NONE });
  planA.add(peopleA[1]!, at('2026-10-20T08:00:00Z'), at('2026-10-30T08:00:00Z'), { kind: 'idle', attribution: task(tasks.T6) });
  await seed(planA);

  const planB = new Planner(random, wsB, [
    NONE,
    NONE,
    NONE,
    project(projects.Q1),
    project(projects.Q2),
    task(tasks.U1),
    task(tasks.U2),
    task(tasks.U3),
  ]);
  const peopleB = people([erin, gina, frank, ivan]);
  for (const member of peopleB) {
    for (const center of CLUSTERS_2021) planB.cluster(member, center, 14);
  }
  BOUNDARIES_2021.forEach((instant, index) => planB.boundary(peopleB[index % peopleB.length]!, instant));
  // frank's first entries, from the first instant the table accepts: 31 December 2019 west of
  // UTC. Their application appears nowhere else.
  planB.add(peopleB[2]!, at('2020-01-01T00:00:00Z'), at('2020-01-01T00:30:00Z'), { kind: 'active', attribution: NONE });
  planB.add(peopleB[2]!, at('2020-01-01T02:00:00Z'), at('2020-01-01T02:45:00Z'), { kind: 'idle', attribution: NONE });
  for (const row of planB.rows.slice(-2)) {
    row.applicationId = 'krita';
    row.applicationName = 'Krita';
  }
  // ivan's first rows hold no time in any report: a zero-length row, and an idle Poster row lying
  // wholly under an active one. With no first day they still decide where a report starts.
  const ivanPerson = peopleB[3]!;
  planB.add(ivanPerson, at('2020-01-01T12:00:00Z'), at('2020-01-01T12:00:00Z'), { kind: 'active', device: 0, application: 2, attribution: NONE });
  planB.add(ivanPerson, at('2020-01-02T09:00:00Z'), at('2020-01-02T11:00:00Z'), { kind: 'active', device: 0, application: 4, attribution: NONE });
  planB.add(ivanPerson, at('2020-01-02T09:30:00Z'), at('2020-01-02T10:00:00Z'), { kind: 'idle', device: 1, application: 3, attribution: project(projects.Q1) });
  await seed(planB);

  // After the time is recorded: move tasks (their time follows), archive, remove members.
  ok(await db().query(alice, `update public.tasks set project_id = null where id = $1`, [tasks.T2]));
  ok(await db().query(alice, `update public.tasks set project_id = $2 where id = $1`, [tasks.T5, projects.P1]));
  ok(await db().query(alice, `update public.tasks set status = 'archived' where id = any($1::uuid[])`, [[tasks.T4, tasks.T6]]));
  ok(await db().query(alice, `update public.projects set status = 'archived' where id = $1`, [projects.P2]));
  ok(await db().query(erin, `update public.tasks set project_id = null where id = $1`, [tasks.U3]));
  ok(await db().query(erin, `update public.tasks set status = 'archived' where id = $1`, [tasks.U1]));
  ok(await db().query(erin, `update public.projects set status = 'archived' where id = $1`, [projects.Q2]));
  ok(await removeMember(db(), alice, wsA, dave));
  ok(await removeMember(db(), erin, wsB, ivan));

  // Every stored row, as superuser (inspection only; the access rules are applied in readableBy).
  const rows = await db().admin<{
    id: string;
    workspace_id: string;
    user_id: string;
    device_id: string;
    application_id: string;
    application_name: string;
    kind: 'active' | 'idle';
    start_ms: string;
    end_ms: string;
    project_id: string | null;
    task_id: string | null;
  }>(
    `select id::text, workspace_id::text, user_id::text, device_id::text, application_id, application_name, kind,
            (extract(epoch from started_at) * 1000)::text as start_ms,
            (extract(epoch from ended_at) * 1000)::text as end_ms,
            project_id::text, task_id::text
       from public.time_entries where workspace_id = any($1::uuid[]) order by id`,
    [[wsA, wsB]],
  );
  expect(rows).toHaveLength(planA.rows.length + planB.rows.length);
  stored = rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    deviceId: row.device_id,
    applicationId: row.application_id,
    applicationName: row.application_name,
    kind: row.kind,
    // Fractional milliseconds (microsecond timestamps) are passed as they are: the oracle truncates.
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    projectId: row.project_id,
    taskId: row.task_id,
  }));

  const callersA: Caller[] = [
    { name: 'alice', user: alice, role: 'owner', teammate: carol },
    { name: 'bob', user: bob, role: 'admin', teammate: alice },
    { name: 'carol', user: carol, role: 'member', teammate: bob },
    { name: 'gina', user: gina, role: 'member', teammate: carol },
  ];
  const callersB: Caller[] = [
    { name: 'erin', user: erin, role: 'owner', teammate: frank },
    { name: 'gina', user: gina, role: 'admin', teammate: erin },
    { name: 'frank', user: frank, role: 'member', teammate: gina },
  ];
  const a: Workspace = {
    name: 'A',
    id: wsA,
    callers: callersA,
    removed: dave,
    everyone: [alice, bob, carol, dave, gina],
    zones: ZONES_2026,
    filters: [
      { label: 'no filter', args: {} },
      { label: 'project Brand', args: { projectId: projects.P1 } },
      { label: 'app figma', args: { applicationId: 'figma' } },
      { label: 'unattributed', args: { unattributed: true } },
      { label: 'project Web (archived)', args: { projectId: projects.P2 } },
      { label: 'project Brand + app blender', args: { projectId: projects.P1, applicationId: 'blender' } },
      { label: 'unattributed + app photoshop', args: { unattributed: true, applicationId: 'photoshop' } },
      { label: 'project Motion', args: { projectId: projects.P3 } },
      { label: 'app cinema-4d', args: { applicationId: 'cinema-4d' } },
      { label: 'unattributed false', args: { unattributed: false } },
      { label: "B's project", args: { projectId: projects.Q1 } },
      { label: 'unknown app', args: { applicationId: 'no-such-app' } },
      { label: 'project + unattributed', args: { projectId: projects.P1, unattributed: true } },
      { label: 'project + unattributed + app', args: { projectId: projects.P3, unattributed: true, applicationId: 'figma' } },
    ],
    counter: 0,
    block: 0,
  };
  const b: Workspace = {
    name: 'B',
    id: wsB,
    callers: callersB,
    removed: ivan,
    everyone: [erin, gina, frank, ivan],
    zones: ZONES_2021,
    filters: [
      { label: 'no filter', args: {} },
      { label: 'project Poster', args: { projectId: projects.Q1 } },
      { label: 'app blender', args: { applicationId: 'blender' } },
      { label: 'unattributed', args: { unattributed: true } },
      { label: 'project Leaflet (archived)', args: { projectId: projects.Q2 } },
      { label: 'project Poster + app figma', args: { projectId: projects.Q1, applicationId: 'figma' } },
      { label: 'unattributed + app after-effects', args: { unattributed: true, applicationId: 'after-effects' } },
      { label: 'app krita', args: { applicationId: 'krita' } },
      { label: 'app photoshop', args: { applicationId: 'photoshop' } },
      { label: 'unattributed false', args: { unattributed: false } },
      { label: "A's project", args: { projectId: projects.P1 } },
      { label: 'unknown app', args: { applicationId: 'no-such-app' } },
      { label: 'project + unattributed', args: { projectId: projects.Q1, unattributed: true } },
      { label: 'project + unattributed + app', args: { projectId: projects.Q2, unattributed: true, applicationId: 'figma' } },
    ],
    counter: 0,
    block: 0,
  };

  for (const phase of ['private', 'admins'] as const) {
    if (phase === 'admins') {
      ok(await setVisibility(db(), alice, wsA, 'admins'));
      ok(await setVisibility(db(), erin, wsB, 'admins'));
    }
    await runPhase(a, phase);
    await runPhase(b, phase);
    await runEdges(a, b, phase);
  }
}, 240_000);

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

function compareAll(engine: Engine, host: string): void {
  const inputs = new Map<string, ReportInterval[]>();
  const problems: string[] = [];
  for (const item of cases) {
    const key = `${item.workspaceId}|${item.caller.id}|${item.teammatesVisible}`;
    let input = inputs.get(key);
    if (!input) {
      input = readableBy(stored, item.workspaceId, item.caller, item.teammatesVisible);
      inputs.set(key, input);
    }
    const problem = difference(item.rpc, runOracle(engine, input, item.args, item.teammatesVisible));
    if (problem !== null) problems.push(`${item.label}: ${problem}`);
  }
  expect(problems.slice(0, 6), `${problems.length} of ${cases.length} cases differ (host ${host}, seed ${SEED})`).toEqual([]);
}

describe('analytics_time_summary against summarizeReport', () => {
  it('uses zones whose tzdata PGlite and Node agree on, around every date used', async () => {
    const zones = [...new Set([...ZONES_2026, ...ZONES_2021].map(([zone]) => zone)), 'Etc/GMT+3'];
    const windows = [
      ['2019-12-30T00:00:00Z', '2020-01-04T00:00:00Z'],
      ['2021-03-20T00:00:00Z', '2021-04-01T00:00:00Z'],
      ['2021-10-24T00:00:00Z', '2021-11-03T00:00:00Z'],
      ['2026-03-01T00:00:00Z', '2026-04-10T00:00:00Z'],
      ['2026-09-01T00:00:00Z', '2026-11-06T00:00:00Z'],
    ];
    const formats = new Map<string, Intl.DateTimeFormat>();
    const wall = (ms: number, zone: string) => {
      let format = formats.get(zone);
      if (!format) {
        format = new Intl.DateTimeFormat('en-CA', {
          timeZone: zone,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        formats.set(zone, format);
      }
      const parts = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    };
    const differences: string[] = [];
    for (const zone of zones) {
      for (const [from, to] of windows) {
        const rows = await db().admin<{ ms: number; wall: string }>(
          `select (extract(epoch from g) * 1000)::float8 as ms, to_char(g at time zone $1, 'YYYY-MM-DD HH24:MI') as wall
             from generate_series($2::timestamptz, $3::timestamptz, interval '15 minutes') as g`,
          [zone, from, to],
        );
        for (const row of rows) {
          if (row.wall !== wall(row.ms, zone)) differences.push(`${zone} ${new Date(row.ms).toISOString()}: ${row.wall} vs ${wall(row.ms, zone)}`);
        }
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
  });

  it('gives the same rows, in the same order, as the oracle (process host zone)', () => {
    compareAll(processEngine, `process (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  });

  describe('with the oracle under other host time zones', () => {
    const originalTz = process.env.TZ;
    afterAll(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    /** Host zone and the offset `new Date(2026, 0, 1).getTimezoneOffset()` must report there. */
    const HOSTS = [
      ['UTC', 0],
      ['America/Los_Angeles', 480],
      ['Pacific/Kiritimati', -840],
    ] as const;

    for (const [host, offsetMinutes] of HOSTS) {
      it(`gives the same rows with a ${host} host`, async () => {
        try {
          process.env.TZ = host;
          // Prove the switch took effect before trusting anything computed under it.
          expect(new Date(2026, 0, 1).getTimezoneOffset(), `host ${host}`).toBe(offsetMinutes);
          expect(Intl.DateTimeFormat().resolvedOptions().timeZone, `host ${host}`).toBe(host);
          vi.resetModules();
          const engine: Engine = await import('@studio-pulse/time-engine');
          expect(engine, 'a fresh engine module (no cache carried over)').not.toBe(processEngine);
          compareAll(engine, host);
        } finally {
          if (originalTz === undefined) delete process.env.TZ;
          else process.env.TZ = originalTz;
        }
      });
    }
  });

  it('does not depend on the database session time zone', () => {
    const rerun = cases.filter((item) => item.session !== undefined);
    expect(rerun.length).toBeGreaterThan(50);
    const problems: string[] = [];
    for (const item of rerun) {
      const session = item.session;
      if (!session) continue;
      const same = JSON.stringify(session.rpc) === JSON.stringify(item.rpc);
      if (!same) problems.push(`${item.label} (session ${session.timeZone}): ${JSON.stringify(session.rpc).slice(0, 300)}`);
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it('refuses the same arguments on both sides (the comparison above includes them)', () => {
    const refused = (phase: Visibility) =>
      cases.filter((item) => item.filter === -1 && item.label.startsWith(`${phase} `) && !item.rpc.ok).map((item) => item.label);
    // 16 refused arguments and frank's span reaching back to 2020. Under 'admins' erin's does too
    // (frank's 2020 entries are then in her scope), and so do the three spans that start at ivan's
    // rows without time (the zero-length one twice, the covered one once).
    expect(refused('private')).toHaveLength(17);
    expect(refused('admins')).toHaveLength(21);
    expect(refused('admins').filter((label) => label.includes('..2019-12-31'))).toHaveLength(2);
    const ivan = cases.filter((item) => item.filter === -1 && item.callerName === 'erin' && item.label.includes('users=edge') && /2021-03-27|2020-12-31|2021-01-01/.test(item.args.to));
    expect(ivan.filter((item) => item.phase === 'private').map((item) => item.rpc.ok)).toEqual([true, true, true, true, true]);
    expect(ivan.filter((item) => item.phase === 'admins').map((item) => item.rpc.ok)).toEqual([false, false, true, true, false]);
  });

  it('covers what it claims to cover', () => {
    const answered = cases.filter((item): item is Case & { rpc: { ok: true; value: ReportRow[] } } => item.rpc.ok);
    const rows = (item: (typeof answered)[number], dimension: ReportRow['dimension']) =>
      item.rpc.value.filter((row) => row.dimension === dimension);
    const total = (item: (typeof answered)[number]) => item.rpc.value[0] as ReportRow;
    const some = (test: (item: (typeof answered)[number]) => boolean) => answered.filter(test).length;

    expect(cases.length).toBeGreaterThan(1000);
    expect(answered.length).toBeGreaterThan(800);

    // What was called. `lacking` lists the combinations no call had.
    type Part = readonly [ReadonlyArray<string | number>, (item: Case) => string | number];
    const lacking = (items: Case[], ...parts: Part[]): string[] => {
      const seen = new Set(items.map((item) => parts.map(([, of]) => String(of(item))).join(' × ')));
      let all: string[][] = [[]];
      for (const [values] of parts) all = all.flatMap((prefix) => values.map((value) => [...prefix, String(value)]));
      return all.map((combination) => combination.join(' × ')).filter((combination) => !seen.has(combination));
    };
    const byFilter: Part = [Array.from({ length: 14 }, (_, index) => index), (item) => item.filter];
    const byBucket: Part = [BUCKETS, (item) => item.bucket];
    const byRange: Part = [RANGES.map((_, index) => index), (item) => item.range];
    const byUserList: Part = [SCOPES, (item) => item.scope];
    const byFirstDay: Part = [['given', 'none'], (item) => (item.range >= NO_FIRST_DAY ? 'none' : 'given')];
    for (const [name, workspace, callers] of [
      ['A', world.wsA, ['alice', 'bob', 'carol', 'gina']],
      ['B', world.wsB, ['erin', 'gina', 'frank']],
    ] as const) {
      const turned = cases.filter((item) => item.workspaceId === workspace && item.filter !== -1);
      const byZone: Part = [[...new Set(turned.map((item) => item.args.timeZone))], (item) => item.args.timeZone];
      // The workspace: every filter with every range × bucket, user list and zone.
      expect(lacking(turned, byRange, byBucket, byFilter), `${name}: range × bucket × filter`).toEqual([]);
      expect(lacking(turned, byUserList, byFilter), `${name}: user list × filter`).toEqual([]);
      expect(lacking(turned, byUserList, byRange), `${name}: user list × range`).toEqual([]);
      expect(lacking(turned, byZone, byFilter), `${name}: zone × filter`).toEqual([]);
      expect(lacking(turned, byZone, byUserList), `${name}: zone × user list`).toEqual([]);
      for (const phase of ['private', 'admins'] as const) {
        const roles = new Set<Role>();
        for (const caller of callers) {
          const calls = turned.filter((item) => item.phase === phase && item.callerName === caller);
          const who = `${name} ${phase} ${caller}`;
          for (const item of calls) roles.add(item.role);
          // Each caller under each visibility: every filter with every bucket and with no first
          // day; every user list with every bucket and with no first day; every zone and range.
          expect(lacking(calls, byBucket, byFilter), `${who}: bucket × filter`).toEqual([]);
          expect(lacking(calls, byFirstDay, byFilter), `${who}: first day × filter`).toEqual([]);
          expect(lacking(calls, byUserList, byBucket), `${who}: user list × bucket`).toEqual([]);
          expect(lacking(calls, byUserList, byFirstDay), `${who}: user list × first day`).toEqual([]);
          expect(lacking(calls, byZone, byRange, byBucket), `${who}: zone × range × bucket`).toEqual([]);

          // What came back, by the access rule: only an owner or admin under 'admins' reads others.
          const back = answered.filter((item) => item.filter !== -1 && item.workspaceId === workspace && item.phase === phase && item.callerName === caller);
          const visible = phase === 'admins' && calls[0]?.role !== 'member';
          expect(back.every((item) => total(item).teammatesVisible === visible), `${who}: teammates_visible`).toBe(true);
          const others = back.filter((item) => rows(item, 'member').some((row) => row.userId !== item.caller.id));
          if (visible) expect(others.length, `${who}: reports with other people's time`).toBeGreaterThan(20);
          else expect(others, `${who}: reports with other people's time`).toEqual([]);
          const withTime = back.filter((item) => total(item).activeMs + total(item).idleMs > 0);
          for (const bucket of BUCKETS) {
            expect(withTime.filter((item) => item.bucket === bucket).length, `${who}: reports with time by ${bucket}`).toBeGreaterThan(2);
          }
          expect(withTime.filter((item) => item.range >= NO_FIRST_DAY).length, `${who}: reports with time and no first day`).toBeGreaterThan(3);
          // Each kind of filter, and a user list naming the caller, came back with time for this
          // caller under this visibility (so a member's, an admin's and an owner's all did).
          for (const [kind, has] of [
            ['project', (item: Case) => item.args.projectId !== undefined],
            ['unattributed', (item: Case) => item.args.unattributed === true],
            ['application', (item: Case) => item.args.applicationId !== undefined],
            ['user list', (item: Case) => Array.isArray(item.args.userIds) && item.args.userIds.includes(item.caller.id)],
          ] as const) {
            expect(withTime.filter(has).length, `${who}: reports with time under a ${kind} filter`).toBeGreaterThan(0);
          }
          // A user list naming only a teammate: that teammate's time, and nobody else's, for an
          // owner or admin under 'admins'; nothing at all for everyone else.
          const teammateOnly = back.filter((item) => item.scope === 'teammate');
          expect(teammateOnly.length, `${who}: reports for a teammate alone`).toBeGreaterThan(5);
          if (visible) {
            expect(teammateOnly.filter((item) => total(item).activeMs + total(item).idleMs > 0).length, `${who}: a teammate's time`).toBeGreaterThan(0);
            expect(
              teammateOnly.every((item) => rows(item, 'member').every((row) => row.userId === item.args.userIds?.[0] && row.userId !== item.caller.id)),
              `${who}: only the teammate named`,
            ).toBe(true);
          } else {
            expect(
              teammateOnly.every((item) => total(item).activeMs + total(item).idleMs === 0 && total(item).entryCount === 0 && rows(item, 'member').length === 0),
              `${who}: nothing of a teammate's`,
            ).toBe(true);
          }
        }
        expect([...roles].sort(), `${name} ${phase}: roles`).toEqual(['admin', 'member', 'owner']);
      }
    }
    // Every combination of the three filters came back with time, except the two that are refused.
    const combination = (item: Case) =>
      [item.args.projectId !== undefined ? 'project' : '', item.args.unattributed === true ? 'unattributed' : '', item.args.applicationId !== undefined ? 'application' : '']
        .filter((part) => part !== '')
        .join('+');
    const withTime = answered.filter((item) => total(item).activeMs + total(item).idleMs > 0);
    for (const filters of ['', 'project', 'unattributed', 'application', 'project+application', 'unattributed+application']) {
      for (const bucket of BUCKETS) {
        for (const firstDay of [true, false]) {
          const count = withTime.filter((item) => combination(item) === filters && item.bucket === bucket && item.range !== -1 && item.range < NO_FIRST_DAY === firstDay).length;
          expect(count, `reports with time: filters "${filters}" by ${bucket}, first day ${firstDay ? 'given' : 'not given'}`).toBeGreaterThan(2);
        }
      }
    }
    // Each zone's two DST days, asked for alone (one local day, 23 to 25 hours long), came back with time.
    for (const [zones, workspace] of [
      [ZONES_2026, world.wsA],
      [ZONES_2021, world.wsB],
    ] as const) {
      for (const [zone, first, second] of zones) {
        for (const day of [first, second]) {
          const count = withTime.filter(
            (item) => item.workspaceId === workspace && item.args.timeZone === zone && item.args.from === day && item.args.to === day,
          ).length;
          expect(count, `reports with time: ${zone} on ${day} alone`).toBeGreaterThan(0);
        }
      }
    }
    for (const filters of ['project+unattributed', 'project+unattributed+application']) {
      const items = cases.filter((item) => combination(item) === filters);
      expect(items.length, filters).toBeGreaterThan(50);
      expect(items.every((item) => !item.rpc.ok && item.rpc.error.code === '22023'), filters).toBe(true);
    }

    // The figures exercise what reconciliation is for.
    expect(some((item) => total(item).overlapMs > 0)).toBeGreaterThan(100);
    expect(some((item) => total(item).activeMs > 0 && total(item).idleMs > 0)).toBeGreaterThan(100);
    expect(some((item) => item.args.projectId !== undefined && total(item).activeMs + total(item).idleMs > 0)).toBeGreaterThan(20);
    expect(some((item) => item.args.unattributed === true && total(item).activeMs + total(item).idleMs > 0)).toBeGreaterThan(20);
    expect(some((item) => item.args.applicationId !== undefined && total(item).activeMs + total(item).idleMs > 0)).toBeGreaterThan(20);
    expect(some((item) => total(item).teammatesVisible === true && rows(item, 'member').length >= 3)).toBeGreaterThan(20);
    expect(some((item) => total(item).teammatesVisible === false)).toBeGreaterThan(100);
    // An entry crossing a local midnight counts in each period it touches.
    expect(
      some((item) => item.args.bucket !== 'month' && rows(item, 'period').reduce((sum, row) => sum + row.entryCount, 0) > total(item).entryCount),
    ).toBeGreaterThan(50);
    // Task time without a project, unattributed time, and the archived project's time.
    expect(some((item) => rows(item, 'project').some((row) => row.projectId === null && row.unattributed === false))).toBeGreaterThan(50);
    expect(some((item) => rows(item, 'project').some((row) => row.unattributed === true))).toBeGreaterThan(50);
    expect(some((item) => rows(item, 'task').some((row) => row.projectId === null && row.taskId !== null))).toBeGreaterThan(50);
    expect(some((item) => rows(item, 'project').some((row) => row.projectId === projects.P2))).toBeGreaterThan(20);
    expect(some((item) => rows(item, 'task').some((row) => row.taskId === tasks.T2 && row.projectId === null))).toBeGreaterThan(20);
    expect(some((item) => rows(item, 'task').some((row) => row.taskId === tasks.T5 && row.projectId === projects.P1))).toBeGreaterThan(20);
    // A task that never had a project; archived tasks (one under the archived project, one under
    // an active one); and the same in B: its archived project, its archived task, its moved task.
    expect(some((item) => rows(item, 'task').some((row) => row.taskId === tasks.T3 && row.projectId === null))).toBeGreaterThan(20);
    expect(some((item) => rows(item, 'task').some((row) => row.taskId === tasks.T4 && row.projectId === projects.P2))).toBeGreaterThan(20);
    expect(some((item) => rows(item, 'task').some((row) => row.taskId === tasks.T6 && row.projectId === projects.P3))).toBeGreaterThan(20);
    expect(some((item) => rows(item, 'project').some((row) => row.projectId === projects.Q2))).toBeGreaterThan(20);
    expect(some((item) => rows(item, 'task').some((row) => row.taskId === tasks.U1 && row.projectId === projects.Q1))).toBeGreaterThan(20);
    expect(some((item) => rows(item, 'task').some((row) => row.taskId === tasks.U3 && row.projectId === null))).toBeGreaterThan(20);
    // The archived project's filter came back with time, with its archived task under it.
    expect(
      some((item) => item.args.projectId === projects.P2 && rows(item, 'task').some((row) => row.taskId === tasks.T4 && row.activeMs + row.idleMs > 0)),
    ).toBeGreaterThan(5);
    // No first day, resolved from the data.
    expect(some((item) => !item.args.from && item.filter !== -1 && rows(item, 'period').length >= 2)).toBeGreaterThan(30);
    expect(some((item) => !item.args.from && item.args.to.startsWith('2020-01-0') && rows(item, 'period')[0]?.bucketStart?.startsWith('2019-12') === true)).toBeGreaterThan(2);

    // The stored rows have what the seeding promised.
    expect(stored.filter((row) => !Number.isInteger(row.startMs) || !Number.isInteger(row.endMs)).length).toBeGreaterThan(5);
    expect(stored.filter((row) => Math.floor(row.endMs) === Math.floor(row.startMs)).length).toBeGreaterThan(0);
    expect(stored.filter((row) => row.endMs - row.startMs > 24 * HOUR).length).toBeGreaterThan(10);
    const names = new Map<string, Set<string>>();
    for (const row of stored) names.set(row.applicationId, (names.get(row.applicationId) ?? new Set()).add(row.applicationName));
    expect([...names.values()].filter((set) => set.size > 1).length).toBeGreaterThan(1);
  });
});
