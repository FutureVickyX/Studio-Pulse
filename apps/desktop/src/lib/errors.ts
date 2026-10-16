/**
 * Command errors, normalised. Pure (no `@tauri-apps/api`), so it is unit-tested in
 * tests/unit/desktop. Rust serializes every command failure as `{ code, message }`; Tauri itself
 * rejects with a plain string (bad arguments, missing permission), and JS code can throw `Error`.
 */

import type { CommandError, CommandErrorCode } from '@studio-pulse/shared-types';

const ERROR_CODES: ReadonlySet<CommandErrorCode> = new Set<CommandErrorCode>([
  'validation',
  'not_found',
  'startup_registration',
  'storage',
  'platform',
  'internal',
]);

export const FALLBACK_ERROR_MESSAGE = 'Something went wrong. Try again.';

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
  return new ApiError('internal', FALLBACK_ERROR_MESSAGE);
}
