/**
 * @studio-pulse/validation — zod schemas for every user- or disk-supplied value.
 *
 * PUBLIC API CONTRACT (implementations pending). The UI validates before invoking a command; the
 * Rust core re-validates everything it receives (never trust the webview).
 */

import type {
  ApplicationInput,
  DefaultApplicationsFile,
  ProcessMatcher,
  Settings,
  SettingsPatch,
} from '@studio-pulse/shared-types';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Application ids: lowercase slug, 2–64 chars. Custom apps use `custom-<suffix>`. */
export const APPLICATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Returns an error message for an invalid `exe` pattern, or null when valid.
 * Rules: 1–260 chars, ends with `.exe` (case-insensitive), no path separators (`\` `/`), no `:`,
 * at most 4 `*` wildcards, not just `*.exe`.
 */
export function exePatternError(_pattern: string): string | null {
  throw new Error('not implemented');
}

export function validateProcessMatcher(_input: unknown): ValidationResult<ProcessMatcher> {
  throw new Error('not implemented');
}

/** displayName 1–80 chars (trimmed), known category, 1–16 matchers, booleans present. */
export function validateApplicationInput(_input: unknown): ValidationResult<ApplicationInput> {
  throw new Error('not implemented');
}

/** Full settings document (as stored), with SETTINGS_LIMITS enforced. */
export function validateSettings(_input: unknown): ValidationResult<Settings> {
  throw new Error('not implemented');
}

/** Partial patch; unknown keys rejected; numeric ranges enforced; integers only. */
export function validateSettingsPatch(_input: unknown): ValidationResult<SettingsPatch> {
  throw new Error('not implemented');
}

/**
 * The built-in registry file: unique ids, valid categories and matchers, no two applications
 * sharing an identical (exe, pathIncludes) matcher.
 */
export function validateDefaultApplications(_input: unknown): ValidationResult<DefaultApplicationsFile> {
  throw new Error('not implemented');
}

/** `YYYY-MM-DD` pair for the custom range picker; start ≤ end; span ≤ 366 days. */
export function validateCustomRange(_start: string, _end: string): ValidationResult<{ start: string; end: string }> {
  throw new Error('not implemented');
}
