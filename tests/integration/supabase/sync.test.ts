/**
 * sync_time_entries: the desktop's idempotent batch upload.
 *
 * Contract (supabase/migrations/20261017090200_time_entries.sql, docs/supabase.md §6):
 * - one result per entry, in input order: 'synced' (inserted now, or already present and owned by
 *   the caller) or 'rejected' (the entry itself is invalid, or its id belongs to someone else);
 * - anything else (not signed in, not an active member, malformed batch) fails the whole call and
 *   stores nothing, so the client keeps every entry pending;
 * - the server assigns user_id, workspace_id and source; the payload cannot choose them.
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorld,
  createProject,
  createTask,
  entry,
  fails,
  ok,
  removeMember,
  storedEntries,
  sync,
  syncOk,
  uuidv7,
  useDatabase,
  visibleIds,
} from './fixtures';
import type { EntryPayload, SyncResult } from './fixtures';
import type { Row } from './harness';

const db = useDatabase();

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** An interval with explicit bounds and a consistent split. */
function span(startIso: string, durationMs: number, extra: Partial<EntryPayload> & Record<string, unknown> = {}) {
  const start = Date.parse(startIso);
  return entry({
    id: uuidv7(start),
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + durationMs).toISOString(),
    activeMs: durationMs,
    idleMs: 0,
    ...extra,
  });
}

async function storedCount(ids: readonly string[]): Promise<number> {
  return (await storedEntries(db(), ids)).length;
}

describe('uploading', () => {
  it('stores each entry exactly as sent, as the caller, in the given workspace', async () => {
    const w = await buildWorld(db());
    const project = await createProject(db(), w.alice, w.wsA);
    const task = await createTask(db(), w.carol, w.wsA, { projectId: project });
    const active = entry();
    const idle = entry({
      applicationId: 'after-effects',
      applicationName: 'After Effects',
      kind: 'idle',
      activeMs: 0,
      idleMs: 5 * MINUTE,
      endReason: 'inputResumed',
      revision: 1,
    });
    const attributed = entry({ projectId: project, taskId: task, endReason: 'shutdown' });
    const batch = [active, idle, attributed];

    const results = ok(await sync(db(), w.carol, w.wsA, batch));
    expect(results).toEqual(batch.map((payload) => ({ entry_id: payload.id, status: 'synced', detail: null })));

    const rows = await storedEntries(db(), batch.map((payload) => payload.id));
    expect(rows).toHaveLength(3);
    for (const payload of batch) {
      const row = rows.find((candidate) => candidate.id === payload.id) as Row;
      expect(row).toEqual({
        id: payload.id,
        workspace_id: w.wsA,
        user_id: w.carol.id,
        device_id: payload.deviceId,
        application_id: payload.applicationId,
        application_name: payload.applicationName,
        kind: payload.kind,
        started_at: new Date(payload.startedAt),
        ended_at: new Date(payload.endedAt),
        active_ms: String(payload.activeMs),
        idle_ms: String(payload.idleMs),
        end_reason: payload.endReason,
        source: 'automatic',
        project_id: payload.projectId,
        task_id: payload.taskId,
        local_revision: payload.revision,
        recorded_at: new Date(payload.recordedAt),
      });
    }
    // And the uploader can read them back through RLS.
    expect(await visibleIds(db(), w.carol, 'time_entries')).toEqual(batch.map((payload) => payload.id).sort());
  });

  it('answers one result per entry, in input order', async () => {
    const w = await buildWorld(db());
    const batch = Array.from({ length: 12 }, (_, index) =>
      index % 3 === 1 ? entry({ activeMs: 1 }) : entry(),
    );
    const results = ok(await sync(db(), w.carol, w.wsA, batch));
    expect(results.map((result) => result.entry_id)).toEqual(batch.map((payload) => payload.id));
    expect(results.map((result) => result.status)).toEqual(
      batch.map((_, index) => (index % 3 === 1 ? 'rejected' : 'synced')),
    );
  });

  it('accepts an empty batch and exactly 500 entries', async () => {
    const w = await buildWorld(db());
    expect(ok(await sync(db(), w.carol, w.wsA, []))).toEqual([]);
    const batch = Array.from({ length: 500 }, () => entry());
    const ids = await syncOk(db(), w.carol, w.wsA, batch);
    expect(await storedCount(ids)).toBe(500);
  });

  it('keeps instants exact: UTC offsets are honoured and milliseconds kept', async () => {
    const w = await buildWorld(db());
    const payload = entry({
      startedAt: '2026-10-16T10:00:00.123+02:00',
      endedAt: '2026-10-16T10:05:00.456+02:00',
      activeMs: 5 * MINUTE + 333,
      recordedAt: '2026-10-16T08:00:01.789Z',
    });
    await syncOk(db(), w.carol, w.wsA, [payload]);
    const [row] = await storedEntries(db(), [payload.id]);
    expect((row?.started_at as Date).toISOString()).toBe('2026-10-16T08:00:00.123Z');
    expect((row?.ended_at as Date).toISOString()).toBe('2026-10-16T08:05:00.456Z');
    expect((row?.recorded_at as Date).toISOString()).toBe('2026-10-16T08:00:01.789Z');
  });

  it('defaults the revision to 1 and recorded_at to the server time when omitted', async () => {
    const w = await buildWorld(db());
    const payload = entry({ revision: undefined, recordedAt: undefined });
    await syncOk(db(), w.carol, w.wsA, [payload]);
    const [row] = await storedEntries(db(), [payload.id]);
    expect(row?.local_revision).toBe(1);
    expect(Math.abs((row?.recorded_at as Date).getTime() - Date.now())).toBeLessThan(10 * MINUTE);
  });

  it('accepts the boundaries: a zero-length interval, exactly 31 days, a start at 2020-01-01T00:00:00Z', async () => {
    const w = await buildWorld(db());
    const batch = [
      span('2026-10-16T12:00:00.000Z', 0),
      span('2026-01-01T00:00:00.000Z', 31 * DAY, { endReason: 'timeGap' }),
      span('2020-01-01T00:00:00.000Z', MINUTE),
    ];
    await syncOk(db(), w.carol, w.wsA, batch);
  });

  it('a blank project or task id means none', async () => {
    const w = await buildWorld(db());
    const payload = entry({ projectId: '', taskId: '' });
    await syncOk(db(), w.carol, w.wsA, [payload]);
    const [row] = await storedEntries(db(), [payload.id]);
    expect(row).toMatchObject({ project_id: null, task_id: null });
  });
});

