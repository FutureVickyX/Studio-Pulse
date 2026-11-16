import { describe, expect, it, vi } from 'vitest';

import type { StudioPulseClient } from '@studio-pulse/database';

import {
  MAX_SESSION_MS,
  MY_SESSIONS_EXPORT_MAX,
  MY_SESSION_COLUMNS,
  PAGE_ROWS,
  analyticsSummary,
  listAllMySessions,
  listMySessions,
  listMySessionsForExport,
  reportArgs,
  reportReadAt,
  toReportRow,
} from '../../../apps/web/src/lib/api';
import type { AnalyticsSummaryParams, MySession, MySessionsQuery } from '../../../apps/web/src/lib/api';
import { ProblemError, REPORT_NEEDS_MIGRATION, REPORT_TOO_SLOW } from '../../../apps/web/src/lib/errors';

const WS = '0190a7f0-1111-7000-8000-00000000abcd';
const ME = '0190a7f0-2222-7000-8000-000000000001';
const YOU = '0190a7f0-2222-7000-8000-000000000002';
const PROJECT = '0190a7f0-3333-7000-8000-000000000001';

const idOf = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

// ---------------------------------------------------------------------------------------------
// analytics_time_summary
// ---------------------------------------------------------------------------------------------

describe('reportArgs: the report function is called with only the arguments that are set', () => {
  const required: AnalyticsSummaryParams = { workspaceId: WS, toDay: '2026-11-12', timeZone: 'Europe/London' };

  it('maps the required names to p_*', () => {
    expect(reportArgs(required)).toEqual({ p_workspace_id: WS, p_to: '2026-11-12', p_time_zone: 'Europe/London' });
  });

  it('leaves out optional arguments that are null or undefined (the database defaults apply)', () => {
    const args = reportArgs({
      ...required,
      fromDay: null,
      bucket: null,
      userIds: null,
      projectId: null,
      unattributed: null,
      applicationId: null,
    });
    expect(Object.keys(args).sort()).toEqual(['p_time_zone', 'p_to', 'p_workspace_id']);
    const undefinedOnes = reportArgs({
      ...required,
      fromDay: undefined,
      bucket: undefined,
      userIds: undefined,
      projectId: undefined,
      unattributed: undefined,
      applicationId: undefined,
    });
    // Not even as keys: JSON would drop undefined, but a key with null would name the argument.
    expect(Object.keys(undefinedOnes).sort()).toEqual(['p_time_zone', 'p_to', 'p_workspace_id']);
    expect(JSON.parse(JSON.stringify(undefinedOnes))).toEqual(reportArgs(required));
  });

  it('maps every optional argument when it is set', () => {
    const userIds = [ME, YOU] as const;
    const args = reportArgs({
      ...required,
      fromDay: '2026-11-06',
      bucket: 'week',
      userIds,
      projectId: PROJECT,
      unattributed: false,
      applicationId: 'adobe-photoshop',
    });
    expect(args).toEqual({
      p_workspace_id: WS,
      p_to: '2026-11-12',
      p_time_zone: 'Europe/London',
      p_from: '2026-11-06',
      p_bucket: 'week',
      p_user_ids: [ME, YOU],
      p_project_id: PROJECT,
      p_unattributed: false,
      p_application_id: 'adobe-photoshop',
    });
    expect(args.p_user_ids).not.toBe(userIds); // a copy: the caller's list is never handed on
  });

  it('keeps values that are set but falsy: false, and an empty list of people', () => {
    expect(reportArgs({ ...required, unattributed: false })).toHaveProperty('p_unattributed', false);
    expect(reportArgs({ ...required, unattributed: true })).toHaveProperty('p_unattributed', true);
    // An empty list means "nobody". Dropping it would ask for everyone the caller can read.
    expect(reportArgs({ ...required, userIds: [] })).toHaveProperty('p_user_ids', []);
  });
});

