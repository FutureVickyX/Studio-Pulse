import { describe, expect, it } from 'vitest';

import { classifySupabaseKey } from '@studio-pulse/database';

import { classifyKey, jwtRole } from '../../../scripts/supabase/keys.mjs';
import { b64url, fakeJwt, fakeSecretKey, legacyKey } from './helpers';

/** A service_role JWT with an empty signature segment (built at runtime, see fakeSecretKey). */
const EMPTY_SIGNATURE_SERVICE_ROLE = `${b64url('{"alg":"HS256"}')}.${b64url('{"role":"service_role"}')}.`;

/** Keys the scripts and the TypeScript package must classify identically. */
const CORPUS: readonly string[] = [
  'sb_publishable_AbCdEfGhIjKlMnOpQrStUv_1234567',
  'sb_publishable_',
  'sb_publishable_bad key',
  fakeSecretKey(),
  'SB_SECRET_x',
  ' sb_secret_padded ',
  legacyKey('anon'),
  legacyKey('service_role'),
  legacyKey('authenticated'),
  fakeJwt({ role: 'service_role' }, { alg: 'none' }),
  fakeJwt({ sub: 'no-role' }),
  fakeJwt({ role: 42 }),
  `${b64url('{}')}.${b64url('null')}.sig`,
  `${b64url('{}')}.${b64url('"str"')}.sig`,
  `${b64url('{}')}.${b64url('{"role":"anon"')}.sig`,
  `${b64url('{}')}.${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')}.sig`,
  'a.b.c',
  'a.b',
  '',
  'anon',
  'service_role',
  EMPTY_SIGNATURE_SERVICE_ROLE,
];

describe('scripts/supabase/keys.mjs', () => {
  it('classifies every corpus key exactly like @studio-pulse/database', () => {
    for (const key of CORPUS) {
      expect(classifyKey(key), JSON.stringify(key)).toBe(classifySupabaseKey(key));
    }
  });

  it('classifies the essential cases', () => {
    expect(classifyKey('sb_secret_abc')).toBe('secret');
    expect(classifyKey(legacyKey('service_role'))).toBe('secret');
    expect(classifyKey(legacyKey('anon'))).toBe('publishable');
    expect(classifyKey('sb_publishable_abc')).toBe('publishable');
    // An empty-signature JWT whose payload says service_role is still a secret key.
    expect(classifyKey(EMPTY_SIGNATURE_SERVICE_ROLE)).toBe('secret');
  });

  it('jwtRole reads the top-level role claim only', () => {
    expect(jwtRole(fakeJwt({ role: 'service_role' }))).toBe('service_role');
    expect(jwtRole(fakeJwt({ app_metadata: { role: 'service_role' } }))).toBeNull();
    expect(jwtRole('not-a-jwt')).toBeNull();
  });
});
