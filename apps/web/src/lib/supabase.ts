/**
 * The workspace's single Supabase client: the publishable key plus the signed-in user's session,
 * so every request is checked by Row Level Security. Built only through @studio-pulse/database,
 * which refuses secret / service-role keys (and so does the build, see vite.config.ts).
 */

import { SupabaseConfigError, createStudioPulseClient, readSupabaseConfig } from '@studio-pulse/database';
import type { StudioPulseClient } from '@studio-pulse/database';

export type ClientSetup = { ok: true; client: StudioPulseClient } | { ok: false; reason: string };

export interface WorkspaceEnv {
  readonly VITE_SUPABASE_URL?: string | undefined;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string | undefined;
}

/** Why the build cannot talk to Supabase, in words for the person who deploys it. */
function describeConfigError(error: unknown): string {
  if (error instanceof SupabaseConfigError) {
    switch (error.code) {
      case 'missing':
        return 'This build has no Supabase project configured (VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY).';
      case 'invalidUrl':
        return 'The configured Supabase URL is not valid.';
      case 'invalidKey':
        return 'The configured key is not a Supabase publishable key.';
      case 'secretKey':
        return 'The configured key is a secret key. The workspace only accepts the publishable key.';
    }
  }
  return 'The Supabase configuration could not be read.';
}

export function setUpClient(env: WorkspaceEnv): ClientSetup {
  try {
    const config = readSupabaseConfig({
      SUPABASE_URL: env.VITE_SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: env.VITE_SUPABASE_PUBLISHABLE_KEY,
    });
    // A browser app keeps the session across reloads and refreshes it in the background.
    return { ok: true, client: createStudioPulseClient(config, { persistSession: true, detectSessionInUrl: true }) };
  } catch (error) {
    return { ok: false, reason: describeConfigError(error) };
  }
}
