/** Phase 3C regressions for the web automation client (integration review findings). */
import { describe, expect, it, vi } from 'vitest';
import { readAutomationPreferences } from '@studio-pulse/database';
import type { StudioPulseClient } from '@studio-pulse/database';
import { notificationPage, saveWorkspaceAutomation, workspaceAutomation } from '../../../apps/web/src/lib/automation';
import { createAutomationWorker } from '../../../server/automation/worker';
import { buildDigest } from '../../../server/automation/digest';

type Call = { method: string; args: unknown[] };

/** A PostgREST-shaped query builder that records every call and resolves to the queued results in order. */
function fakeClient(results: Array<{ data: unknown; error: unknown }>) {
  const calls: Call[][] = [];
  const client = {
    from(table: string) {
      const chain: Call[] = [{ method: 'from', args: [table] }];
      calls.push(chain);
      const builder: Record<string, unknown> = new Proxy({}, {
        get(_target, method: string) {
          if (method === 'then') {
            const result = results.shift() ?? { data: null, error: null };
            return (resolve: (value: unknown) => void) => resolve(result);
          }
          return (...args: unknown[]) => { chain.push({ method, args }); return builder; };
        },
      });
      return builder;
    },
  };
  return { client: client as unknown as StudioPulseClient, calls };
}

const FULL_ROW = { workspace_id: 'ws', enabled: true, events_enabled: false, reminders_enabled: true, digests_enabled: true, updated_at: '2026-11-18T10:00:00.123456+00:00' };

describe('workspace rules save only the member-writable switches', () => {
  it('a second save, built from the loaded row, PATCHes exactly the four granted columns', async () => {
    const load = fakeClient([{ data: FULL_ROW, error: null }]);
    const loaded = await workspaceAutomation(load.client, 'ws');
    expect(Object.keys(loaded).sort()).toEqual(['digests_enabled', 'enabled', 'events_enabled', 'reminders_enabled']);
    expect(load.calls[0]?.find((c) => c.method === 'select')?.args[0]).toBe('enabled,events_enabled,reminders_enabled,digests_enabled');

    // Even a caller holding the full row (as the UI did before the fix) sends only the switches.
    const save = fakeClient([{ data: FULL_ROW, error: null }]);
    const saved = await saveWorkspaceAutomation(save.client, 'ws', { ...FULL_ROW, enabled: false } as never);
    const update = save.calls[0]?.find((c) => c.method === 'update');
    expect(Object.keys(update?.args[0] as object).sort()).toEqual(['digests_enabled', 'enabled', 'events_enabled', 'reminders_enabled']);
    expect((update?.args[0] as { enabled: boolean }).enabled).toBe(false);
    expect(saved).not.toHaveProperty('workspace_id');
    expect(saved).not.toHaveProperty('updated_at');
  });

  it('the first save inserts the switches plus the workspace id and nothing else', async () => {
    const save = fakeClient([{ data: null, error: null }, { data: FULL_ROW, error: null }]);
    await saveWorkspaceAutomation(save.client, 'ws', { ...FULL_ROW } as never);
    const insert = save.calls[1]?.find((c) => c.method === 'insert');
    expect(Object.keys(insert?.args[0] as object).sort()).toEqual(['digests_enabled', 'enabled', 'events_enabled', 'reminders_enabled', 'workspace_id']);
  });
});

describe('notification keyset cursor', () => {
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  it('sends the server timestamp verbatim, keeping microseconds', async () => {
    const page = fakeClient([{ data: [], error: null }]);
    await notificationPage(page.client, 'ws', 'me', { created_at: '2026-11-14T10:00:00.1234+00:00', id });
    const filter = page.calls[0]?.find((c) => c.method === 'or')?.args[0];
    expect(filter).toBe(`created_at.lt."2026-11-14T10:00:00.1234+00:00",and(created_at.eq."2026-11-14T10:00:00.1234+00:00",id.lt.${id})`);
  });
  it('rejects a cursor that could escape the quoted filter', async () => {
    for (const created_at of ['2026-11-14T10:00:00Z",id.gt.0', '2026-11-14', 'not a date']) {
      const page = fakeClient([{ data: [], error: null }]);
      await expect(notificationPage(page.client, 'ws', 'me', { created_at, id })).rejects.toThrow('Invalid notification cursor');
    }
  });
});

