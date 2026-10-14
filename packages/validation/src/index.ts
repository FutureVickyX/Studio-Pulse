/**
 * @studio-pulse/validation — zod schemas for every user- or disk-supplied value.
 *
 * PUBLIC API CONTRACT. The UI validates before invoking a command; the Rust core re-validates
 * everything it receives (never trust the webview). The code lives in the sibling modules:
 *
 * - applications.ts  APPLICATION_ID_PATTERN, exePatternError, validateProcessMatcher,
 *                    validateApplicationInput, validateDefaultApplications
 *                    (rules mirror apps/desktop/src-tauri/src/registry/mod.rs)
 * - settings.ts      validateSettings, validateSettingsPatch (mirror src-tauri/src/settings.rs)
 * - ranges.ts        validateCustomRange
 * - issues.ts        ValidationResult and readable issue strings (`matchers[0].exe: must end with .exe`)
 *
 * Every validator returns `{ ok: true, value }` with the parsed value (strings trimmed where the
 * rule says "trimmed") or `{ ok: false, issues }` with one readable string per problem.
 */

export type { ValidationResult } from './issues';

export {
  APPLICATION_ID_PATTERN,
  exePatternError,
  validateApplicationInput,
  validateDefaultApplications,
  validateProcessMatcher,
} from './applications';
export { validateSettings, validateSettingsPatch } from './settings';
export { validateCustomRange } from './ranges';