describe('toReportRow', () => {
  it('maps a database row to the engine’s camelCase row', () => {
    expect(
      toReportRow({
        dimension: 'application',
        bucket_start: null,
        user_id: null,
        application_id: 'adobe-photoshop',
        application_name: 'Adobe Photoshop',
        project_id: null,
        task_id: null,
        unattributed: null,
        active_ms: 5_400_000,
        idle_ms: 600_000,
        entry_count: 4,
        overlap_ms: 0,
        teammates_visible: null,
      }),
    ).toEqual({
      dimension: 'application',
      bucketStart: null,
      userId: null,
      applicationId: 'adobe-photoshop',
      applicationName: 'Adobe Photoshop',
      projectId: null,
      taskId: null,
      unattributed: null,
      activeMs: 5_400_000,
      idleMs: 600_000,
      entryCount: 4,
      overlapMs: 0,
      teammatesVisible: null,
    });
  });

  it('reads a bigint sent as a string as a number', () => {
    const row = toReportRow({
      dimension: 'total',
      bucket_start: null,
      user_id: null,
      application_id: null,
      application_name: null,
      project_id: null,
      task_id: null,
      unattributed: null,
      active_ms: '7200000' as unknown as number,
      idle_ms: '0' as unknown as number,
      entry_count: '12' as unknown as number,
      overlap_ms: '1500' as unknown as number,
      teammates_visible: true,
    });
    expect(row).toMatchObject({ activeMs: 7_200_000, idleMs: 0, entryCount: 12, overlapMs: 1_500, teammatesVisible: true });
  });
});

