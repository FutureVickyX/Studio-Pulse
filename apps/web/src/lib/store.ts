/**
 * A tiny shared query cache (the desktop's `createLiveResource` pattern, keyed): each key is
 * fetched once and shared by every component through `useSyncExternalStore`. Mutations and
 * realtime events call `invalidate(prefix)`, which refetches the queries someone is showing.
 * A response that started before a newer write or reload is discarded.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { asProblem } from './errors';
import type { Problem } from './errors';

export interface QueryState<T> {
  readonly data: T | undefined;
  readonly problem: Problem | null;
  /** A fetch is in flight (data, if any, is the previous value). */
  readonly loading: boolean;
}

const EMPTY: QueryState<never> = { data: undefined, problem: null, loading: false };

class Query<T> {
  state: QueryState<T> = { data: undefined, problem: null, loading: false };
  fetcher: (() => Promise<T>) | null = null;
  stale = true;
  private readonly listeners = new Set<() => void>();
  private seq = 0;

  getState = (): QueryState<T> => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get watched(): boolean {
    return this.listeners.size > 0;
  }

  private emit(next: QueryState<T>): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  async load(): Promise<void> {
    const fetcher = this.fetcher;
    if (!fetcher) return;
    const mySeq = ++this.seq;
    this.stale = false;
    if (!this.state.loading) this.emit({ ...this.state, loading: true });
    try {
      const data = await fetcher();
      if (mySeq !== this.seq) return;
      this.emit({ data, problem: null, loading: false });
    } catch (error) {
      if (mySeq !== this.seq) return;
      // Keep showing the last good data next to the problem.
      this.emit({ data: this.state.data, problem: asProblem(error), loading: false });
    }
  }

  set(data: T): void {
    this.seq += 1; // a load in flight is now older than this value
    this.stale = false;
    this.emit({ data, problem: null, loading: false });
  }
}

const queries = new Map<string, Query<unknown>>();

function queryFor<T>(key: string): Query<T> {
  let query = queries.get(key) as Query<T> | undefined;
  if (!query) {
    query = new Query<T>();
    queries.set(key, query as Query<unknown>);
  }
  return query;
}

export interface QueryResult<T> extends QueryState<T> {
  reload: () => Promise<void>;
}

/** Fetch and share `key`. `key: null` means "not ready yet" (no request). */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>): QueryResult<T> {
  const query = key === null ? null : queryFor<T>(key);
  if (query) query.fetcher = fetcher;
  const state = useSyncExternalStore(
    query ? query.subscribe : noopSubscribe,
    query ? query.getState : getEmpty,
    query ? query.getState : getEmpty,
  ) as QueryState<T>;

  useEffect(() => {
    if (query && query.stale) void query.load();
  }, [query]);

  const reload = useCallback(async () => {
    if (query) await query.load();
  }, [query]);

  return { ...state, reload };
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function getEmpty(): QueryState<never> {
  return EMPTY;
}

/** Mark every query whose key starts with `prefix` stale; refetch the ones on screen. */
export function invalidate(prefix: string): void {
  for (const [key, query] of queries) {
    if (!key.startsWith(prefix)) continue;
    query.stale = true;
    if (query.watched) void query.load();
  }
}

/** Replace a cached value (after a mutation returned the new row). */
export function setQueryData<T>(key: string, update: (current: T | undefined) => T): void {
  const query = queryFor<T>(key);
  query.set(update(query.state.data));
}

export function readQueryData<T>(key: string): T | undefined {
  return (queries.get(key) as Query<T> | undefined)?.state.data;
}

/** Whether a cached query under `prefix` holds a row with this id (in a list, or on its own). */
export function holdsRow(prefix: string, id: string): boolean {
  for (const [key, query] of queries) {
    if (!key.startsWith(prefix)) continue;
    const data: unknown = query.state.data;
    const rows: unknown[] = Array.isArray(data) ? data : [data];
    if (rows.some((row) => typeof row === 'object' && row !== null && (row as { id?: unknown }).id === id)) return true;
  }
  return false;
}

/** Forget everything (sign-out: nothing of the previous user may stay on screen). */
export function clearQueries(): void {
  queries.clear();
}
