// Types for keys.mjs.

export type KeyKind = 'publishable' | 'secret' | 'unknown';

/** Same rule as packages/database `classifySupabaseKey` and the desktop's `cloud::config::classify_key`. */
export declare function classifyKey(key: string): KeyKind;
/** The top-level `role` claim of an unverified JWT, or null when `token` is not a decodable JWT. */
export declare function jwtRole(token: string): string | null;
