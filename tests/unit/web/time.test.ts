import { describe, expect, it } from 'vitest';

import { applicationsIn, filterEntries, totals, totalsBy, uniqueEntries } from '../../../apps/web/src/lib/time';
import type { TimeEntry } from '../../../apps/web/src/lib/time';

let seq = 0;
function entry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  seq += 1;
  return {
    id: `0190a7f0-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    workspace_id: 'ws',
    user_id: 'me',
    application_id: 'figma',
    application_name: 'Figma',
    kind: 'active',
    started_at: '2026-10-24T09:00:00.000Z',
    ended_at: '2026-10-24T09:10:00.000Z',
    active_ms: 600_000,
    idle_ms: 0,
    project_id: null,
    task_id: null,
    ...overrides,
  };
}

describe('time totals', () => {
  it('keep active, idle and foreground apart', () => {
    const list = [entry(), entry({ kind: 'idle', active_ms: 0, idle_ms: 300_000 })];
    expect(totals(list)).toEqual({ activeMs: 600_000, idleMs: 300_000, foregroundMs: 900_000, entries: 2 });
  });

  it('never count the same entry twice (whatever the id case)', () => {
    const one = entry();
    const twin = { ...one, id: one.id.toUpperCase() };
    expect(uniqueEntries([one, twin, one])).toHaveLength(1);
    expect(totals([one, twin]).activeMs).toBe(600_000);
  });

  it('group by project, with the unattributed under null', () => {
    const list = [entry({ project_id: 'a' }), entry({ project_id: 'a' }), entry({ project_id: null, active_ms: 60_000 })];
    const by = totalsBy(list, (e) => e.project_id);
    expect(by.get('a')?.activeMs).toBe(1_200_000);
    expect(by.get(null)?.activeMs).toBe(60_000);
    expect(by.get('a')?.entries).toBe(2);
  });
});

describe('time filters', () => {
  const start = Date.parse('2026-10-24T00:00:00Z');
  const end = Date.parse('2026-10-25T00:00:00Z');
  const list = [
    entry({ started_at: '2026-10-23T23:59:59.999Z' }),
    entry({ started_at: '2026-10-24T00:00:00.000Z', application_id: 'blender', application_name: 'Blender' }),
    entry({ started_at: '2026-10-24T23:59:59.999Z', project_id: 'p' }),
    entry({ started_at: '2026-10-25T00:00:00.000Z' }),
  ];

  it('include the start, exclude the end', () => {
    expect(filterEntries(list, { startMs: start, endMs: end, applicationId: null, projectId: null })).toHaveLength(2);
  });

  it('by application and by attribution', () => {
    expect(filterEntries(list, { startMs: start, endMs: end, applicationId: 'blender', projectId: null })).toHaveLength(1);
    expect(filterEntries(list, { startMs: start, endMs: end, applicationId: null, projectId: 'unattributed' })).toHaveLength(1);
    expect(filterEntries(list, { startMs: start, endMs: end, applicationId: null, projectId: 'p' })).toHaveLength(1);
  });

  it('lists applications by name', () => {
    expect(applicationsIn(list)).toEqual([
      { id: 'blender', name: 'Blender' },
      { id: 'figma', name: 'Figma' },
    ]);
  });
});
