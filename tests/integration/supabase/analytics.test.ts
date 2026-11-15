/**
 * `analytics_time_summary` (migration 10): who may read what, every refused argument, the
 * function's properties, and the figures themselves. Expected values are literal, worked out by
 * hand from the entries each test syncs (docs/analytics.md has the rules): never computed with
 * the code under test.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  PERMISSION_DENIED,
  addMember,
  buildWorld,
  createProject,
  createWorkspace,
  entry,
  fails,
  newUser,
  ok,
  removeMember,
  setVisibility,
  syncOk,
  useDatabase,
  uuidv7,
} from './fixtures';
import type { EntryPayload, World } from './fixtures';
import type { Outcome, TestUser, Who } from './harness';

const db = useDatabase();

const MINUTE = 60_000;
const SECOND_DEVICE = '5f1e2d3c-4b5a-4968-8776-655443322110';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A closed interval synced from the desktop: `minutes` long from `startIso`, active by default. */
function span(startIso: string, minutes: number, fields: Partial<EntryPayload> = {}): EntryPayload {
  const start = Date.parse(startIso);
  const end = start + minutes * MINUTE;
  const kind = fields.kind ?? 'active';
  return entry({
    id: uuidv7(start),
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    activeMs: kind === 'active' ? end - start : 0,
    idleMs: kind === 'idle' ? end - start : 0,
    recordedAt: new Date(end).toISOString(),
    ...fields,
  });
}

interface ReportRow {
  dimension: string;
  bucket_start: string | null;
  user_id: string | null;
  application_id: string | null;
  application_name: string | null;
  project_id: string | null;
  task_id: string | null;
  unattributed: boolean | null;
  active_ms: number;
  idle_ms: number;
  entry_count: number;
  overlap_ms: number;
  teammates_visible: boolean | null;
}

interface ReportOptions {
  from?: string | null;
  bucket?: string | null;
  userIds?: string[] | null;
  projectId?: string | null;
  unattributed?: boolean | null;
  applicationId?: string | null;
}

const OPTIONAL_ARGS: ReadonlyArray<[keyof ReportOptions, string, string]> = [
  ['from', 'p_from', 'date'],
  ['bucket', 'p_bucket', 'text'],
  ['userIds', 'p_user_ids', 'uuid[]'],
  ['projectId', 'p_project_id', 'uuid'],
  ['unattributed', 'p_unattributed', 'boolean'],
  ['applicationId', 'p_application_id', 'text'],
];

/** Calls the RPC as PostgREST does (named arguments; omitted ones take their defaults). */
function report(
  who: Who,
  workspaceId: string | null,
  to: string | null,
  timeZone: string | null,
  options: ReportOptions = {},
): Promise<Outcome<ReportRow[]>> {
  const params: unknown[] = [workspaceId, to, timeZone];
  const args = ['p_workspace_id => $1::uuid', 'p_to => $2::date', 'p_time_zone => $3::text'];
  for (const [key, name, type] of OPTIONAL_ARGS) {
    if (!(key in options)) continue;
    params.push(options[key]);
    args.push(`${name} => $${params.length}::${type}`);
  }
  return db().query<ReportRow & Record<string, unknown>>(
    who,
    `select dimension, bucket_start::text as bucket_start, user_id, application_id,
            application_name, project_id, task_id, unattributed,
            active_ms::float8 as active_ms, idle_ms::float8 as idle_ms, entry_count,
            overlap_ms::float8 as overlap_ms, teammates_visible
       from public.analytics_time_summary(${args.join(', ')})`,
    params,
  );
}

const secs = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);
const FIELDS = [
  'bucket_start',
  'user_id',
  'application_id',
  'application_name',
  'project_id',
  'task_id',
  'unattributed',
  'overlap_ms',
  'teammates_visible',
] as const;

/**
 * One line per row, ids replaced by names. A field a dimension should leave empty (null, or 0
 * for overlap_ms) is appended as `!field=value`, so it fails the comparison.
 */
function lines(rows: readonly ReportRow[], names: Readonly<Record<string, string>>): string[] {
  const name = (id: string | null) => (id === null ? '-' : (names[id] ?? id));
  return rows.map((row) => {
    const figures = `a=${secs(row.active_ms)} i=${secs(row.idle_ms)} n=${row.entry_count}`;
    let head: string;
    let used: string[];
    switch (row.dimension) {
      case 'total':
        head = `total ${figures} overlap=${secs(row.overlap_ms)} teammates=${row.teammates_visible}`;
        used = ['overlap_ms', 'teammates_visible'];
        break;
      case 'period':
        head = `period ${row.bucket_start} ${figures}`;
        used = ['bucket_start'];
        break;
      case 'member':
        head = `member ${name(row.user_id)} ${figures}`;
        used = ['user_id'];
        break;
      case 'project': {
        const label =
          row.project_id !== null
            ? `${name(row.project_id)}${row.unattributed === false ? '' : ` !unattributed=${row.unattributed}`}`
            : row.unattributed === true
              ? '(unattributed)'
              : row.unattributed === false
                ? '(no project)'
                : '!unattributed=null';
        head = `project ${label} ${figures}`;
        used = ['project_id', 'unattributed'];
        break;
      }
      case 'task':
        head = `task ${name(row.project_id)}/${name(row.task_id)} ${figures}`;
        used = ['project_id', 'task_id'];
        break;
      case 'application':
        head = `application ${row.application_id} "${row.application_name}" ${figures}`;
        used = ['application_id', 'application_name'];
        break;
      default:
        head = `!dimension=${row.dimension} ${figures}`;
        used = [];
    }
    const extras = FIELDS.filter((field) => !used.includes(field))
      .filter((field) => row[field] !== (field === 'overlap_ms' ? 0 : null))
      .map((field) => ` !${field}=${String(row[field])}`);
    return head + extras.join('');
  });
}