describe('idempotency', () => {
  it('replaying a batch answers synced / already present and stores nothing twice', async () => {
    const w = await buildWorld(db());
    const batch = [entry(), entry(), entry()];
    await syncOk(db(), w.carol, w.wsA, batch);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(ok(await sync(db(), w.carol, w.wsA, batch))).toEqual(
        batch.map((payload) => ({ entry_id: payload.id, status: 'synced', detail: 'already present' })),
      );
    }
    expect(await storedCount(batch.map((payload) => payload.id))).toBe(3);
  });

  it('a duplicate id inside one batch is stored once', async () => {
    const w = await buildWorld(db());
    const payload = entry();
    expect(ok(await sync(db(), w.carol, w.wsA, [payload, payload]))).toEqual([
      { entry_id: payload.id, status: 'synced', detail: null },
      { entry_id: payload.id, status: 'synced', detail: 'already present' },
    ]);
    expect(await storedCount([payload.id])).toBe(1);
  });

  it('a lost response (committed, reply never received) is safe to retry with new entries mixed in', async () => {
    const w = await buildWorld(db());
    const first = [entry(), entry()];
    // The call commits but the client never sees the answer.
    await sync(db(), w.carol, w.wsA, first);
    const retry = [...first, entry()];
    const results = ok(await sync(db(), w.carol, w.wsA, retry));
    expect(results.map((result) => [result.status, result.detail])).toEqual([
      ['synced', 'already present'],
      ['synced', 'already present'],
      ['synced', null],
    ]);
    expect(await storedCount(retry.map((payload) => payload.id))).toBe(3);
    const [count] = await db().admin<{ n: number }>(
      `select count(*)::int as n from public.time_entries where user_id = $1`,
      [w.carol.id],
    );
    expect(count?.n).toBe(3);
  });

  it('a connection dropped before commit leaves nothing behind; the retry stores everything once', async () => {
    const w = await buildWorld(db());
    const batch = [entry(), entry()];
    await expect(
      db().as(w.carol, async (session) => {
        await session.query(`select * from public.sync_time_entries($1, $2::jsonb)`, [
          w.wsA,
          JSON.stringify(batch),
        ]);
        throw new Error('connection reset before commit');
      }),
    ).rejects.toThrow('connection reset before commit');
    expect(await storedCount(batch.map((payload) => payload.id))).toBe(0);

    expect(ok(await sync(db(), w.carol, w.wsA, batch)).map((result) => result.detail)).toEqual([null, null]);
    expect(ok(await sync(db(), w.carol, w.wsA, batch)).map((result) => result.detail)).toEqual([
      'already present',
      'already present',
    ]);
    expect(await storedCount(batch.map((payload) => payload.id))).toBe(2);
  });

  it('a replay never overwrites the stored interval, even if the payload changed', async () => {
    const w = await buildWorld(db());
    const original = entry();
    await syncOk(db(), w.carol, w.wsA, [original]);
    const before = await storedEntries(db(), [original.id]);
    const changed = { ...original, applicationName: 'Changed', activeMs: 1, revision: 9 };
    expect(ok(await sync(db(), w.carol, w.wsA, [changed]))).toEqual([
      { entry_id: original.id, status: 'synced', detail: 'already present' },
    ]);
    expect(await storedEntries(db(), [original.id])).toEqual(before);
  });

  it('an entry already synced to another of the caller’s workspaces is neither moved nor copied', async () => {
    const w = await buildWorld(db());
    const payload = entry();
    await syncOk(db(), w.gina, w.wsA, [payload]);
    // Documents the current contract: "already present and owned by the caller" → synced.
    expect(ok(await sync(db(), w.gina, w.wsB, [payload]))).toEqual([
      { entry_id: payload.id, status: 'synced', detail: 'already present' },
    ]);
    const rows = await storedEntries(db(), [payload.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspace_id).toBe(w.wsA);
  });
});

