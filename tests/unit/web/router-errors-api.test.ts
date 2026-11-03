import { describe, expect, it, vi } from 'vitest';

import type { StudioPulseClient } from '@studio-pulse/database';

import {
  PAGE_ROWS,
  createTask,
  insertOnce,
  listAll,
  listMembers,
  listMyTime,
  listNotes,
  listProjects,
  listSubtasks,
  listTasks,
  newId,
  saveNoteText,
} from '../../../apps/web/src/lib/api';
import { ProblemError, isNetworkError, toProblem } from '../../../apps/web/src/lib/errors';
import { formatLocation, formatRoute, parseLocation, sectionOf } from '../../../apps/web/src/lib/router';
import type { Route } from '../../../apps/web/src/lib/router';

const ID = '0190a7f0-1111-7000-8000-00000000abcd';

describe('routes', () => {
  it('round-trip every route', () => {
    const routes: Route[] = [
      { name: 'overview' },
      { name: 'projects' },
      { name: 'project', id: ID },
      { name: 'tasks', view: 'mine' },
      { name: 'tasks', view: 'all' },
      { name: 'notes', id: null },
      { name: 'notes', id: ID },
      { name: 'time' },
    ];
    for (const route of routes) {
      expect(parseLocation(formatRoute(route)).route).toEqual(route);
    }
  });

  it('carry an open task, and ignore malformed ids', () => {
    expect(parseLocation(`#/tasks/all?task=${ID}`)).toEqual({ route: { name: 'tasks', view: 'all' }, taskId: ID });
    expect(parseLocation('#/tasks?task=not-an-id').taskId).toBeNull();
    expect(parseLocation('#/projects/not-an-id').route).toEqual({ name: 'projects' });
    expect(parseLocation('#/nowhere').route).toEqual({ name: 'overview' });
    expect(parseLocation('').route).toEqual({ name: 'overview' });
    expect(parseLocation(`#/projects/${ID.toUpperCase()}`).route).toEqual({ name: 'project', id: ID });
    expect(formatLocation({ route: { name: 'notes', id: null }, taskId: ID })).toBe(`#/notes?task=${ID}`);
    expect(sectionOf({ name: 'project', id: ID })).toBe('projects');
  });
});

describe('errors', () => {
  it('recognise network failures', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError({ message: 'TypeError: Failed to fetch', code: '' })).toBe(true);
    expect(isNetworkError({ name: 'AuthRetryableFetchError', message: '' })).toBe(true);
    expect(isNetworkError({ code: '42501', message: 'permission denied for table tasks' })).toBe(false);
    expect(toProblem(new TypeError('Load failed')).kind).toBe('network');
  });

  it('pass our own messages through and hide raw database wording', () => {
    expect(toProblem({ code: '23503', message: 'this project has tasks, notes or tracked time; archive it instead' }).message).toBe(
      'This project has tasks, notes or tracked time; archive it instead.',
    );
    expect(toProblem({ code: '23503', message: 'insert or update on table "tasks" violates foreign key constraint "x"' }).message).not.toMatch(
      /violates|constraint/,
    );
    expect(toProblem({ code: '42501', message: 'new row violates row-level security policy for table "projects"' })).toMatchObject({
      kind: 'permission',
      message: 'You don’t have permission to do that in this workspace.',
    });
    expect(toProblem({ code: '22023', message: 'archived projects take no new time' }).message).toBe('Archived projects take no new time.');
    expect(toProblem({ code: '23514', message: 'new row for relation "tasks" violates check constraint' }).kind).toBe('invalid');
    expect(toProblem({ code: '23505', message: 'duplicate key value' }).kind).toBe('duplicate');
  });

  it('map sessions, auth and rate limits', () => {
    expect(toProblem({ code: 'PGRST301', message: 'JWT expired' }).kind).toBe('session');
    expect(toProblem({ status: 401 }).kind).toBe('session');
    expect(toProblem({ code: 'invalid_credentials', message: 'Invalid login credentials' }).message).toMatch(/don’t match/);
    expect(toProblem({ code: 'email_not_confirmed' }).message).toMatch(/Confirm your email/);
    expect(toProblem({ status: 429 }).kind).toBe('rateLimited');
    expect(toProblem({ code: 'P0002', message: 'project or task not found' }).kind).toBe('notFound');
    expect(toProblem({ status: 413 }).kind).toBe('invalid'); // too large: retrying cannot help
    expect(toProblem(null).kind).toBe('unknown');
  });
});

