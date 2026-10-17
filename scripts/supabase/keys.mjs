// Supabase API key classification for the local scripts — the same rule as
// packages/database/src/config.ts (classifySupabaseKey) and the desktop's cloud/config.rs:
//
//   sb_secret_…  or a JWT whose role is service_role  → 'secret'
//   sb_publishable_… or a JWT whose role is anon       → 'publishable'
//   anything else                                      → 'unknown'
//
// JWTs are decoded, never verified. Nothing here prints or returns key material.
// (tests/unit/database/keys.test.ts checks this file and the TypeScript package agree.)

const SECRET_PREFIX = 'sb_secret_';
const PUBLISHABLE_PREFIX = 'sb_publishable_';
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * @param {string} key
 * @returns {'publishable' | 'secret' | 'unknown'}
 */
export function classifyKey(key) {
  const trimmed = String(key).trim();
  if (trimmed.toLowerCase().startsWith(SECRET_PREFIX)) return 'secret';
  if (trimmed.startsWith(PUBLISHABLE_PREFIX)) {
    return /^[A-Za-z0-9_-]+$/.test(trimmed.slice(PUBLISHABLE_PREFIX.length)) ? 'publishable' : 'unknown';
  }
  const role = jwtRole(trimmed);
  if (role === 'service_role') return 'secret';
  if (role === 'anon') return 'publishable';
  return 'unknown';
}

/**
 * The top-level `role` claim of an unverified JWT, or null when `token` is not a decodable JWT.
 * @param {string} token
 * @returns {string | null}
 */
export function jwtRole(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !BASE64URL.test(header) || !BASE64URL.test(payload) || !BASE64URL.test(signature)) {
    return null;
  }
  if (payload.length % 4 === 1) return null;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(payload, 'base64url'));
    const claims = JSON.parse(json);
    if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) return null;
    return typeof claims.role === 'string' ? claims.role : null;
  } catch {
    return null;
  }
}
