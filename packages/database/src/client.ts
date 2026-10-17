import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient, SupabaseClientOptions } from '@supabase/supabase-js';

import { validateSupabaseConfig } from './config';
import type { SupabaseConfig } from './config';
import type { Database } from './types';

/** A supabase-js client typed with the Studio Pulse schema. */
export type StudioPulseClient = SupabaseClient<Database>;

type AuthOptions = NonNullable<SupabaseClientOptions<'public'>['auth']>;

export interface StudioPulseClientOptions {
  /**
   * Keep the signed-in session in `storage` across page loads (browser apps). Default `false`:
   * scripts and tests hold the session in memory only and it disappears with the process.
   */
  persistSession?: boolean;
  /** Refresh the access token before it expires. Default: same as `persistSession`. */
  autoRefreshToken?: boolean;
  /** Where a persisted session lives (defaults to supabase-js' choice, `localStorage` in browsers). */
  storage?: AuthOptions['storage'];
  /** Pick up an OAuth / magic-link session from the URL (browser apps). Default `false`. */
  detectSessionInUrl?: boolean;
  /** Custom fetch (tests, instrumentation). */
  fetch?: typeof fetch;
}

/**
 * The single TypeScript Supabase client factory. It always uses the publishable key, so every
 * request runs as `anon` or as the signed-in user and is subject to Row Level Security.
 *
 * The configuration is validated again here, so a secret / service-role key can never reach a
 * client built by this function, even from a hand-made config object. (Local admin scripts that
 * legitimately need the secret key create their own client and never import this package.)
 */
export function createStudioPulseClient(
  config: SupabaseConfig,
  options: StudioPulseClientOptions = {},
): StudioPulseClient {
  const { url, publishableKey } = validateSupabaseConfig(config.url, config.publishableKey);
  const persistSession = options.persistSession ?? false;
  const auth: AuthOptions = {
    persistSession,
    autoRefreshToken: options.autoRefreshToken ?? persistSession,
    detectSessionInUrl: options.detectSessionInUrl ?? false,
  };
  if (options.storage) auth.storage = options.storage;
  return createClient<Database>(url, publishableKey, {
    auth,
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
}
