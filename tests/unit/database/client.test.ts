import { describe, expect, it } from 'vitest';

import { SupabaseConfigError, createStudioPulseClient } from '@studio-pulse/database';

import { fakeJwt, fakeSecretKey, legacyKey } from './helpers';

const URL = 'https://abcdefghijklmnopqrst.supabase.co';
const PUBLISHABLE = 'sb_publishable_AbCdEfGhIjKlMnOpQrStUv_1234567';

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
}

/** A fetch that records requests and answers with `body` (no network). */
function recordingFetch(respond: (url: string) => unknown = () => []) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, method: request.method, headers: request.headers });
    return new Response(JSON.stringify(respond(request.url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

interface AuthInternals {
  persistSession: boolean;
  autoRefreshToken: boolean;
  detectSessionInUrl: boolean;
}

describe('createStudioPulseClient', () => {
  it('sends every request to the project with the publishable key', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client = createStudioPulseClient({ url: `${URL}/`, publishableKey: PUBLISHABLE }, { fetch: fetchImpl });
    const { error } = await client.from('profiles').select('id, display_name');
    expect(error).toBeNull();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.startsWith(`${URL}/rest/v1/profiles?`)).toBe(true);
    expect(call.headers.get('apikey')).toBe(PUBLISHABLE);
  });

  it('calls RPCs at /rest/v1/rpc/<name>', async () => {
    const { calls, fetchImpl } = recordingFetch(() => [{ entry_id: null, status: 'rejected', detail: '22023: x' }]);
    const client = createStudioPulseClient({ url: URL, publishableKey: PUBLISHABLE }, { fetch: fetchImpl });
    const { data } = await client.rpc('sync_time_entries', { p_workspace_id: '00000000-0000-0000-0000-000000000000', p_entries: [] });
    expect(calls[0]?.url).toBe(`${URL}/rest/v1/rpc/sync_time_entries`);
    expect(calls[0]?.method).toBe('POST');
    expect(data?.[0]?.status).toBe('rejected');
  });

  it('keeps sessions in memory only by default (scripts), and persists them only on request', () => {
    const { fetchImpl } = recordingFetch();
    const scripted = createStudioPulseClient({ url: URL, publishableKey: PUBLISHABLE }, { fetch: fetchImpl });
    const auth = scripted.auth as unknown as AuthInternals;
    expect(auth.persistSession).toBe(false);
    expect(auth.autoRefreshToken).toBe(false);
    expect(auth.detectSessionInUrl).toBe(false);

    const memory = new Map<string, string>();
    const browser = createStudioPulseClient(
      { url: URL, publishableKey: PUBLISHABLE },
      {
        fetch: fetchImpl,
        persistSession: true,
        storage: {
          getItem: (k) => memory.get(k) ?? null,
          setItem: (k, v) => void memory.set(k, v),
          removeItem: (k) => void memory.delete(k),
        },
      },
    );
    const browserAuth = browser.auth as unknown as AuthInternals;
    expect(browserAuth.persistSession).toBe(true);
    expect(browserAuth.autoRefreshToken).toBe(true);
  });

  it('uses the signed-in session for later requests', async () => {
    const accessToken = fakeJwt({ sub: '11111111-1111-4111-8111-111111111111', role: 'authenticated', exp: 4_000_000_000 });
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.includes('/auth/v1/token')
        ? {
            access_token: accessToken,
            refresh_token: 'refresh-token-value',
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: 4_000_000_000,
            user: { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
          }
        : [],
    );
    const client = createStudioPulseClient({ url: URL, publishableKey: PUBLISHABLE }, { fetch: fetchImpl });
    const signIn = await client.auth.signInWithPassword({ email: 'a@example.com', password: 'correct horse battery staple' });
    expect(signIn.error).toBeNull();
    expect(calls[0]?.url).toBe(`${URL}/auth/v1/token?grant_type=password`);
    expect(calls[0]?.headers.get('apikey')).toBe(PUBLISHABLE);
    await client.from('time_entries').select('id');
    const rest = calls.find((c) => c.url.includes('/rest/v1/time_entries'));
    expect(rest?.headers.get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(rest?.headers.get('apikey')).toBe(PUBLISHABLE);
  });

  it('refuses secret keys before any request is made, even from a hand-made config object', () => {
    for (const key of [fakeSecretKey(), legacyKey('service_role')]) {
      const { calls, fetchImpl } = recordingFetch();
      let caught: unknown;
      try {
        createStudioPulseClient({ url: URL, publishableKey: key }, { fetch: fetchImpl });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SupabaseConfigError);
      expect((caught as SupabaseConfigError).code).toBe('secretKey');
      expect((caught as Error).message).not.toContain(key);
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses invalid configuration', () => {
    expect(() => createStudioPulseClient({ url: 'http://example.com', publishableKey: PUBLISHABLE })).toThrow(SupabaseConfigError);
    expect(() => createStudioPulseClient({ url: URL, publishableKey: 'nope' })).toThrow(SupabaseConfigError);
  });
});
