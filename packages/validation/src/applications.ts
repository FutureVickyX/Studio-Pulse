/**
 * Application registry inputs: process matchers, `save_application` payloads and the built-in
 * defaults file. Rules mirror `apps/desktop/src-tauri/src/registry/mod.rs`.
 */

import { z } from 'zod';
import { APP_CATEGORIES } from '@studio-pulse/shared-types';
import type {
  ApplicationInput,
  DefaultApplication,
  DefaultApplicationsFile,
  ProcessMatcher,
} from '@studio-pulse/shared-types';

import { boundedText, codePointLength, runSchema } from './issues';
import type { ValidationResult } from './issues';

/** Application ids: lowercase slug, 2–64 chars. Custom apps use `custom-<suffix>`. */
export const APPLICATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const EXE_PATTERN_MAX_LENGTH = 260;
export const EXE_PATTERN_MAX_WILDCARDS = 4;
export const PATH_INCLUDES_MAX_LENGTH = 260;
export const DISPLAY_NAME_MAX_LENGTH = 80;
export const MAX_MATCHERS = 16;

const EXE_SUFFIX = '.exe';

/**
 * Returns an error message for an invalid `exe` pattern, or null when valid.
 * Rules (checked on the trimmed value): 1–260 chars, ends with `.exe` (case-insensitive), no path
 * separators (`\` `/`), no `:`, at most 4 `*` wildcards, and at least one non-`*` character before
 * `.exe` (so `*.exe` cannot match every process).
 */
export function exePatternError(pattern: string): string | null {
  if (typeof pattern !== 'string') return 'must be text';
  const value = pattern.trim();
  if (value.length === 0) return 'must not be empty';
  if (codePointLength(value) > EXE_PATTERN_MAX_LENGTH) {
    return `must be at most ${EXE_PATTERN_MAX_LENGTH} characters`;
  }
  if (/[\\/:]/.test(value)) return 'must be a file name only (no \\, / or :)';
  if (!value.toLowerCase().endsWith(EXE_SUFFIX)) return 'must end with .exe';
  const wildcards = value.split('*').length - 1;
  if (wildcards > EXE_PATTERN_MAX_WILDCARDS) {
    return `may contain at most ${EXE_PATTERN_MAX_WILDCARDS} * wildcards`;
  }
  const stem = value.slice(0, -EXE_SUFFIX.length);
  if (!/[^*]/.test(stem)) return 'must name the program, not only * before .exe';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

const exeSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const message = exePatternError(value);
    if (message !== null) ctx.addIssue({ code: 'custom', message });
  });

export const processMatcherSchema = z.strictObject({
  exe: exeSchema,
  pathIncludes: boundedText(1, PATH_INCLUDES_MAX_LENGTH).nullable().optional(),
});

const ID_MESSAGE = 'must be 2–64 lowercase letters, digits or hyphens, starting with a letter or digit';

const applicationIdSchema = z.string().regex(APPLICATION_ID_PATTERN, { error: ID_MESSAGE });
const categorySchema = z.enum(APP_CATEGORIES);
const matchersSchema = z.array(processMatcherSchema).min(1).max(MAX_MATCHERS);
const displayNameSchema = boundedText(1, DISPLAY_NAME_MAX_LENGTH);

/** `save_application` payload. A missing `id` is read as `null` (create), as serde does. */
export const applicationInputSchema = z.object({
  id: applicationIdSchema.nullable().default(null),
  displayName: displayNameSchema,
  category: categorySchema,
  matchers: matchersSchema,
  enabled: z.boolean(),
  includeInReports: z.boolean(),
});

const defaultApplicationSchema = z.strictObject({
  id: applicationIdSchema,
  displayName: displayNameSchema,
  category: categorySchema,
  enabledByDefault: z.boolean(),
  matchers: matchersSchema,
});

function matcherKey(matcher: ProcessMatcher): string {
  return JSON.stringify([matcher.exe.toLowerCase(), matcher.pathIncludes?.toLowerCase() ?? null]);
}

export const defaultApplicationsFileSchema = z
  .strictObject({
    $comment: z.string().optional(),
    version: z.number().int().min(1),
    applications: z.array(defaultApplicationSchema),
  })
  .superRefine((file, ctx) => {
    const idOwners = new Map<string, number>();
    const matcherOwners = new Map<string, { app: number; matcher: number }>();
    file.applications.forEach((app: DefaultApplication, appIndex) => {
      const firstWithId = idOwners.get(app.id);
      if (firstWithId === undefined) idOwners.set(app.id, appIndex);
      else {
        ctx.addIssue({
          code: 'custom',
          path: ['applications', appIndex, 'id'],
          message: `duplicate id "${app.id}" (also used by applications[${firstWithId}])`,
        });
      }
      app.matchers.forEach((matcher, matcherIndex) => {
        const key = matcherKey(matcher);
        const owner = matcherOwners.get(key);
        if (owner === undefined) {
          matcherOwners.set(key, { app: appIndex, matcher: matcherIndex });
          return;
        }
        const ownerApp = file.applications[owner.app];
        ctx.addIssue({
          code: 'custom',
          path: ['applications', appIndex, 'matchers', matcherIndex],
          message: `duplicates the matcher at applications[${owner.app}].matchers[${owner.matcher}]${
            ownerApp && owner.app !== appIndex ? ` ("${ownerApp.id}")` : ''
          }`,
        });
      });
    });
  })
  .transform(({ version, applications }): DefaultApplicationsFile => ({ version, applications }));

// ---------------------------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------------------------

export function validateProcessMatcher(input: unknown): ValidationResult<ProcessMatcher> {
  return runSchema(processMatcherSchema, input);
}

/** displayName 1–80 chars (trimmed), known category, 1–16 matchers, booleans present. */
export function validateApplicationInput(input: unknown): ValidationResult<ApplicationInput> {
  return runSchema(applicationInputSchema, input);
}

/**
 * The built-in registry file: unique ids, valid categories and matchers, no two applications
 * sharing an identical (exe, pathIncludes) matcher (compared case-insensitively).
 */
export function validateDefaultApplications(input: unknown): ValidationResult<DefaultApplicationsFile> {
  return runSchema(defaultApplicationsFileSchema, input);
}

