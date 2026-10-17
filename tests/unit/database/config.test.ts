import { describe, expect, it } from 'vitest';

import {
  SUPABASE_PUBLISHABLE_KEY_ENV,
  SUPABASE_URL_ENV,
  SupabaseConfigError,
  classifySupabaseKey,
  readSupabaseConfig,
  validateSupabaseConfig,
} from '@studio-pulse/database';
import type { SupabaseConfigErrorCode } from '@studio-pulse/database';

import { b64url, fakeJwt, fakeSecretKey, legacyKey } from './helpers';

const URL = 'https://abcdefghijklmnopqrst.supabase.co';
const PUBLISHABLE = 'sb_publishable_AbCdEfGhIjKlMnOpQrStUv_1234567';
const SECRET = fakeSecretKey();

function errorOf(fn: () => unknown): SupabaseConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SupabaseConfigError) return error;
    throw error;
  }
  throw new Error('expected a SupabaseConfigError');
}

function codeOf(fn: () => unknown): SupabaseConfigErrorCode {
  return errorOf(fn).code;
}

describe('classifySupabaseKey', () => {
  it('recognises publishable keys and legacy anon JWTs', () => {
    expect(classifySupabaseKey(PUBLISHABLE)).toBe('publishable');
    expect(classifySupabaseKey(`  ${PUBLISHABLE}\n`)).toBe('publishable');
    expect(classifySupabaseKey(legacyKey('anon'))).toBe('publishable');
  });

  it('recognises secret keys by prefix, in any letter case', () => {
    expect(classifySupabaseKey(SECRET)).toBe('secret');
    expect(classifySupabaseKey('SB_SECRET_abc')).toBe('secret');
    expect(classifySupabaseKey('Sb_Secret_')).toBe('secret');
    expect(classifySupabaseKey(` ${SECRET} `)).toBe('secret');
  });

  it('recognises legacy service_role JWTs as secret', () => {
    expect(classifySupabaseKey(legacyKey('service_role'))).toBe('secret');
    // Claim order, extra claims and a different header do not matter.
    expect(classifySupabaseKey(fakeJwt({ exp: 1, role: 'service_role', ref: 'x' }, { alg: 'none' }))).toBe('secret');
    // base64url without padding, payload containing characters that need - and _.
    expect(classifySupabaseKey(fakeJwt({ role: 'service_role', note: '>>>???~~~' }))).toBe('secret');
  });

  it('treats other JWT roles and malformed tokens as unknown (never as publishable)', () => {
    expect(classifySupabaseKey(fakeJwt({ role: 'authenticated', sub: 'u' }))).toBe('unknown');
    expect(classifySupabaseKey(fakeJwt({ role: 'ANON' }))).toBe('unknown');
    expect(classifySupabaseKey(fakeJwt({ sub: 'no role' }))).toBe('unknown');
    expect(classifySupabaseKey(fakeJwt({ role: ['anon'] }))).toBe('unknown');
    expect(classifySupabaseKey(`${b64url('{"alg":"HS256"}')}.${b64url('[1,2]')}.sig`)).toBe('unknown');
    expect(classifySupabaseKey(`${b64url('{"alg":"HS256"}')}.${b64url('not json')}.sig`)).toBe('unknown');
    expect(classifySupabaseKey('a.b')).toBe('unknown');
    expect(classifySupabaseKey('a.b.c.d')).toBe('unknown');
    expect(classifySupabaseKey('header.pay+load.sig')).toBe('unknown');
    expect(classifySupabaseKey('sb_publishable_')).toBe('unknown');
    expect(classifySupabaseKey('sb_publishable_has space')).toBe('unknown');
    expect(classifySupabaseKey('')).toBe('unknown');
    expect(classifySupabaseKey('anon')).toBe('unknown');
  });
});

