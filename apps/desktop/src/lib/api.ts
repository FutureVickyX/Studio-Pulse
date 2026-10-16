/**
 * The only module that imports `@tauri-apps/api`. Every native call goes through `call`, typed
 * by the shared-types `CommandMap`; every event goes through `subscribe`, typed by
 * `EventPayloadMap`. Failures are normalised to `ApiError` (a `CommandError`).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type {
  CommandError,
  CommandErrorCode,
  CommandMap,
  CommandName,
  EventName,
  EventPayloadMap,
  Route,
} from '@studio-pulse/shared-types';

const ERROR_CODES: ReadonlySet<CommandErrorCode> = new Set<CommandErrorCode>([
  'validation',
  'not_found',
  'startup_registration',
  'storage',
  'platform',
  'internal',
]);

/** A rejected command, normalised. It is both an `Error` and a `CommandError`. */
export class ApiError extends Error implements CommandError {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Normalise anything a command can reject with (serialized `CommandError`, string, Error). */
export function toCommandError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isRecord(error)) {
    const code = error['code'];
    const message = error['message'];
    if (typeof message === 'string' && message.length > 0) {
      const known = typeof code === 'string' && ERROR_CODES.has(code as CommandErrorCode);
      return new ApiError(known ? (code as CommandErrorCode) : 'internal', message);
    }
  }
  if (typeof error === 'string' && error.length > 0) return new ApiError('internal', error);
  if (error instanceof Error && error.message) return new ApiError('internal', error.message);
  return new ApiError('internal', 'Something went wrong. Try again.');
}

type ArgsOf<K extends CommandName> = CommandMap[K]['args'];
type ResultOf<K extends CommandName> = CommandMap[K]['result'];
type NoArgs = Record<string, never>;

/** Arguments are optional for commands that take none. */
type CallArgs<K extends CommandName> = ArgsOf<K> extends NoArgs ? [args?: NoArgs] : [args: ArgsOf<K>];

/** Invoke a native command. Rejects with `ApiError`. */
export async function call<K extends CommandName>(name: K, ...args: CallArgs<K>): Promise<ResultOf<K>> {
  try {
    const payload = (args[0] ?? {}) as Record<string, unknown>;
    return await invoke<ResultOf<K>>(name, payload);
  } catch (error) {
    throw toCommandError(error);
  }
}

/**
 * Listen to a Rust → UI event. Returns a synchronous unsubscribe function that is safe to call
 * before the underlying listener has finished registering.
 */
export function subscribe<E extends EventName>(event: E, handler: (payload: EventPayloadMap[E]) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<EventPayloadMap[E]>(event, (message) => {
    if (!disposed) handler(message.payload);
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((error: unknown) => {
      console.error(`Could not listen to ${event}`, error);
    });
  return () => {
    disposed = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

/** True when the page runs inside the Tauri webview (the IPC bridge is injected). */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Label of the window this page is loaded in: `main` or `indicator`. */
export function currentWindowLabel(): string {
  return getCurrentWindow().label;
}

/** Hide the compact indicator (only the indicator window may call this). */
export function hideIndicator(): Promise<null> {
  return call('hide_indicator');
}

/** Bring up the main window, optionally on a route. */
export function openMainWindow(route: Route | null = null): Promise<null> {
  return call('show_main_window', { route });
}