describe('per-entry rejection', () => {
  const start = Date.parse('2026-10-16T09:00:00.000Z');
  const invalid: Array<[string, () => unknown, string, 'id' | 'null']> = [
    ['active + idle ≠ duration', () => entry({ activeMs: 5 * MINUTE - 1 }), '23514', 'id'],
    ['idle split off by one', () => entry({ kind: 'idle', activeMs: 0, idleMs: 5 * MINUTE + 1 }), '23514', 'id'],
    [
      'ends before it starts',
      () => entry({ startedAt: new Date(start).toISOString(), endedAt: new Date(start - MINUTE).toISOString(), activeMs: 0 }),
      '23514',
      'id',
    ],
    ['unknown kind', () => entry({ kind: 'typing' }), '23514', 'id'],
    ['unknown end reason', () => entry({ endReason: 'crashed' }), '23514', 'id'],
    ['active entry with idle time', () => entry({ activeMs: 4 * MINUTE, idleMs: MINUTE }), '23514', 'id'],
    ['idle entry with active time', () => entry({ kind: 'idle' }), '23514', 'id'],
    ['negative idle time', () => entry({ activeMs: 5 * MINUTE + 1, idleMs: -1 }), '23514', 'id'],
    ['longer than 31 days', () => span('2026-01-01T00:00:00.000Z', 31 * DAY + 1), '23514', 'id'],
    ['starts before 2020', () => span('2019-12-31T23:59:59.999Z', MINUTE), '23514', 'id'],
    ['invalid application id', () => entry({ applicationId: 'Figma Desktop' }), '23514', 'id'],
    ['blank application name', () => entry({ applicationName: '   ' }), '23514', 'id'],
    ['application name over 80 characters', () => entry({ applicationName: 'n'.repeat(81) }), '23514', 'id'],
    ['revision 0', () => entry({ revision: 0 }), '23514', 'id'],
    ['missing device id', () => entry({ deviceId: undefined }), '23502', 'id'],
    ['missing end reason', () => entry({ endReason: undefined }), '23502', 'id'],
    ['malformed device id', () => entry({ deviceId: 'device-1' }), '22P02', 'id'],
    ['fractional milliseconds', () => entry({ activeMs: 1.5 }), '22P02', 'id'],
    ['milliseconds as words', () => ({ ...entry(), activeMs: 'five minutes' }), '22P02', 'id'],
    ['unparseable timestamp', () => entry({ startedAt: 'not a date' }), '22007', 'id'],
    ['malformed project id', () => entry({ projectId: 'project-1' }), '22P02', 'id'],
    ['malformed id', () => entry({ id: 'not-a-uuid' }), '22P02', 'null'],
    ['missing id', () => entry({ id: undefined }), '22023', 'null'],
    ['a number instead of an entry', () => 42, '22023', 'null'],
    ['null instead of an entry', () => null, '22023', 'null'],
    ['an array instead of an entry', () => [entry()], '22023', 'null'],
  ];

  it.each(invalid)('rejects %s without failing its valid siblings', async (_label, make, code, idShape) => {
    const w = await buildWorld(db());
    const before = entry();
    const bad = make();
    const after = entry();
    const results = ok(await sync(db(), w.carol, w.wsA, [before, bad, after]));
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ entry_id: before.id, status: 'synced', detail: null });
    expect(results[2]).toEqual({ entry_id: after.id, status: 'synced', detail: null });
    const rejected = results[1] as SyncResult;
    expect(rejected.status).toBe('rejected');
    expect(rejected.detail?.startsWith(`${code}: `), rejected.detail ?? '').toBe(true);
    const badId = (bad as { id?: unknown } | null)?.id;
    expect(rejected.entry_id).toBe(idShape === 'id' ? badId : null);

    expect(await storedCount([before.id, after.id])).toBe(2);
    if (typeof badId === 'string' && idShape === 'id') expect(await storedCount([badId])).toBe(0);
    // A rejected entry stays rejected on retry (nothing was half-stored).
    expect(ok(await sync(db(), w.carol, w.wsA, [bad]))[0]?.status).toBe('rejected');
  });

  it('rejects projects and tasks of another workspace (or unknown ones)', async () => {
    const w = await buildWorld(db());
    const projectA = await createProject(db(), w.alice, w.wsA);
    const taskA = await createTask(db(), w.carol, w.wsA);
    const projectB = await createProject(db(), w.erin, w.wsB);
    const taskB = await createTask(db(), w.frank, w.wsB);
    const good = entry({ projectId: projectA, taskId: taskA });
    const batch = [
      good,
      entry({ projectId: projectB }),
      entry({ taskId: taskB }),
      entry({ projectId: projectA, taskId: taskB }),
      entry({ projectId: '00000000-0000-4000-8000-0000000000af' }),
    ];
    // gina is a member of both workspaces: only the composite foreign keys stop her.
    const results = ok(await sync(db(), w.gina, w.wsA, batch));
    expect(results.map((result) => result.status)).toEqual(['synced', 'rejected', 'rejected', 'rejected', 'rejected']);
    for (const result of results.slice(1)) expect(result.detail).toMatch(/^23503: /);
    expect(await storedCount(batch.map((payload) => payload.id))).toBe(1);
  });

  it('an id that belongs to another user is rejected, never overwritten, and nothing about it leaks', async () => {
    const w = await buildWorld(db());
    const franks = entry({ applicationId: 'blender', applicationName: 'Blender', deviceId: '0b6c1f7e-5d8a-4f3e-9c21-6a7b8c9d0e1f' });
    await syncOk(db(), w.frank, w.wsB, [franks]);
    const daves = entry();
    await syncOk(db(), w.dave, w.wsA, [daves]);
    const before = await storedEntries(db(), [franks.id, daves.id]);

    // carol re-uses both ids: one from another workspace, one from a teammate.
    const sibling = entry();
    const results = ok(
      await sync(db(), w.carol, w.wsA, [
        { ...entry(), id: franks.id },
        { ...entry(), id: daves.id },
        sibling,
      ]),
    );
    expect(results.map((result) => [result.entry_id, result.status])).toEqual([
      [franks.id, 'rejected'],
      [daves.id, 'rejected'],
      [sibling.id, 'synced'],
    ]);
    for (const result of results.slice(0, 2)) {
      expect(result.detail).toMatch(/^23505: /);
      for (const secret of [w.frank.id, w.dave.id, w.wsB, 'Blender', 'blender', franks.deviceId, w.frank.email!]) {
        expect(result.detail).not.toContain(secret);
      }
    }
    expect(await storedEntries(db(), [franks.id, daves.id])).toEqual(before);
    expect(await visibleIds(db(), w.carol, 'time_entries', 'id = any($1::uuid[])', [[franks.id, daves.id]])).toEqual([]);
  });

  it('the server decides user, workspace, source and created_at; payload claims are ignored', async () => {
    const w = await buildWorld(db());
    const payload = entry({
      userId: w.frank.id,
      user_id: w.frank.id,
      workspaceId: w.wsB,
      workspace_id: w.wsB,
      source: 'manual',
      createdAt: '2020-01-01T00:00:00Z',
      created_at: '2020-01-01T00:00:00Z',
    });
    await syncOk(db(), w.carol, w.wsA, [payload]);
    const [row] = await db().admin<{ user_id: string; workspace_id: string; source: string; created_at: Date }>(
      `select user_id, workspace_id, source, created_at from public.time_entries where id = $1`,
      [payload.id],
    );
    expect(row).toMatchObject({ user_id: w.carol.id, workspace_id: w.wsA, source: 'automatic' });
    expect(Math.abs((row?.created_at as Date).getTime() - Date.now())).toBeLessThan(10 * MINUTE);
  });

  it('drops keys outside the contract (e.g. window titles): they are stored nowhere', async () => {
    const w = await buildWorld(db());
    const payload = entry({
      windowTitle: 'Client X — confidential-pitch.psd',
      executablePath: 'C:\\Program Files\\Adobe\\Photoshop.exe',
      clipboard: 'secret clipboard text',
    });
    await syncOk(db(), w.carol, w.wsA, [payload]);
    const [row] = await db().admin<{ json: string }>(
      `select row_to_json(t)::text as json from public.time_entries t where id = $1`,
      [payload.id],
    );
    for (const secret of ['confidential-pitch', 'Photoshop.exe', 'secret clipboard']) {
      expect(row?.json).not.toContain(secret);
    }
  });
});