describe('validateSupabaseConfig', () => {
  it('accepts an https project URL with a publishable key and normalises both', () => {
    expect(validateSupabaseConfig(`  ${URL}///  `, ` ${PUBLISHABLE} `)).toEqual({ url: URL, publishableKey: PUBLISHABLE });
    expect(validateSupabaseConfig(URL, legacyKey('anon')).url).toBe(URL);
  });

  it('accepts plain http only for a local stack', () => {
    expect(validateSupabaseConfig('http://127.0.0.1:54321', PUBLISHABLE).url).toBe('http://127.0.0.1:54321');
    expect(validateSupabaseConfig('http://localhost:54321/', PUBLISHABLE).url).toBe('http://localhost:54321');
    expect(validateSupabaseConfig('http://[::1]:54321', PUBLISHABLE).url).toBe('http://[::1]:54321');
    expect(codeOf(() => validateSupabaseConfig('http://abcdefghijklmnopqrst.supabase.co', PUBLISHABLE))).toBe('invalidUrl');
    expect(codeOf(() => validateSupabaseConfig('http://10.0.0.5:54321', PUBLISHABLE))).toBe('invalidUrl');
  });

  it('rejects URLs that are not a bare project URL', () => {
    for (const bad of [
      'abcdefghijklmnopqrst.supabase.co',
      'ftp://abcdefghijklmnopqrst.supabase.co',
      `${URL}/rest/v1`,
      `${URL}?x=1`,
      `${URL}#frag`,
      'https://user:pass@abcdefghijklmnopqrst.supabase.co',
      'not a url',
    ]) {
      expect(codeOf(() => validateSupabaseConfig(bad, PUBLISHABLE)), bad).toBe('invalidUrl');
    }
  });

  it('rejects a missing or unrecognised key', () => {
    expect(codeOf(() => validateSupabaseConfig(URL, ''))).toBe('invalidKey');
    expect(codeOf(() => validateSupabaseConfig(URL, '   '))).toBe('invalidKey');
    expect(codeOf(() => validateSupabaseConfig(URL, 'eyJhbGciOiJIUzI1NiJ9'))).toBe('invalidKey');
    expect(codeOf(() => validateSupabaseConfig(URL, fakeJwt({ role: 'authenticated' })))).toBe('invalidKey');
  });

  it('reports "missing" only when both values are empty', () => {
    expect(codeOf(() => validateSupabaseConfig('', ''))).toBe('missing');
    expect(codeOf(() => validateSupabaseConfig(' ', '\n'))).toBe('missing');
    expect(codeOf(() => validateSupabaseConfig('', PUBLISHABLE))).toBe('invalidUrl');
  });

  it('REJECTS secret keys (sb_secret_ prefix and service_role JWTs), even when the URL is also wrong', () => {
    const secrets = [SECRET, 'SB_SECRET_whatever', legacyKey('service_role'), fakeJwt({ role: 'service_role' })];
    for (const key of secrets) {
      expect(codeOf(() => validateSupabaseConfig(URL, key))).toBe('secretKey');
      expect(codeOf(() => validateSupabaseConfig('', key))).toBe('secretKey');
      expect(codeOf(() => validateSupabaseConfig('http://example.com/path', key))).toBe('secretKey');
    }
  });

  it('never includes the key or the URL in error messages', () => {
    const cases: [string, string][] = [
      [URL, SECRET],
      [URL, legacyKey('service_role')],
      [URL, 'sb_publishable_has space'],
      ['https://user:hunter2hunter2@abcdefghijklmnopqrst.supabase.co', PUBLISHABLE],
      ['http://private-host.example:1234', PUBLISHABLE],
    ];
    for (const [url, key] of cases) {
      const error = errorOf(() => validateSupabaseConfig(url, key));
      expect(error.message).not.toContain(key);
      expect(error.message).not.toContain('hunter2');
      expect(error.message).not.toContain('private-host');
      expect(error.message).not.toContain('abcdefghijklmnopqrst');
      expect(String(error)).not.toContain(key);
    }
  });
});

describe('readSupabaseConfig', () => {
  it('reads SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY', () => {
    expect(SUPABASE_URL_ENV).toBe('SUPABASE_URL');
    expect(SUPABASE_PUBLISHABLE_KEY_ENV).toBe('SUPABASE_PUBLISHABLE_KEY');
    expect(readSupabaseConfig({ SUPABASE_URL: `${URL}/`, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE })).toEqual({
      url: URL,
      publishableKey: PUBLISHABLE,
    });
  });

  it('ignores SUPABASE_SECRET_KEY entirely, and refuses a secret placed in the publishable slot', () => {
    const env = { SUPABASE_URL: URL, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE, SUPABASE_SECRET_KEY: SECRET };
    const config = readSupabaseConfig(env);
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(codeOf(() => readSupabaseConfig({ SUPABASE_URL: URL, SUPABASE_PUBLISHABLE_KEY: SECRET }))).toBe('secretKey');
    expect(
      codeOf(() => readSupabaseConfig({ SUPABASE_URL: URL, SUPABASE_PUBLISHABLE_KEY: legacyKey('service_role') })),
    ).toBe('secretKey');
  });

  it('treats absent variables as missing', () => {
    expect(codeOf(() => readSupabaseConfig({}))).toBe('missing');
    expect(codeOf(() => readSupabaseConfig({ SUPABASE_URL: URL }))).toBe('invalidKey');
    expect(codeOf(() => readSupabaseConfig({ SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE }))).toBe('invalidUrl');
  });
});