describe('time zone spelling', () => {
  it('stores the tz-database spelling for a case-only difference, as the server requires', () => {
    expect(readAutomationPreferences({ timezone: 'europe/london' }).timezone).toBe('Europe/London');
    expect(readAutomationPreferences({ timezone: 'AMERICA/NEW_YORK' }).timezone).toBe('America/New_York');
    expect(readAutomationPreferences({ timezone: 'Africa/Lagos' }).timezone).toBe('Africa/Lagos');
    expect(readAutomationPreferences({ timezone: 'UTC' }).timezone).toBe('UTC');
  });
});

describe('automation worker resilience', () => {
  const credential = 'a'.repeat(64);
  const post = () => new Request('https://example.invalid', { method: 'POST', headers: { Authorization: `Bearer ${credential}` } });
  const job = { id: 'job', claim_token: 'token', kind: 'assigned', workspace_id: 'ws', recipient_id: 'me', payload: {} };

  it('still delivers queued jobs when planning fails, and reports the planning failure', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '22P02', message: 'invalid input syntax for type integer' } })
      .mockResolvedValueOnce({ data: [job], error: null })
      .mockResolvedValueOnce({ data: 'completed', error: null });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const handler = createAutomationWorker({ url: 'https://example.invalid', serviceKey: 'test-service-credential' }, () => ({ rpc }) as unknown as StudioPulseClient);
      const response = await handler(post());
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toEqual({ error: 'planning_failed', completed: 1, skipped: 0, deferred: 0, failed: 0 });
      expect(JSON.stringify(body)).not.toContain('invalid input syntax');
      expect(rpc.mock.calls.map((call) => call[0])).toEqual(['authorize_automation_worker', 'plan_automation_jobs', 'claim_automation_jobs', 'finish_automation_job']);
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'automation_run', planning: 'failed', completed: 1, skipped: 0, deferred: 0, failed: 0 }));
    } finally { log.mockRestore(); }
  });

  it('counts a delivery that committed but lost its response as completed, not failed', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: 0, error: null })
      .mockResolvedValueOnce({ data: [job], error: null })
      .mockResolvedValueOnce({ data: null, error: { code: 'network' } })
      .mockResolvedValueOnce({ data: null, error: { code: '40001' } })
      .mockResolvedValueOnce({ data: 'completed', error: null });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const handler = createAutomationWorker({ url: 'https://example.invalid', serviceKey: 'test-service-credential' }, () => ({ rpc }) as unknown as StudioPulseClient);
      const response = await handler(post());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ completed: 1, skipped: 0, deferred: 0, failed: 0 });
      expect(rpc.mock.calls.map((call) => call[0])).toEqual(['authorize_automation_worker', 'plan_automation_jobs', 'claim_automation_jobs', 'finish_automation_job', 'fail_automation_job', 'finish_automation_job']);
    } finally { log.mockRestore(); }
  });

  it('reads summary rows by id keyset, so a deletion between pages cannot skip a surviving row', async () => {
    const digestJob = { id: 'digest', claim_token: 'token', kind: 'daily', workspace_id: 'ws', recipient_id: 'me', payload: { timezone: 'UTC', localDate: '2026-11-15' } };
    const pages: Record<string, Call[][]> = { time_entries: [], tasks: [], projects: [] };
    const ids = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const from = (table: string) => {
      const chain: Call[] = [];
      (pages[table] ??= []).push(chain);
      const builder: Record<string, unknown> = new Proxy({}, {
        get(_target, method: string) {
          if (method === 'then') {
            if (table === 'workspace_members') return (resolve: (v: unknown) => void) => resolve({ data: { status: 'active' }, error: null });
            const after = chain.find((c) => c.method === 'gt' && c.args[0] === 'id')?.args[1] as string | undefined;
            // One distinct second per entry, so reconciliation keeps every row.
            const second = (id: string, offset: number) => new Date(Date.parse('2026-11-14T09:00:00Z') + (Number(id.slice(-12)) + offset) * 1000).toISOString();
            const rows = table === 'time_entries' ? ids.filter((id) => after === undefined || id > after).slice(0, 1000).map((id) => ({
              id, user_id: 'me', device_id: 'd', application_id: 'figma', application_name: 'Figma', kind: 'idle',
              started_at: second(id, 0), ended_at: second(id, 1), project_id: null, task_id: null,
            })) : [];
            return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
          }
          return (...args: unknown[]) => { chain.push({ method, args }); return builder; };
        },
      });
      return builder;
    };
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: 0, error: null })
      .mockResolvedValueOnce({ data: [digestJob], error: null })
      .mockResolvedValueOnce({ data: 'completed', error: null });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const handler = createAutomationWorker({ url: 'https://example.invalid', serviceKey: 'test-service-credential' }, () => ({ rpc, from }) as unknown as StudioPulseClient);
      expect((await handler(post())).status).toBe(200);
    } finally { log.mockRestore(); }
    const entryPages = pages.time_entries!;
    expect(entryPages).toHaveLength(2);
    expect(entryPages.every((chain) => !chain.some((c) => c.method === 'range'))).toBe(true);
    expect(entryPages[1]!.find((c) => c.method === 'gt' && c.args[0] === 'id')?.args[1]).toBe(ids[999]);
    const summary = rpc.mock.calls[3]?.[1] as { p_summary: { time: { idleMs: number } } };
    expect(summary.p_summary.time.idleMs).toBe(1001 * 1000);
  });
});

