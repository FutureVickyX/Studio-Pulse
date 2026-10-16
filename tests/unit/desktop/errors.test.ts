import { describe, expect, it } from 'vitest';
import type { CommandErrorCode } from '@studio-pulse/shared-types';

import { ApiError, FALLBACK_ERROR_MESSAGE, toCommandError } from '../../../apps/desktop/src/lib/errors';

const CODES: readonly CommandErrorCode[] = ['validation', 'not_found', 'startup_registration', 'storage', 'platform', 'internal'];

describe('toCommandError', () => {
  it.each(CODES)('keeps a serialized Rust CommandError with code %s', (code) => {
    const error = toCommandError({ code, message: 'Windows refused the change.' });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.message).toBe('Windows refused the change.');
    expect(error.name).toBe('ApiError');
  });

  it('maps an unknown code to internal but keeps the message', () => {
    const error = toCommandError({ code: 'teapot', message: 'Short and stout.' });
    expect(error.code).toBe('internal');
    expect(error.message).toBe('Short and stout.');
  });

  it('wraps the plain string Tauri rejects with (bad arguments, missing permission)', () => {
    const error = toCommandError('invalid args `range` for command `list_tracking_events`');
    expect(error.code).toBe('internal');
    expect(error.message).toBe('invalid args `range` for command `list_tracking_events`');
  });

  it('wraps a thrown Error', () => {
    const error = toCommandError(new TypeError('x is undefined'));
    expect(error.code).toBe('internal');
    expect(error.message).toBe('x is undefined');
  });

  it('returns an ApiError unchanged', () => {
    const original = new ApiError('validation', 'Enter a name.');
    expect(toCommandError(original)).toBe(original);
  });

  it.each([[null], [undefined], [42], [''], [{}], [{ code: 'storage' }], [{ code: 'storage', message: '' }], [new Error('')]])(
    'falls back to a readable message for %o',
    (value) => {
      const error = toCommandError(value);
      expect(error.code).toBe('internal');
      expect(error.message).toBe(FALLBACK_ERROR_MESSAGE);
    },
  );
});