const ZERO_TOTAL_PRIVATE = 'total a=0s i=0s n=0 overlap=0s teammates=false';

/** Code-point order of ids (Postgres orders lowercase uuids the same way). */
function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

async function insertProject(who: TestUser, workspaceId: string, id: string, name: string) {
  ok(await db().query(who, `insert into public.projects (id, workspace_id, name) values ($1, $2, $3)`, [id, workspaceId, name]));
}

async function insertTask(who: TestUser, workspaceId: string, id: string, title: string, projectId: string | null) {
  ok(
    await db().query(
      who,
      `insert into public.tasks (id, workspace_id, title, project_id) values ($1, $2, $3, $4)`,
      [id, workspaceId, title, projectId],
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// World: 2026-10-16 (UTC) in workspace A, plus gina's time in B. dave is then removed from A.
// ---------------------------------------------------------------------------------------------

let world: World;
let names: Record<string, string>;
let projectB: string;

beforeAll(async () => {
  world = await buildWorld(db());
  const { alice, bob, carol, dave, gina, wsA, wsB } = world;
  names = { [alice.id]: 'alice', [bob.id]: 'bob', [carol.id]: 'carol', [dave.id]: 'dave', [gina.id]: 'gina' };
  await syncOk(db(), alice, wsA, [span('2026-10-16T09:00:00Z', 30)]);
  await syncOk(db(), bob, wsA, [
    span('2026-10-16T10:00:00Z', 20, { applicationId: 'blender', applicationName: 'Blender' }),
  ]);
  await syncOk(db(), carol, wsA, [
    span('2026-10-16T11:00:00Z', 10),
    span('2026-10-16T12:00:00Z', 5, { kind: 'idle' }),
  ]);
  await syncOk(db(), dave, wsA, [
    span('2026-10-16T13:00:00Z', 15, { applicationId: 'photoshop', applicationName: 'Photoshop' }),
  ]);
  await syncOk(db(), gina, wsA, [span('2026-10-16T15:00:00Z', 7)]);
  await syncOk(db(), gina, wsB, [span('2026-10-16T14:00:00Z', 40)]);
  projectB = await createProject(db(), world.erin, wsB, 'Other studio project');
  ok(await removeMember(db(), alice, wsA, dave));
});

const DAY = { from: '2026-10-16' };

// ---------------------------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------------------------

describe('authorization', () => {
  it('needs a signed-in user (28000)', async () => {
    const outcome = await db().asClaims('authenticated', { role: 'authenticated' }, (session) =>
      session.query(`select * from public.analytics_time_summary($1, '2026-10-16', 'UTC')`, [world.wsA]),
    );
    fails(outcome, '28000', /sign in to see analytics/);
  });

  it('is not callable with the anon key', async () => {
    fails(await report('anon', world.wsA, '2026-10-16', 'UTC'), '42501', PERMISSION_DENIED);
  });

  it('refuses non-members, removed members and unknown or null workspaces alike (P0002)', async () => {
    fails(await report(world.mallory, world.wsA, '2026-10-16', 'UTC'), 'P0002', /^workspace not found$/);
    fails(await report(world.frank, world.wsA, '2026-10-16', 'UTC'), 'P0002', /^workspace not found$/);
    fails(await report(world.alice, null, '2026-10-16', 'UTC'), 'P0002', /^workspace not found$/);
    fails(
      await report(world.alice, '00000000-0000-4000-8000-000000000000', '2026-10-16', 'UTC'),
      'P0002',
      /^workspace not found$/,
    );
    // dave was removed: he can still read his own rows, but not report on the workspace.
    const own = ok(
      await db().query<{ n: number }>(world.dave, `select count(*)::int as n from public.time_entries where workspace_id = $1`, [world.wsA]),
    );
    expect(own).toEqual([{ n: 1 }]);
    fails(await report(world.dave, world.wsA, '2026-10-16', 'UTC', DAY), 'P0002', /^workspace not found$/);
  });

  it('checks membership before the arguments', async () => {
    fails(await report(world.mallory, world.wsA, null, null), 'P0002');
  });
});

// ---------------------------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------------------------

describe('visibility', () => {
  it('a member sees only her own time', async () => {
    const rows = ok(await report(world.carol, world.wsA, '2026-10-16', 'UTC', DAY));
    expect(lines(rows, names)).toEqual([
      'total a=600s i=300s n=2 overlap=0s teammates=false',
      'period 2026-10-16 a=600s i=300s n=2',
      'member carol a=600s i=300s n=2',
      'project (unattributed) a=600s i=300s n=2',
      'task -/- a=600s i=300s n=2',
      'application figma "Figma" a=600s i=300s n=2',
    ]);
  });

  it("a member asking for others' time gets a zero total; with herself included, her own", async () => {
    const others = ok(
      await report(world.carol, world.wsA, '2026-10-16', 'UTC', { ...DAY, userIds: [world.alice.id, world.bob.id] }),
    );
    expect(lines(others, names)).toEqual([ZERO_TOTAL_PRIVATE]);
    const mixed = ok(
      await report(world.carol, world.wsA, '2026-10-16', 'UTC', { ...DAY, userIds: [world.alice.id, world.carol.id] }),
    );
    expect(lines(mixed, names)[0]).toBe('total a=600s i=300s n=2 overlap=0s teammates=false');
  });

  it("owner and admin see only their own time while visibility is 'private'", async () => {
    expect(lines(ok(await report(world.alice, world.wsA, '2026-10-16', 'UTC', DAY)), names)).toEqual([
      'total a=1800s i=0s n=1 overlap=0s teammates=false',
      'period 2026-10-16 a=1800s i=0s n=1',
      'member alice a=1800s i=0s n=1',
      'project (unattributed) a=1800s i=0s n=1',
      'task -/- a=1800s i=0s n=1',
      'application figma "Figma" a=1800s i=0s n=1',
    ]);
    expect(lines(ok(await report(world.bob, world.wsA, '2026-10-16', 'UTC', DAY)), names)).toEqual([
      'total a=1200s i=0s n=1 overlap=0s teammates=false',
      'period 2026-10-16 a=1200s i=0s n=1',
      'member bob a=1200s i=0s n=1',
      'project (unattributed) a=1200s i=0s n=1',
      'task -/- a=1200s i=0s n=1',
      'application blender "Blender" a=1200s i=0s n=1',
    ]);
  });

  it("under 'admins' owner and admin see everyone (a removed member too); back to 'private' narrows", async () => {
    ok(await setVisibility(db(), world.alice, world.wsA, 'admins'));
    const figures: Record<string, string> = {
      alice: 'a=1800s i=0s n=1',
      bob: 'a=1200s i=0s n=1',
      carol: 'a=600s i=300s n=2',
      dave: 'a=900s i=0s n=1',
      gina: 'a=420s i=0s n=1',
    };
    const members = byId([world.alice, world.bob, world.carol, world.dave, world.gina]).map(
      (user) => `member ${names[user.id]} ${figures[names[user.id]!]}`,
    );
    const everyone = [
      'total a=4920s i=300s n=6 overlap=0s teammates=true',
      'period 2026-10-16 a=4920s i=300s n=6',
      ...members,
      'project (unattributed) a=4920s i=300s n=6',
      'task -/- a=4920s i=300s n=6',
      'application blender "Blender" a=1200s i=0s n=1',
      'application figma "Figma" a=2820s i=300s n=4',
      'application photoshop "Photoshop" a=900s i=0s n=1',
    ];
    expect(lines(ok(await report(world.alice, world.wsA, '2026-10-16', 'UTC', DAY)), names)).toEqual(everyone);
    expect(lines(ok(await report(world.bob, world.wsA, '2026-10-16', 'UTC', DAY)), names)).toEqual(everyone);

    // One teammate, by id.
    expect(
      lines(ok(await report(world.alice, world.wsA, '2026-10-16', 'UTC', { ...DAY, userIds: [world.carol.id] })), names),
    ).toEqual([
      'total a=600s i=300s n=2 overlap=0s teammates=true',
      'period 2026-10-16 a=600s i=300s n=2',
      'member carol a=600s i=300s n=2',
      'project (unattributed) a=600s i=300s n=2',
      'task -/- a=600s i=300s n=2',
      'application figma "Figma" a=600s i=300s n=2',
    ]);

    // Members still see only their own time (gina is an admin in B, a member here; her B time
    // never counts in A).
    expect(lines(ok(await report(world.gina, world.wsA, '2026-10-16', 'UTC', DAY)), names)[0]).toBe(
      'total a=420s i=0s n=1 overlap=0s teammates=false',
    );

    ok(await setVisibility(db(), world.alice, world.wsA, 'private'));
    expect(lines(ok(await report(world.alice, world.wsA, '2026-10-16', 'UTC', DAY)), names)[0]).toBe(
      'total a=1800s i=0s n=1 overlap=0s teammates=false',
    );
    expect(lines(ok(await report(world.bob, world.wsA, '2026-10-16', 'UTC', DAY)), names)[0]).toBe(
      'total a=1200s i=0s n=1 overlap=0s teammates=false',
    );
  });

  it('a project of another workspace gives zeros, not an error', async () => {
    const rows = ok(await report(world.alice, world.wsA, '2026-10-16', 'UTC', { ...DAY, projectId: projectB }));
    expect(lines(rows, names)).toEqual([ZERO_TOTAL_PRIVATE]);
  });
});

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

describe('validation (22023)', () => {
  const refused = async (to: string | null, timeZone: string | null, options: ReportOptions, message: RegExp) =>
    fails(await report(world.alice, world.wsA, to, timeZone, options), '22023', message);
  const accepted = async (to: string, timeZone: string, options: ReportOptions) =>
    expect(ok(await report(world.alice, world.wsA, to, timeZone, options))[0]?.dimension).toBe('total');

  it('refuses each missing argument', async () => {
    await refused(null, 'UTC', {}, /^choose the last day of the report$/);
    await refused('2026-10-16', null, {}, /^choose a time zone for the report$/);
    await refused('2026-10-16', 'UTC', { bucket: null }, /^group the report by day, week or month$/);
    await refused('2026-10-16', 'UTC', { unattributed: null }, /^say whether to show only unattributed time$/);
  });

  it('refuses an unknown bucket', async () => {
    await refused('2026-10-16', 'UTC', { bucket: 'year' }, /^group the report by day, week or month$/);
    await refused('2026-10-16', 'UTC', { bucket: 'Day' }, /^group the report by day, week or month$/);
  });

  it('accepts IANA zone names only', async () => {
    for (const zone of ['UTC+3', 'CET', 'EST', 'Not/AZone', '+03', '', 'Europe/Berlin; select 1']) {
      await refused('2026-10-16', zone, {}, /^unknown time zone$/);
    }
    for (const zone of ['UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Etc/GMT+3']) {
      await accepted('2026-10-16', zone, {});
    }
  });

  it('refuses a range that ends before it starts, or leaves 2020-2099', async () => {
    await refused('2026-10-15', 'UTC', { from: '2026-10-16' }, /^the report ends before it starts$/);
    await refused('2026-10-16', 'UTC', { from: '2019-12-31' }, /^reports cover days from 1 January 2020$/);
    await refused('2019-12-31', 'UTC', {}, /^reports cover days from 1 January 2020$/);
    await refused('2100-01-01', 'UTC', { from: '2099-12-31' }, /^reports cover days before 1 January 2100$/);
    await accepted('2020-01-01', 'UTC', { from: '2020-01-01' });
    await accepted('2099-12-31', 'UTC', { from: '2099-12-31' });
  });

  it('limits the span to 366 days for every bucket without a project', async () => {
    for (const bucket of ['day', 'week', 'month']) {
      await accepted('2026-10-16', 'UTC', { from: '2025-10-16', bucket });
      await refused('2026-10-16', 'UTC', { from: '2025-10-15', bucket }, /^a report covers at most 366 days$/);
    }
  });

  it('allows a project report 366 days by day, 1100 by week and 3660 by month', async () => {
    const projectId = await createProject(db(), world.alice, world.wsA, 'Span project');
    await accepted('2026-10-16', 'UTC', { from: '2025-10-16', bucket: 'day', projectId });
    await refused(
      '2026-10-16',
      'UTC',
      { from: '2025-10-15', bucket: 'day', projectId },
      /^a project report by day covers at most 366 days$/,
    );
    await accepted('2026-10-16', 'UTC', { from: '2023-10-13', bucket: 'week', projectId });
    await refused(
      '2026-10-16',
      'UTC',
      { from: '2023-10-12', bucket: 'week', projectId },
      /^a project report by week covers at most 1100 days$/,
    );
    await accepted('2030-12-31', 'UTC', { from: '2020-12-24', bucket: 'month', projectId });
    await refused(
      '2030-12-31',
      'UTC',
      { from: '2020-12-23', bucket: 'month', projectId },
      /^a project report by month covers at most 3660 days$/,
    );
  });

  it('limits the people to 500', async () => {
    const ids = (count: number) => Array.from({ length: count }, (_, k) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`);
    await accepted('2026-10-16', 'UTC', { userIds: ids(500) });
    await refused('2026-10-16', 'UTC', { userIds: ids(501) }, /^a report covers at most 500 people$/);
  });

  it('refuses a project together with unattributed time', async () => {
    await refused(
      '2026-10-16',
      'UTC',
      { projectId: projectB, unattributed: true },
      /^choose a project or unattributed time, not both$/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Function properties
// ---------------------------------------------------------------------------------------------

describe('function properties', () => {
  it('is SECURITY INVOKER, STABLE, with an empty search_path and per-call plans', async () => {
    const [fn] = await db().admin<{ prosecdef: boolean; provolatile: string; proconfig: string[]; executes: boolean }>(
      `select prosecdef, provolatile, proconfig,
              prosrc like '%return query execute $q$%' as executes
         from pg_proc where oid = 'public.analytics_time_summary'::regproc`,
    );
    // No plan_cache_mode setting: the queries run through EXECUTE (planned per call). A
    // function-level plan_cache_mode would also re-plan the RLS helper for every row.
    expect(fn).toEqual({ prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], executes: true });
  });

  it('orders application rows in code-point order whatever the database collation', async () => {
    // PGlite's database collation is C, so no ordering test here can tell a missing clause from
    // a present one; a linguistic collation (en_US.UTF-8) would put 'ab' before 'a-z'.
    const [fn] = await db().admin<{ code_point_apps: boolean }>(
      `select prosrc like '%agg.app collate "C" nulls last%' as code_point_apps
         from pg_proc where oid = 'public.analytics_time_summary'::regproc`,
    );
    expect(fn).toEqual({ code_point_apps: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Semantics
// ---------------------------------------------------------------------------------------------

describe('figures', () => {
  let ana: TestUser;
  let people: Record<string, string>;

  beforeAll(async () => {
    ana = await newUser(db(), 'ana');
    people = { [ana.id]: 'ana' };
  });

  it('adds up days and weeks, splitting time across midnight', async () => {
    const ws = await createWorkspace(db(), ana, 'Days');
    await syncOk(db(), ana, ws, [
      span('2026-10-12T10:00:00Z', 30), // Monday
      span('2026-10-14T09:00:00Z', 20, { applicationId: 'blender', applicationName: 'Blender' }),
      span('2026-10-18T23:30:00Z', 75), // Sunday 23:30 to Monday 00:45
      span('2026-10-20T08:00:00Z', 10, { kind: 'idle', applicationName: 'Figma Desktop' }),
    ]);
    const range = { from: '2026-10-12' };
    const common = [
      'member ana a=7500s i=600s n=4',
      'project (unattributed) a=7500s i=600s n=4',
      'task -/- a=7500s i=600s n=4',
      'application blender "Blender" a=1200s i=0s n=1',
      'application figma "Figma Desktop" a=6300s i=600s n=3',
    ];
    expect(lines(ok(await report(ana, ws, '2026-10-20', 'UTC', range)), people)).toEqual([
      'total a=7500s i=600s n=4 overlap=0s teammates=false',
      'period 2026-10-12 a=1800s i=0s n=1',
      'period 2026-10-14 a=1200s i=0s n=1',
      'period 2026-10-18 a=1800s i=0s n=1',
      'period 2026-10-19 a=2700s i=0s n=1',
      'period 2026-10-20 a=0s i=600s n=1',
      ...common,
    ]);
    expect(lines(ok(await report(ana, ws, '2026-10-20', 'UTC', { ...range, bucket: 'week' })), people)).toEqual([
      'total a=7500s i=600s n=4 overlap=0s teammates=false',
      'period 2026-10-12 a=4800s i=0s n=3',
      'period 2026-10-19 a=2700s i=600s n=2',
      ...common,
    ]);
    expect(lines(ok(await report(ana, ws, '2026-10-20', 'UTC', { ...range, bucket: 'month' })), people)).toEqual([
      'total a=7500s i=600s n=4 overlap=0s teammates=false',
      'period 2026-10-01 a=7500s i=600s n=4',
      ...common,
    ]);
    // Each side of midnight on its own; the name is the latest contributing entry's.
    expect(lines(ok(await report(ana, ws, '2026-10-19', 'UTC', { from: '2026-10-19' })), people)).toEqual([
      'total a=2700s i=0s n=1 overlap=0s teammates=false',
      'period 2026-10-19 a=2700s i=0s n=1',
      'member ana a=2700s i=0s n=1',
      'project (unattributed) a=2700s i=0s n=1',
      'task -/- a=2700s i=0s n=1',
      'application figma "Figma" a=2700s i=0s n=1',
    ]);
    expect(lines(ok(await report(ana, ws, '2026-10-18', 'UTC', { from: '2026-10-18' })), people)[0]).toBe(
      'total a=1800s i=0s n=1 overlap=0s teammates=false',
    );
  });

  describe('overlapping devices', () => {
    let ws: string;
    let projectR: string;
    let batch: EntryPayload[];
    let projects: Record<string, string>;
    const UNFILTERED = [
      'total a=5400s i=2400s n=4 overlap=3300s teammates=false',
      'period 2026-10-21 a=5400s i=2400s n=4',
      'member ana a=5400s i=2400s n=4',
      'project Render a=1800s i=0s n=1',
      'project (unattributed) a=3600s i=2400s n=3',
      'task Render/- a=1800s i=0s n=1',
      'task -/- a=3600s i=2400s n=3',
      'application blender "Blender" a=1800s i=0s n=1',
      'application figma "Figma" a=3600s i=600s n=2',
      'application photoshop "Photoshop" a=0s i=1800s n=1',
    ];

    beforeAll(async () => {
      ws = await createWorkspace(db(), ana, 'Devices');
      projectR = await createProject(db(), ana, ws, 'Render');
      projects = { ...people, [projectR]: 'Render' };
      batch = [
        // Device A: Figma 10:00-11:00 active, 11:20-11:40 idle.
        span('2026-10-21T10:00:00Z', 60),
        span('2026-10-21T11:20:00Z', 20, { kind: 'idle' }),
        // Device B: Photoshop idle 09:30-10:15, Blender active 10:30-11:30 on project Render.
        span('2026-10-21T09:30:00Z', 45, {
          kind: 'idle',
          deviceId: SECOND_DEVICE,
          applicationId: 'photoshop',
          applicationName: 'Photoshop',
        }),
        span('2026-10-21T10:30:00Z', 60, {
          deviceId: SECOND_DEVICE,
          applicationId: 'blender',
          applicationName: 'Blender',
          projectId: projectR,
        }),
      ];
      await syncOk(db(), ana, ws, batch);
    });

    it('counts each instant once: the earlier active row wins, active beats idle on any device', async () => {
      // Active: Figma 10:00-11:00, Blender only 11:00-11:30. Idle: Photoshop 09:30-10:00 (the
      // rest is under Figma), Figma idle 11:30-11:40 (the rest is under Blender).
      // Raw 3600 + 3600 + 2700 + 1200 = 11100 s, counted 7800 s: overlap 3300 s.
      expect(lines(ok(await report(ana, ws, '2026-10-21', 'UTC', { from: '2026-10-21' })), projects)).toEqual(UNFILTERED);
    });

    it('filters after reconciling, so a filtered figure is a part of the unfiltered one', async () => {
      const day = { from: '2026-10-21' };
      // Blender keeps only its own 30 minutes even though Figma (not matching) owns the rest.
      const render = [
        'total a=1800s i=0s n=1 overlap=1800s teammates=false',
        'period 2026-10-21 a=1800s i=0s n=1',
        'member ana a=1800s i=0s n=1',
        'project Render a=1800s i=0s n=1',
        'task Render/- a=1800s i=0s n=1',
        'application blender "Blender" a=1800s i=0s n=1',
      ];
      expect(lines(ok(await report(ana, ws, '2026-10-21', 'UTC', { ...day, projectId: projectR })), projects)).toEqual(render);
      expect(lines(ok(await report(ana, ws, '2026-10-21', 'UTC', { ...day, applicationId: 'blender' })), projects)).toEqual(
        render,
      );
      // Unattributed: raw 3600 + 2700 + 1200 = 7500 s, counted 6000 s.
      expect(lines(ok(await report(ana, ws, '2026-10-21', 'UTC', { ...day, unattributed: true })), projects)).toEqual([
        'total a=3600s i=2400s n=3 overlap=1500s teammates=false',
        'period 2026-10-21 a=3600s i=2400s n=3',
        'member ana a=3600s i=2400s n=3',
        'project (unattributed) a=3600s i=2400s n=3',
        'task -/- a=3600s i=2400s n=3',
        'application figma "Figma" a=3600s i=600s n=2',
        'application photoshop "Photoshop" a=0s i=1800s n=1',
      ]);
      expect(
        lines(ok(await report(ana, ws, '2026-10-21', 'UTC', { ...day, applicationId: 'photoshop' })), projects)[0],
      ).toBe('total a=0s i=1800s n=1 overlap=900s teammates=false');
      // The filtered totals are exactly the unfiltered project rows.
      expect(UNFILTERED).toContain('project Render a=1800s i=0s n=1');
      expect(UNFILTERED).toContain('project (unattributed) a=3600s i=2400s n=3');
    });

    it('gives the unfiltered figures when the filter matches every row (each row is a seed)', async () => {
      const own = await createWorkspace(db(), ana, 'All seeds');
      await syncOk(db(), ana, own, [
        // Figma everywhere, no project. Device A: active 09:00-10:00, idle 10:20-11:00.
        span('2026-10-22T09:00:00Z', 60),
        span('2026-10-22T10:20:00Z', 40, { kind: 'idle' }),
        // Device B: active 09:30-10:30, so only 10:00-10:30 counts.
        span('2026-10-22T09:30:00Z', 60, { deviceId: SECOND_DEVICE }),
      ]);
      // Active 3600 + 1800 s; idle only 10:30-11:00 (1800 s). Raw 3600 + 2400 + 3600 = 9600 s,
      // counted 7200 s: overlap 2400 s.
      const all = [
        'total a=5400s i=1800s n=3 overlap=2400s teammates=false',
        'period 2026-10-22 a=5400s i=1800s n=3',
        'member ana a=5400s i=1800s n=3',
        'project (unattributed) a=5400s i=1800s n=3',
        'task -/- a=5400s i=1800s n=3',
        'application figma "Figma" a=5400s i=1800s n=3',
      ];
      const day = { from: '2026-10-22' };
      expect(lines(ok(await report(ana, own, '2026-10-22', 'UTC', day)), people)).toEqual(all);
      expect(lines(ok(await report(ana, own, '2026-10-22', 'UTC', { ...day, unattributed: true })), people)).toEqual(all);
      expect(lines(ok(await report(ana, own, '2026-10-22', 'UTC', { ...day, applicationId: 'figma' })), people)).toEqual(all);
    });

    it('gives the same result after the same batch is synced again', async () => {
      await syncOk(db(), ana, ws, batch);
      expect(lines(ok(await report(ana, ws, '2026-10-21', 'UTC', { from: '2026-10-21' })), projects)).toEqual(UNFILTERED);
    });
  });

  it('tells unattributed time from task time without a project; keeps archived and deleted-task time', async () => {
    const ws = await createWorkspace(db(), ana, 'Attribution');
    const P = '10000000-0000-4000-8000-000000000001';
    const Q = '20000000-0000-4000-8000-000000000002';
    const [T1, T2, T3, T4, T5] = [1, 2, 3, 4, 5].map((k) => `30000000-0000-4000-8000-00000000000${k}`);
    await insertProject(ana, ws, P, 'Brand');
    await insertProject(ana, ws, Q, 'Web');
    await insertTask(ana, ws, T1!, 'Logo', P);
    await insertTask(ana, ws, T2!, 'Palette', P);
    await insertTask(ana, ws, T3!, 'Admin', null);
    await insertTask(ana, ws, T4!, 'Landing', Q);
    await insertTask(ana, ws, T5!, 'Sketch', P);
    const labels = { ...people, [P]: 'Brand', [Q]: 'Web', [T1!]: 'Logo', [T2!]: 'Palette', [T3!]: 'Admin', [T4!]: 'Landing', [T5!]: 'Sketch' };
    await syncOk(db(), ana, ws, [
      span('2026-10-22T09:00:00Z', 10), // unattributed
      span('2026-10-22T09:20:00Z', 15, { taskId: T3 }), // a task without a project
      span('2026-10-22T10:00:00Z', 30, { projectId: P }),
      span('2026-10-22T11:00:00Z', 20, { taskId: T1 }), // the task decides the project (Brand)
      span('2026-10-22T12:00:00Z', 5, { taskId: T2 }),
      span('2026-10-22T13:00:00Z', 40, { taskId: T4 }), // Web
      span('2026-10-22T14:00:00Z', 5, { taskId: T5 }),
    ]);
    // Archive Web and its task after the time was recorded.
    ok(await db().query(ana, `update public.tasks set status = 'archived' where id = $1`, [T4]));
    ok(await db().query(ana, `update public.projects set status = 'archived' where id = $1`, [Q]));
    // A task with tracked time cannot be deleted through the API (it is archived instead); the
    // foreign key still nulls task_id should one go, which is simulated here as superuser.
    fails(await db().query(ana, `delete from public.tasks where id = $1`, [T5]), '23503', /archive it instead/);
    await db().admin(`alter table public.tasks disable trigger tasks_delete_guard`);
    await db().admin(`delete from public.tasks where id = $1`, [T5]);
    await db().admin(`alter table public.tasks enable trigger tasks_delete_guard`);

    const day = { from: '2026-10-22' };
    expect(lines(ok(await report(ana, ws, '2026-10-22', 'UTC', day)), labels)).toEqual([
      'total a=7500s i=0s n=7 overlap=0s teammates=false',
      'period 2026-10-22 a=7500s i=0s n=7',
      'member ana a=7500s i=0s n=7',
      'project Brand a=3600s i=0s n=4',
      'project Web a=2400s i=0s n=1',
      'project (no project) a=900s i=0s n=1',
      'project (unattributed) a=600s i=0s n=1',
      'task Brand/Logo a=1200s i=0s n=1',
      'task Brand/Palette a=300s i=0s n=1',
      'task Brand/- a=2100s i=0s n=2',
      'task Web/Landing a=2400s i=0s n=1',
      'task -/Admin a=900s i=0s n=1',
      'task -/- a=600s i=0s n=1',
      'application figma "Figma" a=7500s i=0s n=7',
    ]);
    expect(lines(ok(await report(ana, ws, '2026-10-22', 'UTC', { ...day, projectId: P })), labels)).toEqual([
      'total a=3600s i=0s n=4 overlap=0s teammates=false',
      'period 2026-10-22 a=3600s i=0s n=4',
      'member ana a=3600s i=0s n=4',
      'project Brand a=3600s i=0s n=4',
      'task Brand/Logo a=1200s i=0s n=1',
      'task Brand/Palette a=300s i=0s n=1',
      'task Brand/- a=2100s i=0s n=2',
      'application figma "Figma" a=3600s i=0s n=4',
    ]);
    expect(lines(ok(await report(ana, ws, '2026-10-22', 'UTC', { ...day, projectId: Q })), labels)).toEqual([
      'total a=2400s i=0s n=1 overlap=0s teammates=false',
      'period 2026-10-22 a=2400s i=0s n=1',
      'member ana a=2400s i=0s n=1',
      'project Web a=2400s i=0s n=1',
      'task Web/Landing a=2400s i=0s n=1',
      'application figma "Figma" a=2400s i=0s n=1',
    ]);
    // Unattributed means no project and no task: the Admin task's time is not in it.
    expect(lines(ok(await report(ana, ws, '2026-10-22', 'UTC', { ...day, unattributed: true })), labels)).toEqual([
      'total a=600s i=0s n=1 overlap=0s teammates=false',
      'period 2026-10-22 a=600s i=0s n=1',
      'member ana a=600s i=0s n=1',
      'project (unattributed) a=600s i=0s n=1',
      'task -/- a=600s i=0s n=1',
      'application figma "Figma" a=600s i=0s n=1',
    ]);
  });

  it('clips entries at the edges of the range', async () => {
    const ws = await createWorkspace(db(), ana, 'Edges');
    await syncOk(db(), ana, ws, [
      span('2026-10-09T10:00:00Z', 10), // before the range
      span('2026-10-09T23:50:00Z', 30), // 20 minutes inside
      span('2026-10-11T23:55:00Z', 10), // 5 minutes inside
      span('2026-10-12T10:00:00Z', 10), // after the range
    ]);
    expect(lines(ok(await report(ana, ws, '2026-10-11', 'UTC', { from: '2026-10-10' })), people)).toEqual([
      'total a=1500s i=0s n=2 overlap=0s teammates=false',
      'period 2026-10-10 a=1200s i=0s n=1',
      'period 2026-10-11 a=300s i=0s n=1',
      'member ana a=1500s i=0s n=2',
      'project (unattributed) a=1500s i=0s n=2',
      'task -/- a=1500s i=0s n=2',
      'application figma "Figma" a=1500s i=0s n=2',
    ]);
  });

  it('uses local days of a zone with daylight saving time', async () => {
    const ws = await createWorkspace(db(), ana, 'Zones');
    await syncOk(db(), ana, ws, [
      span('2026-10-24T21:30:00Z', 60), // Berlin 23:30 CEST on the 24th to 00:30 on the 25th
      span('2026-10-25T00:30:00Z', 60), // Berlin 02:30 CEST to 02:30 CET (clocks go back)
      span('2026-10-25T22:45:00Z', 60), // Berlin 23:45 CET on the 25th to 00:45 on the 26th
      span('2026-11-01T03:50:00Z', 20), // Havana 23:50 on 31 October to 00:10 on 1 November (first midnight)
    ]);
    // In Berlin, 25 October lasts 25 hours: 22:00Z on the 24th to 23:00Z on the 25th.
    expect(
      lines(ok(await report(ana, ws, '2026-10-26', 'Europe/Berlin', { from: '2026-10-24' })), people).slice(0, 4),
    ).toEqual([
      'total a=10800s i=0s n=3 overlap=0s teammates=false',
      'period 2026-10-24 a=1800s i=0s n=1',
      'period 2026-10-25 a=6300s i=0s n=3',
      'period 2026-10-26 a=2700s i=0s n=1',
    ]);
    expect(lines(ok(await report(ana, ws, '2026-10-25', 'UTC', { from: '2026-10-25' })), people)[0]).toBe(
      'total a=7200s i=0s n=2 overlap=0s teammates=false',
    );
    // Havana repeats midnight on 1 November: the day starts at the first one (04:00Z).
    expect(
      lines(ok(await report(ana, ws, '2026-11-01', 'America/Havana', { from: '2026-10-31' })), people).slice(0, 3),
    ).toEqual([
      'total a=1200s i=0s n=1 overlap=0s teammates=false',
      'period 2026-10-31 a=600s i=0s n=1',
      'period 2026-11-01 a=600s i=0s n=1',
    ]);
  });

  it('starts at the local day of the first entry in scope when no first day is given', async () => {
    const ws = await createWorkspace(db(), ana, 'From');
    const projectId = await createProject(db(), ana, ws, 'Launch');
    const labels = { ...people, [projectId]: 'Launch' };
    await syncOk(db(), ana, ws, [
      span('2026-10-05T02:00:00Z', 30), // New York: 22:00 on 4 October
      span('2026-10-20T15:00:00Z', 10, { projectId }),
    ]);
    expect(lines(ok(await report(ana, ws, '2026-10-20', 'America/New_York')), labels).slice(0, 3)).toEqual([
      'total a=2400s i=0s n=2 overlap=0s teammates=false',
      'period 2026-10-04 a=1800s i=0s n=1',
      'period 2026-10-20 a=600s i=0s n=1',
    ]);
    expect(lines(ok(await report(ana, ws, '2026-10-20', 'UTC', { from: null })), labels).slice(0, 3)).toEqual([
      'total a=2400s i=0s n=2 overlap=0s teammates=false',
      'period 2026-10-05 a=1800s i=0s n=1',
      'period 2026-10-20 a=600s i=0s n=1',
    ]);
    // After the filters: the project's first entry is on the 20th.
    expect(lines(ok(await report(ana, ws, '2026-10-20', 'UTC', { projectId })), labels).slice(0, 2)).toEqual([
      'total a=600s i=0s n=1 overlap=0s teammates=false',
      'period 2026-10-20 a=600s i=0s n=1',
    ]);

    // An older project entry: the span limits apply to the resolved range.
    await syncOk(db(), ana, ws, [span('2025-01-10T12:00:00Z', 10, { projectId })]);
    fails(await report(ana, ws, '2026-10-20', 'UTC'), '22023', /^a report covers at most 366 days$/);
    fails(
      await report(ana, ws, '2026-10-20', 'UTC', { projectId }),
      '22023',
      /^a project report by day covers at most 366 days$/,
    );
    expect(lines(ok(await report(ana, ws, '2026-10-20', 'UTC', { projectId, bucket: 'week' })), labels).slice(0, 3)).toEqual([
      'total a=1200s i=0s n=2 overlap=0s teammates=false',
      'period 2025-01-06 a=600s i=0s n=1',
      'period 2026-10-19 a=600s i=0s n=1',
    ]);
    expect(lines(ok(await report(ana, ws, '2026-10-20', 'UTC', { unattributed: true })), labels).slice(0, 2)).toEqual([
      'total a=1800s i=0s n=1 overlap=0s teammates=false',
      'period 2026-10-05 a=1800s i=0s n=1',
    ]);

    // Nothing in scope: just the last day, and a zero total.
    const empty = await createWorkspace(db(), ana, 'Empty');
    expect(lines(ok(await report(ana, empty, '2026-10-20', 'UTC')), labels)).toEqual([ZERO_TOTAL_PRIVATE]);
  });

  it('orders rows: one total, then periods, members, projects, tasks, applications (code points)', async () => {
    const ws = await createWorkspace(db(), ana, 'Order');
    const ben = await newUser(db(), 'ben');
    const cleo = await newUser(db(), 'cleo');
    await addMember(db(), ana, ws, ben, 'member');
    await addMember(db(), ana, ws, cleo, 'admin');
    ok(await setVisibility(db(), ana, ws, 'admins'));
    await syncOk(db(), ana, ws, [
      span('2026-10-23T09:00:00Z', 10, { applicationId: 'figma', applicationName: 'Figma' }),
      span('2026-10-24T09:00:00Z', 10, { applicationId: 'ab', applicationName: 'AB' }),
    ]);
    await syncOk(db(), ben, ws, [span('2026-10-23T10:00:00Z', 10, { applicationId: 'a-z', applicationName: 'A to Z' })]);
    await syncOk(db(), cleo, ws, [span('2026-10-24T10:00:00Z', 10, { applicationId: '3ds-max', applicationName: '3ds Max' })]);

    const rows = ok(await report(ana, ws, '2026-10-24', 'UTC', { from: '2026-10-23' }));
    const label = { [ana.id]: 'ana', [ben.id]: 'ben', [cleo.id]: 'cleo' };
    expect(lines(rows, label)).toEqual([
      'total a=2400s i=0s n=4 overlap=0s teammates=true',
      'period 2026-10-23 a=1200s i=0s n=2',
      'period 2026-10-24 a=1200s i=0s n=2',
      ...byId([
        { id: ana.id, line: 'member ana a=1200s i=0s n=2' },
        { id: ben.id, line: 'member ben a=600s i=0s n=1' },
        { id: cleo.id, line: 'member cleo a=600s i=0s n=1' },
      ]).map((member) => member.line),
      'project (unattributed) a=2400s i=0s n=4',
      'task -/- a=2400s i=0s n=4',
      // Code-point order ('-' before 'b'). PGlite's database collation is C, so this order cannot
      // detect a missing `collate "C"`; the function-properties test pins the clause.
      'application 3ds-max "3ds Max" a=600s i=0s n=1',
      'application a-z "A to Z" a=600s i=0s n=1',
      'application ab "AB" a=600s i=0s n=1',
      'application figma "Figma" a=600s i=0s n=1',
    ]);
    expect(rows.filter((row) => row.dimension === 'total')).toHaveLength(1);
  });
});