describe('whole-call failures (nothing stored; the client keeps the entries pending)', () => {
  it('non-members, members of other workspaces and removed members get 42501', async () => {
    const w = await buildWorld(db());
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    for (const user of [w.mallory, w.frank, w.erin, w.dave]) {
      const batch = [entry(), entry()];
      fails(await sync(db(), user, w.wsA, batch), '42501', /not a member of this workspace/);
      expect(await storedCount(batch.map((payload) => payload.id))).toBe(0);
    }
  });

  it('a missing or unknown workspace id gets 42501', async () => {
    const w = await buildWorld(db());
    fails(await sync(db(), w.carol, null, [entry()]), '42501');
    fails(await sync(db(), w.carol, '00000000-0000-4000-8000-0000000000b0', [entry()]), '42501');
  });

  it('without a user session it fails with 28000: neither the service role nor a sub-less token can sync', async () => {
    const w = await buildWorld(db());
    const batch = [entry()];
    fails(await sync(db(), 'service', w.wsA, batch), '28000');
    fails(
      await db().asClaims('authenticated', { role: 'authenticated', email: w.carol.email }, (session) =>
        session.query(`select * from public.sync_time_entries($1, $2::jsonb)`, [w.wsA, JSON.stringify(batch)]),
      ),
      '28000',
    );
    fails(await sync(db(), 'anon', w.wsA, batch), '42501', /permission denied for function/);
    expect(await storedCount([batch[0]!.id])).toBe(0);
  });

  it('more than 500 entries fails with 54000', async () => {
    const w = await buildWorld(db());
    const batch = Array.from({ length: 501 }, () => entry());
    fails(await sync(db(), w.carol, w.wsA, batch), '54000');
    expect(await storedCount(batch.map((payload) => payload.id))).toBe(0);
  });

  it('a payload that is not a JSON array fails with 22023', async () => {
    const w = await buildWorld(db());
    const single = entry();
    for (const payload of [single, { entries: [single] }, 'entries', 42, true, null, undefined]) {
      fails(await sync(db(), w.carol, w.wsA, payload), '22023', /must be a JSON array/);
    }
    expect(await storedCount([single.id])).toBe(0);
  });
});