describe('digest size bound', () => {
  it('keeps a worst-case summary under the delivery limit, with application totals intact', () => {
    const emoji = (n: number) => '😀'.repeat(n);
    const projects = Array.from({ length: 120 }, (_, i) => ({
      id: `p${String(i).padStart(3, '0')}`, workspace_id: 'ws', name: emoji(120), status: 'active', lead_id: null, description: '',
      start_date: null, due_date: null, created_by: 'me', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', version: 1,
    }));
    const tasks = projects.flatMap((project, i) => [{
      id: `t${String(i).padStart(3, '0')}`, workspace_id: 'ws', project_id: project.id, title: emoji(200), description: '', status: 'todo',
      priority: 'normal', assignee_id: 'me', created_by: 'me', due_date: '2026-11-16', start_date: null, estimated_minutes: null,
      completed_at: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', version: 1,
    }]);
    const intervals = Array.from({ length: 60 }, (_, i) => ({
      id: `i${i}`, userId: 'me', deviceId: 'd', applicationId: `app-${String(i).padStart(2, '0')}-${'x'.repeat(56)}`, applicationName: emoji(80),
      kind: 'active' as const, startMs: Date.parse('2026-11-14T00:00:00Z') + i * 60_000, endMs: Date.parse('2026-11-14T00:00:00Z') + i * 60_000 + 30_000,
      projectId: projects[i]!.id, taskId: null,
    }));
    const digest = buildDigest({ kind: 'weekly', workspaceId: 'ws', userId: 'me', timeZone: 'UTC', localDate: '2026-11-15', now: Date.parse('2026-11-15T09:00:00Z'),
      intervals, tasks: tasks as never, projects: projects as never });
    // Postgres stores jsonb text with a space after every ':' and ','; stay well under its 100,000-byte check.
    const stored = new TextEncoder().encode(JSON.stringify(digest).replace(/([:,])/g, '$1 ')).length;
    expect(stored).toBeLessThan(100_000);
    expect(digest.applications).toHaveLength(21);
    expect(digest.applications.at(-1)?.name).toBe('Other applications (40)');
    expect(digest.applications.reduce((sum, app) => sum + app.activeMs, 0)).toBe(digest.time.activeMs);
    expect(Array.from(digest.upcoming[0]!.title)).toHaveLength(80);
    expect(digest.upcoming.every((task) => !/[\uD800-\uDBFF]$/.test(task.title.replace(/…$/, '')))).toBe(true);
  });
});
