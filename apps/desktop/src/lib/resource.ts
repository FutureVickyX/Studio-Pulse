/**
 * Tiny shared stores for native state (tracker status, settings, applications, app info).
 * One store = one initial command + optional event subscriptions, shared by every component
 * through `useSyncExternalStore`, so each Rust event is listened to once per window.
 */

import { toCommandError } from './errors';
import type { ApiError } from './errors';

export interface ResourceState<T> {
  readonly data: T | undefined;
  readonly error: ApiError | null;
  /** A load is in flight (data, if any, is the previous value). */
  readonly loading: boolean;
}

export interface LiveResource<T> {
  getSnapshot: () => ResourceState<T>;
  subscribe: (listener: () => void) => () => void;
  reload: () => Promise<void>;
  /** Replace the value (a command result or an event payload). */
  set: (value: T) => void;
}

export interface LiveResourceOptions<T> {
  load: () => Promise<T>;
  /** Wire event subscriptions; return the teardown. Runs while anyone is subscribed. */
  listen?: (set: (value: T) => void, reload: () => void) => () => void;
}

export function createLiveResource<T>({ load, listen }: LiveResourceOptions<T>): LiveResource<T> {
  let state: ResourceState<T> = { data: undefined, error: null, loading: false };
  const listeners = new Set<() => void>();
  let teardown: (() => void) | null = null;
  /** Bumped by every `set`; a load that started before a newer write is discarded. */
  let writeSeq = 0;
  let loadSeq = 0;

  function emit(next: ResourceState<T>) {
    state = next;
    for (const listener of listeners) listener();
  }

  function set(value: T) {
    writeSeq += 1;
    emit({ data: value, error: null, loading: false });
  }

  async function reload(): Promise<void> {
    const mySeq = ++loadSeq;
    const writeAtStart = writeSeq;
    if (!state.loading) emit({ ...state, loading: true });
    try {
      const value = await load();
      if (mySeq !== loadSeq) return;
      if (writeSeq !== writeAtStart) {
        // An event delivered a newer value while this load was in flight.
        if (state.loading) emit({ ...state, loading: false });
        return;
      }
      writeSeq += 1;
      emit({ data: value, error: null, loading: false });
    } catch (error) {
      if (mySeq !== loadSeq) return;
      emit({ data: state.data, error: toCommandError(error), loading: false });
    }
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
      teardown = listen ? listen(set, () => void reload()) : null;
      // Revalidate on every first subscriber; cached data stays visible meanwhile.
      void reload();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && teardown) {
        teardown();
        teardown = null;
      }
    };
  }

  return { getSnapshot: () => state, subscribe, reload, set };
}