describe('lists are read page by page (PostgREST cuts every response at max rows)', () => {
  /** A table behind a server that returns at most 1,000 rows per request, whatever was asked for. */
  function capped(rows: readonly { id: string }[]) {
    const calls = { ranges: [] as [number, number][], orders: [] as string[] };
    const builder = {
      select: () => builder,
      eq: () => builder,
      gte: () => builder,
      lt: () => builder,
      order: (column: string) => {
        calls.orders.push(column);
        return builder;
      },
      range: async (from: number, to: number) => {
        calls.ranges.push([from, to]);
        return { data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null };
      },
    };
    return { client: { from: () => builder } as unknown as StudioPulseClient, calls };
  }
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}` }));

  it('reads every task, not only the first 1,000, in a stable order', async () => {
    const { client, calls } = capped(rowsOf(2_500));
    expect(await listTasks(client, ID)).toHaveLength(2_500);
    expect(calls.ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(calls.orders.slice(0, 2)).toEqual(['created_at', 'id']); // the id makes the order total
  });

  it('reads all tracked time in a range unless a limit is asked for', async () => {
    const all = capped(rowsOf(1_800));
    expect(await listMyTime(all.client, { workspaceId: ID, userId: 'u1', fromIso: 'a', toIso: 'b' })).toHaveLength(1_800);
    const some = capped(rowsOf(1_800));
    expect(await listMyTime(some.client, { workspaceId: ID, userId: 'u1', fromIso: 'a', toIso: 'b', limit: 1_200 })).toHaveLength(1_200);
    expect(some.calls.ranges).toEqual([
      [0, 999],
      [1000, 1199],
    ]);
  });

  it('stops at a short page, keeps a row seen twice once, and fails on an error', async () => {
    const page = vi
      .fn()
      .mockResolvedValueOnce({ data: rowsOf(PAGE_ROWS), error: null })
      .mockResolvedValueOnce({ data: [{ id: 'r00999' }, { id: 'r01000' }], error: null }); // r00999 moved by a concurrent change
    const rows = await listAll(page);
    expect(rows).toHaveLength(1_001);
    expect(page).toHaveBeenCalledTimes(2);
    expect(page).toHaveBeenNthCalledWith(2, 1000, 1999);

    const failing = vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied for table tasks' } });
    await expect(listAll(failing)).rejects.toBeInstanceOf(ProblemError);
  });
});

describe('lists are paged in an order no edit changes (an edit between two pages skips nothing)', () => {
  type Row = Record<string, unknown>;

  /**
   * A tiny PostgREST: filters, sorts as asked and returns at most 1,000 rows per request.
   * `between(n)` runs after the n-th request has been answered, to change the tables mid-read.
   */
  function server(tables: Record<string, Row[]>, between: (request: number) => void) {
    const orders: string[] = [];
    let requests = 0;
    const compare = (a: unknown, b: unknown) =>
      typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    const from = (name: string) => {
      const filters: ((row: Row) => boolean)[] = [];
      const order: [string, boolean][] = [];
      const answer = (first: number, last: number) => {
        const rows = (tables[name] ?? []).filter((row) => filters.every((keep) => keep(row)));
        rows.sort((a, b) => {
          for (const [column, ascending] of order) {
            const c = compare(a[column], b[column]);
            if (c !== 0) return ascending ? c : -c;
          }
          return 0;
        });
        if (order.length > 0) orders.push(`${name}: ${order.map(([column, ascending]) => (ascending ? column : `${column} desc`)).join(', ')}`);
        const data = rows.slice(first, Math.min(last + 1, first + 1000));
        requests += 1;
        between(requests);
        return Promise.resolve({ data, error: null });
      };
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in: (column: string, values: readonly unknown[]) => {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          order.push([column, options?.ascending ?? true]);
          return builder;
        },
        range: answer,
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => answer(0, Infinity).then(resolve, reject),
      };
      return builder;
    };
    return { client: { from } as unknown as StudioPulseClient, orders };
  }
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1) + minute * 60_000).toISOString();
  const idOf = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

  it('notes: one saved after the first page (now the newest) is read once, then listed first', async () => {
    const notes: Row[] = Array.from({ length: 2_500 }, (_, i) => ({ id: idOf(i), workspace_id: ID, created_at: at(i), updated_at: at(i) }));
    // Saved after the first page: by updated_at it would jump into the page already read.
    const { client, orders } = server({ notes }, (request) => {
      if (request === 1) notes[1_200] = { ...notes[1_200], updated_at: at(9_000) };
    });
    const listed = await listNotes(client, ID);
    expect(listed).toHaveLength(2_500);
    const older = Array.from({ length: 2_500 }, (_, i) => idOf(2_499 - i)).filter((id) => id !== idOf(1_200));
    expect(ids(listed)).toEqual([idOf(1_200), ...older]); // the most recently updated first
    expect(new Set(orders)).toEqual(new Set(['notes: created_at, id']));
  });

  it('projects: one renamed after the first page is read once, and the list is by name', async () => {
    const projects: Row[] = Array.from({ length: 1_500 }, (_, i) => ({
      id: idOf(i),
      workspace_id: ID,
      name: `Project ${String(i).padStart(4, '0')}`,
      created_at: at(i),
    }));
    const { client, orders } = server({ projects }, (request) => {
      if (request === 1) projects[1_499] = { ...projects[1_499], name: 'A renamed project' };
    });
    const listed = await listProjects(client, ID);
    expect(listed).toHaveLength(1_500);
    expect(ids(listed)).toEqual([idOf(1_499), ...Array.from({ length: 1_499 }, (_, i) => idOf(i))]);
    expect(new Set(orders)).toEqual(new Set(['projects: created_at, id']));
  });

  it('checklists: an item moved to the top after the first page is read once, and the list is by position', async () => {
    const task_subtasks: Row[] = Array.from({ length: 1_200 }, (_, i) => ({ id: idOf(i), task_id: ID, position: i + 1, created_at: at(i) }));
    const { client, orders } = server({ task_subtasks }, (request) => {
      if (request === 1) task_subtasks[1_199] = { ...task_subtasks[1_199], position: 0 };
    });
    const listed = await listSubtasks(client, ID);
    expect(ids(listed)).toEqual([idOf(1_199), ...Array.from({ length: 1_199 }, (_, i) => idOf(i))]);
    expect(new Set(orders)).toEqual(new Set(['task_subtasks: created_at, id']));
  });

  it('equal names and times always list in one order (by id)', async () => {
    // Created in the reverse of id order, with the same name and the same last save.
    const rows = [
      { id: idOf(2), workspace_id: ID, name: 'Same', created_at: at(0), updated_at: at(5) },
      { id: idOf(1), workspace_id: ID, name: 'Same', created_at: at(1), updated_at: at(5) },
    ];
    const { client } = server({ projects: rows, notes: rows }, () => undefined);
    expect(ids(await listProjects(client, ID))).toEqual([idOf(1), idOf(2)]);
    expect(ids(await listNotes(client, ID))).toEqual([idOf(1), idOf(2)]);
  });

  it('members: someone joining between two pages does not list a teammate twice', async () => {
    const workspace_members: Row[] = Array.from({ length: 1_200 }, (_, i) => ({ workspace_id: ID, user_id: idOf(i + 1), role: 'member', status: 'active' }));
    const profiles: Row[] = Array.from({ length: 1_201 }, (_, i) => ({ id: idOf(i), display_name: `Member ${String(i).padStart(4, '0')}` }));
    // The newcomer's user id sorts before everyone read so far: the last one read moves into the next page.
    const { client, orders } = server({ workspace_members, profiles }, (request) => {
      if (request === 1) workspace_members.push({ workspace_id: ID, user_id: idOf(0), role: 'member', status: 'active' });
    });
    const members = await listMembers(client, ID);
    expect(members).toHaveLength(1_200);
    expect(new Set(members.map((m) => m.userId)).size).toBe(1_200);
    expect(new Set(orders)).toEqual(new Set(['workspace_members: user_id']));
  });
});

describe('saveNoteText', () => {
  /** A stand-in for supabase-js: each `from()` answers with the next result, whatever is chained on it. */
  function answering(...results: unknown[]) {
    const from = vi.fn(() => {
      const result = results.shift();
      const chain: Record<string, unknown> = {};
      for (const name of ['update', 'select', 'eq', 'maybeSingle']) chain[name] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
      return chain;
    });
    return { client: { from } as unknown as StudioPulseClient, from };
  }
  const unmatched = { data: null, error: null };

  it('a retry that finds its own text (the first attempt landed, its response was lost) is saved, not a conflict', async () => {
    const mine = answering(unmatched, { data: { title: 'T', body: 'mine', version: 5 }, error: null });
    expect(await saveNoteText(mine.client, ID, { title: 'T', body: 'mine' }, 4)).toEqual({ kind: 'saved', version: 5 });
    const theirs = answering(unmatched, { data: { title: 'T', body: 'theirs', version: 5 }, error: null });
    expect(await saveNoteText(theirs.client, ID, { title: 'T', body: 'mine' }, 4)).toEqual({
      kind: 'conflict',
      server: { draft: { title: 'T', body: 'theirs' }, version: 5 },
    });
  });

  it('refuses text over the 1 MB column limit before sending it, and says so', async () => {
    const over = answering();
    const error = await saveNoteText(over.client, ID, { title: 'T', body: 'é'.repeat(500_001) }, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).problem).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/1 MB/) });
    expect(over.from).not.toHaveBeenCalled();

    const atLimit = answering({ data: { version: 2 }, error: null });
    expect(await saveNoteText(atLimit.client, ID, { title: 'T', body: 'a'.repeat(1_000_000) }, 1)).toEqual({ kind: 'saved', version: 2 });
  });
});

describe('insertOnce: a create is never duplicated by a retry', () => {
  type Row = { id: string };
  const row: Row = { id: 'r1' };

  it('returns the inserted row', async () => {
    const insert = vi.fn().mockResolvedValue({ data: row, error: null });
    await expect(insertOnce<Row>(insert, vi.fn())).resolves.toEqual(row);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure with the same request, then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const insert = vi
        .fn()
        .mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } })
        .mockResolvedValueOnce({ data: row, error: null });
      const pending = insertOnce<Row>(insert, vi.fn());
      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toEqual(row);
      expect(insert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('“already exists” after a lost response returns the row the first attempt created', async () => {
    const insert = vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } });
    const existing = vi.fn().mockResolvedValue({ data: row, error: null });
    await expect(insertOnce<Row>(insert, existing)).resolves.toEqual(row);
  });

  it('fails clearly when the id exists but is not readable, or on a real error', async () => {
    const insert = vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } });
    const missing = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(insertOnce<Row>(insert, missing)).rejects.toBeInstanceOf(ProblemError);
    const denied = vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } });
    const error = await insertOnce<Row>(denied, vi.fn()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).problem.kind).toBe('permission');
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it('pressing Create again with the same draft id finds the row that landed, not a second one', async () => {
    const lost = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } };
    // A tiny tasks table: the first insert lands but its response is lost, then the network is
    // down for both automatic retries, so the first createTask fails. The user presses Create again.
    const rows = new Map<string, { id: string }>();
    const steps = ['land-lost', 'down', 'down'];
    const client = {
      from: () => ({
        insert: (value: { id: string }) => ({
          select: () => ({
            single: async () => {
              const step = steps.shift() ?? 'ok';
              if (step === 'down') return lost;
              if (rows.has(value.id)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
              rows.set(value.id, value);
              return step === 'land-lost' ? lost : { data: value, error: null };
            },
          }),
        }),
        select: () => ({ eq: (_column: string, id: string) => ({ single: async () => ({ data: rows.get(id) ?? null, error: null }) }) }),
      }),
    } as unknown as StudioPulseClient;
    const input = { workspace_id: ID, title: 'Logo sketches' };

    vi.useFakeTimers();
    try {
      const draft = newId();
      const first = createTask(client, input, 'u1', draft).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(600 + 1200);
      expect(await first).toBeInstanceOf(ProblemError);
      expect(rows.size).toBe(1);

      const again = await createTask(client, input, 'u1', draft);
      expect(again.id).toBe(draft);
      expect(rows.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
