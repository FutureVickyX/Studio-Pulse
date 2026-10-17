import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AccountStatus, SyncOverview } from '@studio-pulse/shared-types';
import { toCommandError } from '../lib/api';
import type { ApiError } from '../lib/api';
import type { ResourceState } from '../lib/resource';
import { accountStore, syncStatusStore } from '../lib/stores';

export interface CloudResource<T> extends ResourceState<T> {
  reload: () => Promise<void>;
}

/** Account status: `get_account_status`, then `account://changed`. Never contains tokens. */
export function useAccount(): CloudResource<AccountStatus> {
  const state = useSyncExternalStore(accountStore.subscribe, accountStore.getSnapshot);
  return { ...state, reload: accountStore.reload };
}

/** Sync overview: `get_sync_status`, then `sync://status`; refetched when the window regains focus. */
export function useSyncStatus(): CloudResource<SyncOverview> {
  const state = useSyncExternalStore(syncStatusStore.subscribe, syncStatusStore.getSnapshot);
  return { ...state, reload: syncStatusStore.reload };
}

/** Store a confirmed account status (a command result). Sync depends on it, so refresh that too. */
export function storeAccount(status: AccountStatus): void {
  accountStore.set(status);
  void syncStatusStore.reload();
}

/** Store a confirmed sync overview (a command result). */
export function storeSyncOverview(overview: SyncOverview): void {
  syncStatusStore.set(overview);
}

export interface CommandAction<A extends unknown[], R> {
  /** Runs the action; resolves with its result, or `undefined` when it failed (see `error`). */
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: ApiError | null;
  clearError: () => void;
}

/**
 * Pending and error state for one user-triggered command. A second `run` while one is in flight
 * is ignored, so a double click never sends the same request twice.
 */
export function useCommandAction<A extends unknown[], R>(action: (...args: A) => Promise<R>): CommandAction<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const latest = useRef(action);
  latest.current = action;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      return await latest.current(...args);
    } catch (caught) {
      if (mounted.current) setError(toCommandError(caught));
      return undefined;
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  return { run, pending, error, clearError: useCallback(() => setError(null), []) };
}
