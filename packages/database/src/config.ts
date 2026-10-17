/**
 * Supabase project configuration for TypeScript callers (local scripts, tests, the future web app).
 *
 * Only two **public** values are accepted: the project URL and the publishable (or legacy "anon")
 * key. A secret / service-role key bypasses Row Level Security and is refused here, exactly as the
 * desktop refuses it (`apps/desktop/src-tauri/src/cloud/config.rs`):
 *
 * - `sb_secret_…`                      → secret, refused
 * - a JWT whose `role` is `service_role` → secret, refused
 * - `sb_publishable_…` or a JWT whose `role` is `anon` → accepted
 * - anything else                        → invalid
 *
 * Error messages never contain the key (or the URL, which could carry credentials).
 */

export interface SupabaseConfig {
  /** `https://<ref>.supabase.co`, or `http://127.0.0.1:<port>` / `http://localhost:<port>` for a local stack. No trailing slash. */
  readonly url: string;
  /** Publishable (`sb_publishable_…`) or legacy anon JWT. */
  readonly publishableKey: string;
}

/** Environment variable read by {@link readSupabaseConfig} for the project URL. */
export const SUPABASE_URL_ENV = 'SUPABASE_URL';
/** Environment variable read by {@link readSupabaseConfig} for the publishable key. */
export const SUPABASE_PUBLISHABLE_KEY_ENV = 'SUPABASE_PUBLISHABLE_KEY';

export type SupabaseKeyKind = 'publishable' | 'secret' | 'unknown';

/**
 * - `missing`     neither the URL nor the key is set
 * - `invalidUrl`  the URL is missing or not an https (or local http) project URL
 * - `invalidKey`  the key is missing or is not a publishable key
 * - `secretKey`   the key is a secret / service-role key
 */
export type SupabaseConfigErrorCode = 'missing' | 'invalidUrl' | 'invalidKey' | 'secretKey';

export class SupabaseConfigError extends Error {
  readonly code: SupabaseConfigErrorCode;

  constructor(code: SupabaseConfigErrorCode, message: string) {
    super(message);
    this.name = 'SupabaseConfigError';
    this.code = code;
  }
}

const SECRET_PREFIX = 'sb_secret_';
const PUBLISHABLE_PREFIX = 'sb_publishable_';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Classify a Supabase API key without any network access. JWT payloads are decoded, not
 * verified: this guards against shipping the wrong key, it is not authentication.
 */
export function classifySupabaseKey(key: string): SupabaseKeyKind {
  const trimmed = key.trim();
  // Case-insensitive on purpose: anything that looks like a secret key is treated as one.
  if (trimmed.toLowerCase().startsWith(SECRET_PREFIX)) return 'secret';
  if (trimmed.startsWith(PUBLISHABLE_PREFIX)) {
    return /^[A-Za-z0-9_-]+$/.test(trimmed.slice(PUBLISHABLE_PREFIX.length)) ? 'publishable' : 'unknown';
  }
  const role = jwtRole(trimmed);
  if (role === 'service_role') return 'secret';
  if (role === 'anon') return 'publishable';
  return 'unknown';
}

/** The top-level `role` claim of an (unverified) JWT, or null if `token` is not a JWT. */
function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  if (!header || !payload || !BASE64URL.test(header) || !BASE64URL.test(payload) || !BASE64URL.test(signature)) {
    return null;
  }
  const json = decodeBase64Url(payload);
  if (json === null) return null;
  try {
    const claims: unknown = JSON.parse(json);
    if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) return null;
    const role = (claims as Record<string, unknown>).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(segment: string): string | null {
  if (segment.length % 4 === 1) return null;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function normaliseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') throw new SupabaseConfigError('invalidUrl', 'The Supabase project URL is missing.');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SupabaseConfigError('invalidUrl', 'The Supabase project URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname))) {
    throw new SupabaseConfigError(
      'invalidUrl',
      'The Supabase project URL must use https (plain http is allowed only for localhost / 127.0.0.1).',
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SupabaseConfigError('invalidUrl', 'The Supabase project URL must not contain credentials.');
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new SupabaseConfigError(
      'invalidUrl',
      'The Supabase project URL must be the bare project URL (no path, query or fragment).',
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function checkKey(raw: string): string {
  const key = raw.trim();
  if (key === '') throw new SupabaseConfigError('invalidKey', 'The Supabase publishable key is missing.');
  const kind = classifySupabaseKey(key);
  if (kind === 'secret') {
    throw new SupabaseConfigError(
      'secretKey',
      'A secret (service-role) key was supplied where the publishable key belongs. Only the publishable key may be used by clients.',
    );
  }
  if (kind !== 'publishable') {
    throw new SupabaseConfigError(
      'invalidKey',
      'The Supabase key is not a publishable key (expected sb_publishable_… or the legacy anon key).',
    );
  }
  return key;
}

/**
 * Validate and normalise (trim, strip trailing `/`). Throws {@link SupabaseConfigError}; a secret
 * key is reported as `secretKey` even when the URL is also wrong.
 */
export function validateSupabaseConfig(url: string, publishableKey: string): SupabaseConfig {
  const urlMissing = url.trim() === '';
  const keyMissing = publishableKey.trim() === '';
  if (urlMissing && keyMissing) {
    throw new SupabaseConfigError(
      'missing',
      `Supabase is not configured (${SUPABASE_URL_ENV} and ${SUPABASE_PUBLISHABLE_KEY_ENV} are empty).`,
    );
  }
  if (!keyMissing && classifySupabaseKey(publishableKey) === 'secret') checkKey(publishableKey);
  const normalisedUrl = normaliseUrl(url);
  return { url: normalisedUrl, publishableKey: checkKey(publishableKey) };
}

/**
 * Read `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from an environment object (`process.env`,
 * a parsed env file, `import.meta.env` mapped by the caller) and validate them.
 */
export function readSupabaseConfig(env: Readonly<Record<string, string | undefined>>): SupabaseConfig {
  return validateSupabaseConfig(env[SUPABASE_URL_ENV] ?? '', env[SUPABASE_PUBLISHABLE_KEY_ENV] ?? '');
}