describe('analyticsSummary: every row of the report, page by page', () => {
  type Record_ = Parameters<typeof toReportRow>[0];

  const taskRow = (i: number): Record_ => ({
    dimension: 'task',
    bucket_start: null,
    user_id: null,
    application_id: null,
    application_name: null,
    project_id: PROJECT,
    task_id: idOf(i),
    unattributed: false,
    active_ms: 60_000 * (i + 1),
    idle_ms: 1_000,
    entry_count: 1,
    overlap_ms: 0,
    teammates_visible: null,
  });
  const totalRow: Record_ = {
    dimension: 'total',
    bucket_start: null,
    user_id: null,
    application_id: null,
    application_name: null,
    project_id: null,
    task_id: null,
    unattributed: null,
    active_ms: 1,
    idle_ms: 2,
    entry_count: 3,
    overlap_ms: 4,
    teammates_visible: false,
  };

  /**
   * The function behind a server that returns at most 1,000 rows per request. `errorAt` makes the
   * n-th request (from 1) fail with that error.
   */
  function reporting(rows: readonly Record_[], errorAt?: { request: number; error: unknown }) {
    const calls = { names: [] as string[], args: [] as unknown[], ranges: [] as [number, number][] };
    const rpc = (name: string, args: unknown) => ({
      range: async (from: number, to: number) => {
        calls.names.push(name);
        calls.args.push(args);
        calls.ranges.push([from, to]);
        if (errorAt && calls.ranges.length === errorAt.request) return { data: null, error: errorAt.error };
        return { data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null };
      },
    });
    return { client: { rpc } as unknown as StudioPulseClient, calls };
  }
  const params: AnalyticsSummaryParams = {
    workspaceId: WS,
    toDay: '2026-11-12',
    timeZone: 'America/Los_Angeles',
    fromDay: '2026-10-14',
    userIds: [ME],
    projectId: null,
  };

  it('reads more than 1,000 rows with .range() until a short page, and maps them', async () => {
    const records = [totalRow, ...Array.from({ length: 2_299 }, (_, i) => taskRow(i))];
    const { client, calls } = reporting(records);
    const rows = await analyticsSummary(client, params);

    expect(rows).toHaveLength(2_300);
    expect(calls.ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    // Every page asks the same function for the same report, naming only the arguments set.
    expect(new Set(calls.names)).toEqual(new Set(['analytics_time_summary']));
    for (const args of calls.args) {
      expect(args).toEqual({
        p_workspace_id: WS,
        p_to: '2026-11-12',
        p_time_zone: 'America/Los_Angeles',
        p_from: '2026-10-14',
        p_user_ids: [ME],
      });
    }
    // In the server's order, camelCase.
    expect(rows[0]).toEqual({
      dimension: 'total',
      bucketStart: null,
      userId: null,
      applicationId: null,
      applicationName: null,
      projectId: null,
      taskId: null,
      unattributed: null,
      activeMs: 1,
      idleMs: 2,
      entryCount: 3,
      overlapMs: 4,
      teammatesVisible: false,
    });
    expect(rows[1]).toMatchObject({ dimension: 'task', projectId: PROJECT, taskId: idOf(0), activeMs: 60_000, unattributed: false });
    expect(rows[2_299]).toMatchObject({ taskId: idOf(2_298), activeMs: 60_000 * 2_299 });
    expect(new Set(rows.map((row) => row.taskId)).size).toBe(2_300); // 2,299 tasks and the total's null
  });

  it('a result of exactly one full page is followed by one more request, which is empty', async () => {
    const { client, calls } = reporting(Array.from({ length: PAGE_ROWS }, (_, i) => taskRow(i)));
    expect(await analyticsSummary(client, params)).toHaveLength(1_000);
    expect(calls.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('a short first page is the whole report: one request', async () => {
    const { client, calls } = reporting([totalRow]);
    expect(await analyticsSummary(client, params)).toHaveLength(1);
    expect(calls.ranges).toEqual([[0, 999]]);
  });

  it('rows that look alike are all kept (report rows have no id to tell a repeat by)', async () => {
    const { client } = reporting([taskRow(1), taskRow(1), taskRow(1)]);
    expect(await analyticsSummary(client, params)).toHaveLength(3);
  });

  it('explains a timeout and a database without the function', async () => {
    const slow = reporting([], { request: 1, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const timeout = await analyticsSummary(slow.client, params).catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(ProblemError);
    expect((timeout as ProblemError).problem).toMatchObject({ message: REPORT_TOO_SLOW, code: '57014' });

    const old = reporting([], {
      request: 1,
      error: { code: 'PGRST202', message: 'Could not find the function public.analytics_time_summary in the schema cache' },
    });
    const missing = await analyticsSummary(old.client, params).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ProblemError);
    expect((missing as ProblemError).problem).toMatchObject({ message: REPORT_NEEDS_MIGRATION, code: 'PGRST202' });
  });

  it('tags the rows with when they were read, whichever page asked (Analytics or Project Insights)', async () => {
    const readAt = Date.parse('2026-11-12T15:04:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(readAt);
    try {
      const rows = await analyticsSummary(reporting([totalRow]).client, params);
      // The tag travels with the cached rows themselves, so "Updated HH:MM" is true on any page.
      expect(reportReadAt(rows)).toBe(readAt);
      expect(reportReadAt([...rows])).toBeNull(); // rows it did not return have no read time
      expect(reportReadAt([])).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('passes the function’s own refusal through, and a failure on a later page fails the whole read', async () => {
    const refused = reporting([], { request: 1, error: { code: '22023', message: 'unknown time zone' } });
    const zone = await analyticsSummary(refused.client, params).catch((e: unknown) => e);
    expect((zone as ProblemError).problem).toEqual({ kind: 'invalid', message: 'Unknown time zone.', code: '22023' });

    const later = reporting(
      Array.from({ length: 1_500 }, (_, i) => taskRow(i)),
      { request: 2, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    );
    const error = await analyticsSummary(later.client, params).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError); // never the first 1,000 rows as if they were all
    expect((error as ProblemError).problem.message).toBe(REPORT_TOO_SLOW);
    expect(later.calls.ranges).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// My sessions
// ---------------------------------------------------------------------------------------------

type Call = [method: string, ...args: unknown[]];

/** A query builder that records what is chained on it and answers with `result` when awaited. */
function recording(result: { data: unknown; error: unknown } = { data: [], error: null }) {
  const calls: Call[] = [];
  const tables: string[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'lt', 'gt', 'gte', 'is', 'or', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  builder.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  const client = {
    from: (table: string) => {
      tables.push(table);
      return builder;
    },
  } as unknown as StudioPulseClient;
  const of = (method: string) => calls.filter(([name]) => name === method).map(([, ...args]) => args);
  return { client, calls, tables, of };
}

const RANGE: MySessionsQuery = {
  workspaceId: WS,
  userId: ME,
  startIso: '2026-11-06T08:00:00.000Z',
  endIso: '2026-11-13T08:00:00.000Z',
};

describe('listMySessions: one page of the caller’s own sessions', () => {
  it('asks only for the caller’s sessions that overlap the range, newest first', async () => {
    const { client, tables, of } = recording();
    await listMySessions(client, { ...RANGE, limit: 50 });

    expect(tables).toEqual(['time_entries']);
    expect(of('select')).toEqual([[MY_SESSION_COLUMNS]]);
    expect(MY_SESSION_COLUMNS).toBe('id, started_at, ended_at, application_id, application_name, kind, active_ms, idle_ms, project_id, task_id');
    // user_id = me, in this workspace: never anyone else's sessions, whatever the caller may read.
    expect(of('eq')).toEqual([
      ['workspace_id', WS],
      ['user_id', ME],
    ]);
    // Overlap: started before the end and ended after the start …
    expect(of('lt')).toEqual([['started_at', '2026-11-13T08:00:00.000Z']]);
    expect(of('gt')).toEqual([['ended_at', '2026-11-06T08:00:00.000Z']]);
    // … and started at most 744 h (the longest session there can be) before the start.
    expect(MAX_SESSION_MS).toBe(744 * 60 * 60 * 1000);
    expect(of('gte')).toEqual([['started_at', '2026-10-06T08:00:00.000Z']]);
    expect(of('order')).toEqual([
      ['started_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(of('limit')).toEqual([[50]]);
    // First page, every session: no keyset filter and no attribution filter.
    expect(of('or')).toEqual([]);
    expect(of('is')).toEqual([]);
  });

  it('reads the lower bound from any ISO instant (an offset, not only Z)', async () => {
    const { client, of } = recording();
    await listMySessions(client, { ...RANGE, startIso: '2026-11-06T00:00:00-08:00', limit: 10 });
    expect(of('gt')).toEqual([['ended_at', '2026-11-06T00:00:00-08:00']]);
    expect(of('gte')).toEqual([['started_at', '2026-10-06T08:00:00.000Z']]);
  });

  it('continues after the previous page’s last session: (started_at, id) below it', async () => {
    const { client, of } = recording();
    const last = { startedAt: '2026-11-09T10:15:00.123456+00:00', id: idOf(42) };
    await listMySessions(client, { ...RANGE, before: last, limit: 50 });
    // The values are quoted (they hold `:`, `.` and `+`) and used exactly as returned, microseconds included.
    expect(of('or')).toEqual([
      [
        `started_at.lt."2026-11-09T10:15:00.123456+00:00",and(started_at.eq."2026-11-09T10:15:00.123456+00:00",id.lt."${idOf(42)}")`,
      ],
    ]);
    // The range filters stay: a later page is still only the caller's sessions in the range.
    expect(of('eq')).toEqual([
      ['workspace_id', WS],
      ['user_id', ME],
    ]);
    expect(of('lt')).toEqual([['started_at', RANGE.endIso]]);
    expect(of('gt')).toEqual([['ended_at', RANGE.startIso]]);

    const first = recording();
    await listMySessions(first.client, { ...RANGE, before: null, limit: 50 });
    expect(first.of('or')).toEqual([]);
  });

  it('a quote or backslash in a keyset value cannot end the quoted value', async () => {
    const { client, of } = recording();
    await listMySessions(client, { ...RANGE, before: { startedAt: 'a"b\\c', id: 'x",id.gt."' }, limit: 5 });
    expect(of('or')).toEqual([['started_at.lt."a\\"b\\\\c",and(started_at.eq."a\\"b\\\\c",id.lt."x\\",id.gt.\\"")']]);
  });

  it('unattributedOnly asks for sessions with no project and no task', async () => {
    const { client, of } = recording();
    await listMySessions(client, { ...RANGE, unattributedOnly: true, limit: 50 });
    expect(of('is')).toEqual([
      ['project_id', null],
      ['task_id', null],
    ]);
    const all = recording();
    await listMySessions(all.client, { ...RANGE, unattributedOnly: false, limit: 50 });
    expect(all.of('is')).toEqual([]);
  });

  it('applies the page’s Project and Application filters as the report does (plain column checks)', async () => {
    const { client, of } = recording();
    await listMySessions(client, { ...RANGE, projectId: PROJECT, applicationId: 'figma', limit: 20 });
    expect(of('eq')).toEqual([
      ['workspace_id', WS],
      ['user_id', ME],
      ['project_id', PROJECT],
      ['application_id', 'figma'],
    ]);
    expect(of('is')).toEqual([]);

    // The page's Unattributed filter with an application: no project, no task, that application.
    const unattributed = recording();
    await listMySessions(unattributed.client, { ...RANGE, unattributedOnly: true, applicationId: 'figma', limit: 20 });
    expect(unattributed.of('eq')).toEqual([
      ['workspace_id', WS],
      ['user_id', ME],
      ['application_id', 'figma'],
    ]);
    expect(unattributed.of('is')).toEqual([
      ['project_id', null],
      ['task_id', null],
    ]);
  });

  it('keeps the page size between 1 and the server’s 1,000 rows', async () => {
    const sizes: unknown[] = [];
    for (const limit of [0, -3, 1, 25.9, 1_000, 5_000]) {
      const { client, of } = recording();
      await listMySessions(client, { ...RANGE, limit });
      sizes.push(of('limit')[0]?.[0]);
    }
    expect(sizes).toEqual([1, 1, 1, 25, 1_000, 1_000]);
  });

  it('returns the rows, and fails with a problem on an error', async () => {
    const session: MySession = {
      id: idOf(1),
      started_at: '2026-11-09T10:00:00+00:00',
      ended_at: '2026-11-09T11:00:00+00:00',
      application_id: 'figma',
      application_name: 'Figma',
      kind: 'active',
      active_ms: 3_000_000,
      idle_ms: 600_000,
      project_id: null,
      task_id: null,
    };
    expect(await listMySessions(recording({ data: [session], error: null }).client, { ...RANGE, limit: 50 })).toEqual([session]);
    expect(await listMySessions(recording({ data: null, error: null }).client, { ...RANGE, limit: 50 })).toEqual([]);

    const denied = recording({ data: null, error: { code: '42501', message: 'permission denied for table time_entries' } });
    const error = await listMySessions(denied.client, { ...RANGE, limit: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).problem.kind).toBe('permission');
  });
});

describe('my sessions, page after page (keyset)', () => {
  type Row = Record<string, string | number | null>;

  /**
   * A tiny PostgREST over time_entries: it applies the filters it is sent (the keyset `or` filter
   * included), sorts as asked and returns at most `limit` and at most 1,000 rows per request.
   */
  function server(rows: readonly Row[]) {
    const requests: { or: string | null; limit: number }[] = [];
    const from = () => {
      const filters: ((row: Row) => boolean)[] = [];
      const order: [string, boolean][] = [];
      let limit = Infinity;
      let or: string | null = null;
      const text = (value: unknown) => String(value);
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        lt: (column: string, value: unknown) => (filters.push((row) => text(row[column]) < text(value)), builder),
        gt: (column: string, value: unknown) => (filters.push((row) => text(row[column]) > text(value)), builder),
        gte: (column: string, value: unknown) => (filters.push((row) => text(row[column]) >= text(value)), builder),
        is: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        or: (expression: string) => {
          const match = /^started_at\.lt\."([^"]*)",and\(started_at\.eq\."([^"]*)",id\.lt\."([^"]*)"\)$/.exec(expression);
          if (!match) throw new Error(`unexpected or filter: ${expression}`);
          const [, below, same, id] = match;
          or = expression;
          filters.push((row) => text(row.started_at) < text(below) || (row.started_at === same && text(row.id) < text(id)));
          return builder;
        },
        order: (column: string, options?: { ascending?: boolean }) => (order.push([column, options?.ascending ?? true]), builder),
        limit: (count: number) => ((limit = count), builder),
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
          const matching = rows.filter((row) => filters.every((keep) => keep(row)));
          matching.sort((a, b) => {
            for (const [column, ascending] of order) {
              const left = text(a[column]);
              const right = text(b[column]);
              if (left !== right) return (left < right ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          });
          requests.push({ or, limit });
          return Promise.resolve({ data: matching.slice(0, Math.min(limit, 1000)), error: null }).then(resolve, reject);
        },
      };
      return builder;
    };
    return { client: { from } as unknown as StudioPulseClient, requests };
  }

  const START = Date.parse(RANGE.startIso);
  const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
  /** A one-hour session of `userId` starting `minutes` after the range start. */
  const session = (i: number, minutes: number, more: Row = {}): Row => ({
    id: idOf(i),
    workspace_id: WS,
    user_id: ME,
    started_at: at(minutes),
    ended_at: at(minutes + 60),
    project_id: null,
    task_id: null,
    ...more,
  });
  const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

  it('reads 2,500 sessions once each, newest first, also where many start at the same instant', async () => {
    // Four sessions share every start time, so both page boundaries fall inside a run of ties.
    const mine = Array.from({ length: 2_500 }, (_, i) => session(i, Math.floor(i / 4)));
    const { client, requests } = server(mine);
    const { sessions, truncated } = await listAllMySessions(client, RANGE, 10_000);

    expect(truncated).toBe(false);
    expect(sessions).toHaveLength(2_500);
    expect(new Set(ids(sessions)).size).toBe(2_500);
    expect(ids(sessions)).toEqual(Array.from({ length: 2_500 }, (_, i) => idOf(2_499 - i))); // started_at desc, id desc
    expect(requests.map((request) => request.limit)).toEqual([1_000, 1_000, 1_000]);
    expect(requests[0]?.or).toBeNull();
    expect(requests[1]?.or).toBe(`started_at.lt."${at(375)}",and(started_at.eq."${at(375)}",id.lt."${idOf(1_500)}")`);
  });

  it('returns only the caller’s sessions that overlap the range', async () => {
    const rows: Row[] = [
      session(1, 10), // inside
      session(2, -30), // began before the range, ends inside it
      session(3, -60), // ended exactly at the start: not in the range
      session(4, 7 * 24 * 60 - 1), // begins a minute before the end
      session(5, 7 * 24 * 60), // begins exactly at the end: not in the range
      session(6, 10, { user_id: YOU }), // a teammate's
      session(7, 10, { workspace_id: idOf(999) }), // another workspace's
      { ...session(8, 0), started_at: at(-744 * 60), ended_at: at(1) }, // the longest session there can be
      { ...session(9, 0), started_at: at(-744 * 60 - 1), ended_at: at(-1) }, // older than the lower bound, and over
    ];
    const { sessions } = await listAllMySessions(server(rows).client, RANGE, 100);
    expect(ids(sessions)).toEqual([idOf(4), idOf(1), idOf(2), idOf(8)]);
  });

  it('unattributedOnly keeps sessions with neither a project nor a task', async () => {
    const rows: Row[] = [
      session(1, 10),
      session(2, 20, { project_id: PROJECT }),
      session(3, 30, { project_id: PROJECT, task_id: idOf(77) }),
      session(4, 40),
    ];
    const { sessions } = await listAllMySessions(server(rows).client, { ...RANGE, unattributedOnly: true }, 100);
    expect(ids(sessions)).toEqual([idOf(4), idOf(1)]);
  });

  it('a project and an application filter keep only the matching sessions, on every page', async () => {
    const rows: Row[] = [
      session(1, 10, { project_id: PROJECT, application_id: 'figma' }),
      session(2, 20, { project_id: PROJECT, application_id: 'photoshop' }),
      session(3, 30, { project_id: idOf(500), application_id: 'figma' }),
      session(4, 40, { application_id: 'figma' }),
      session(5, 50, { project_id: PROJECT, task_id: idOf(77), application_id: 'figma' }),
    ];
    const both = await listAllMySessions(server(rows).client, { ...RANGE, projectId: PROJECT, applicationId: 'figma' }, 100);
    expect(ids(both.sessions)).toEqual([idOf(5), idOf(1)]);
    const unattributedFigma = await listAllMySessions(server(rows).client, { ...RANGE, unattributedOnly: true, applicationId: 'figma' }, 100);
    expect(ids(unattributedFigma.sessions)).toEqual([idOf(4)]);
    // A project and "unattributed" together match nothing, as in the report.
    const neither = await listAllMySessions(server(rows).client, { ...RANGE, projectId: PROJECT, unattributedOnly: true }, 100);
    expect(neither.sessions).toEqual([]);
    // Many pages: the filters stay on each one.
    const many = Array.from({ length: 2_400 }, (_, i) => session(i, i, { application_id: i % 2 === 0 ? 'figma' : 'photoshop' }));
    const figma = await listAllMySessions(server(many).client, { ...RANGE, applicationId: 'figma' }, 10_000);
    expect(figma.sessions).toHaveLength(1_200);
    expect(ids(figma.sessions).slice(0, 2)).toEqual([idOf(2_398), idOf(2_396)]);
  });

  it('stops at max and says there were more; exactly max is not truncated', async () => {
    const mine = Array.from({ length: 2_500 }, (_, i) => session(i, i));
    const capped = server(mine);
    const more = await listAllMySessions(capped.client, RANGE, 2_000);
    expect(more.truncated).toBe(true);
    expect(more.sessions).toHaveLength(2_000);
    expect(ids(more.sessions).slice(0, 2)).toEqual([idOf(2_499), idOf(2_498)]);
    // One session past max is all it reads to know.
    expect(capped.requests.map((request) => request.limit)).toEqual([1_000, 1_000, 1]);

    const exact = server(mine);
    const all = await listAllMySessions(exact.client, RANGE, 2_500);
    expect(all.truncated).toBe(false);
    expect(all.sessions).toHaveLength(2_500);
    expect(exact.requests.map((request) => request.limit)).toEqual([1_000, 1_000, 501]);

    const few = server(mine.slice(0, 3));
    expect(await listAllMySessions(few.client, RANGE, 2)).toMatchObject({ truncated: true, sessions: [{ id: idOf(2) }, { id: idOf(1) }] });
    expect(await listAllMySessions(server([]).client, RANGE, 2)).toEqual({ sessions: [], truncated: false });
  });
});

describe('listMySessionsForExport: the whole range or a clear refusal', () => {
  /**
   * A range holding `total` sessions, served in pages without keeping them all: each request gets
   * the next `limit` (at most 1,000) rows, newest first.
   */
  function holding(total: number) {
    const requests: { or: string | null; limit: number }[] = [];
    let served = 0;
    const from = () => {
      let limit = 0;
      let or: string | null = null;
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'lt', 'gt', 'gte', 'is', 'order']) builder[method] = () => builder;
      builder.or = (expression: string) => ((or = expression), builder);
      builder.limit = (count: number) => ((limit = count), builder);
      builder.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
        requests.push({ or, limit });
        const size = Math.min(limit, 1000, total - served);
        const data = Array.from({ length: size }, (_, i) => {
          const n = total - served - i; // counts down: newest first
          return { id: idOf(n), started_at: `t${String(n).padStart(6, '0')}`, ended_at: 'later' };
        });
        served += size;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return builder;
    };
    return { client: { from } as unknown as StudioPulseClient, requests };
  }

  it('reads up to 50,000 sessions', async () => {
    expect(MY_SESSIONS_EXPORT_MAX).toBe(50_000);
    const { client, requests } = holding(50_000);
    const sessions = await listMySessionsForExport(client, RANGE);
    expect(sessions).toHaveLength(50_000);
    expect(sessions[0]?.id).toBe(idOf(50_000));
    expect(sessions[49_999]?.id).toBe(idOf(1));
    // 50 full pages, then one row asked for to see whether there is a 50,001st.
    expect(requests).toHaveLength(51);
    expect(requests[50]?.limit).toBe(1);
    // Each page continues after the last session of the one before.
    expect(requests[0]?.or).toBeNull();
    expect(requests[1]?.or).toBe(`started_at.lt."t049001",and(started_at.eq."t049001",id.lt."${idOf(49_001)}")`);
  });

  it('refuses a range with more than 50,000 sessions, in words', async () => {
    const { client, requests } = holding(120_000);
    const error = await listMySessionsForExport(client, RANGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).problem).toEqual({
      kind: 'invalid',
      message: 'This range has more than 50,000 sessions, too many for one export. Choose a shorter range.',
    });
    // It stops reading there: 50,001 sessions, not all 120,000.
    expect(requests).toHaveLength(51);
    expect(requests.reduce((sum, request) => sum + Math.min(request.limit, 1000), 0)).toBe(50_001);
  });

  it('a short range is returned whole', async () => {
    const { client, requests } = holding(3);
    expect((await listMySessionsForExport(client, RANGE)).map((row) => row.id)).toEqual([idOf(3), idOf(2), idOf(1)]);
    expect(requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Freshness: what a change invalidates
// ---------------------------------------------------------------------------------------------

const invalidate = vi.hoisted(() => vi.fn());
vi.mock('../../../apps/web/src/lib/store', async (original) => ({ ...(await original<object>()), invalidate }));

describe('refreshTable: analytics is cached under the workspace’s time keys', () => {
  it('a task change also refreshes time (moving a task moves its time), and time and "all" cover analytics', async () => {
    const { refreshTable } = await import('../../../apps/web/src/app/workspace');
    const { analyticsSummaryKey, mySessionsKey } = await import('../../../apps/web/src/lib/analytics');
    const summary = analyticsSummaryKey({ workspaceId: WS, toDay: '2026-11-12', timeZone: 'UTC' });
    const sessions = mySessionsKey(RANGE);
    expect(summary.startsWith(`ws:${WS}:time:analytics:`)).toBe(true);
    expect(sessions.startsWith(`ws:${WS}:time:analytics:`)).toBe(true);

    const prefixesFor = (table: Parameters<typeof refreshTable>[1]) => {
      invalidate.mockClear();
      refreshTable(WS, table);
      return invalidate.mock.calls.map(([prefix]) => String(prefix));
    };
    const covers = (prefixes: readonly string[], key: string) => prefixes.some((prefix) => key.startsWith(prefix));

    const tasks = prefixesFor('tasks');
    expect(tasks).toEqual([`ws:${WS}:tasks`, `ws:${WS}:time:`]);
    expect(covers(tasks, summary) && covers(tasks, sessions)).toBe(true);
    expect(covers(prefixesFor('time'), summary)).toBe(true);
    expect(covers(prefixesFor('all'), summary)).toBe(true);
    // Unrelated tables leave reports alone, and nothing reaches another workspace's keys.
    expect(covers(prefixesFor('notes'), summary)).toBe(false);
    expect(covers(prefixesFor('projects'), summary)).toBe(false);
    const other = analyticsSummaryKey({ workspaceId: idOf(5), toDay: '2026-11-12', timeZone: 'UTC' });
    expect(covers(prefixesFor('all'), other)).toBe(false);
  });
});
