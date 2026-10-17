// Types for env.mjs (lets TypeScript tests import the script modules under `strict`).

/** Repository root. */
export declare const REPO_ROOT: string;
/** supabase/.env.local */
export declare const DEFAULT_ENV_FILE: string;

export interface ParsedEnv {
  /** Non-empty values only; the last assignment of a key wins. */
  values: Record<string, string>;
  /** 1-based numbers of lines that are neither blank, comments nor KEY=VALUE. */
  invalidLines: number[];
}

export interface LoadedEnv extends ParsedEnv {
  path: string;
  exists: boolean;
  /** Required keys that are absent or empty. */
  missing: string[];
}

export declare function parseEnv(text: string): ParsedEnv;
export declare function loadEnvFile(options?: { path?: string; required?: readonly string[] }): LoadedEnv;
export declare function describeMissing(loaded: { path: string; exists: boolean; missing: readonly string[] }): string;
export declare function stripBom(text: string): string;
