/**
 * Turning zod issues into short, readable strings: `matchers[0].exe: must end with .exe`.
 */

import { z } from 'zod';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

const EXPECTED_LABELS: Readonly<Record<string, string>> = {
  string: 'must be text',
  number: 'must be a number',
  int: 'must be a whole number',
  boolean: 'must be true or false',
  array: 'must be a list',
  object: 'must be an object',
  null: 'must be null',
};

function describeCount(count: number | bigint, singular: string): string {
  return `${count} ${singular}${count === 1 || count === 1n ? '' : 's'}`;
}

/**
 * Per-parse error map. Only issues without an explicit message reach it; schema-level messages
 * (custom refinements, `{ error }` params) take precedence.
 */
const errorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) return 'is required';
      return EXPECTED_LABELS[issue.expected] ?? `must be ${issue.expected}`;
    case 'invalid_value':
      if (issue.input === undefined) return 'is required';
      return `must be one of: ${issue.values.map(String).join(', ')}`;
    case 'too_small':
      if (issue.origin === 'string') {
        return issue.minimum === 1 ? 'must not be empty' : `must be at least ${describeCount(issue.minimum, 'character')}`;
      }
      if (issue.origin === 'array') return `must have at least ${describeCount(issue.minimum, 'item')}`;
      return `must be at least ${issue.minimum}`;
    case 'too_big':
      if (issue.origin === 'string') return `must be at most ${describeCount(issue.maximum, 'character')}`;
      if (issue.origin === 'array') return `must have at most ${describeCount(issue.maximum, 'item')}`;
      return `must be at most ${issue.maximum}`;
    case 'unrecognized_keys': {
      const keys = issue.keys.map((key) => `"${key}"`).join(', ');
      return issue.keys.length === 1 ? `unknown field ${keys}` : `unknown fields ${keys}`;
    }
    case 'invalid_format':
      if (issue.format === 'datetime') return 'must be an ISO-8601 date-time with a time zone, e.g. 2026-10-13T09:15:00Z';
      return 'has an invalid format';
    default:
      return undefined;
  }
};

/** `["matchers", 0, "exe"]` → `matchers[0].exe`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out.length === 0 ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

export function formatIssue(path: readonly PropertyKey[], message: string): string {
  const where = formatPath(path);
  return where.length > 0 ? `${where}: ${message}` : message;
}

/** Run a schema and convert its outcome to a ValidationResult with readable issue strings. */
export function runSchema<T>(schema: z.ZodType<T>, input: unknown): ValidationResult<T> {
  const result = schema.safeParse(input, { error: errorMap });
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((issue) => formatIssue(issue.path, issue.message));
  return { ok: false, issues: [...new Set(issues)] };
}

const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/**
 * Trim exactly like Rust's `str::trim`, which removes characters with the Unicode `White_Space`
 * property. JavaScript's `String.prototype.trim` differs at the edges: it also strips U+FEFF and
 * keeps U+0085, so using it would let the UI accept names the Rust core rejects (and vice versa).
 */
export function trimWhiteSpace(value: string): string {
  return value.replace(EDGE_WHITE_SPACE, '');
}

/**
 * Length in UTF-16 code units: JavaScript's `String.length`, and what the Rust core counts
 * (`str::encode_utf16().count()` in `src-tauri/src/registry/validation.rs`). An emoji outside the
 * Basic Multilingual Plane counts as 2.
 */
export function textLength(value: string): number {
  return value.length;
}

/**
 * A string that is trimmed (Rust semantics), then required to be `min..max` UTF-16 units long.
 * The parsed value is the trimmed string.
 */
export function boundedText(min: number, max: number) {
  return z
    .string()
    .overwrite(trimWhiteSpace)
    .superRefine((value, ctx) => {
      const length = textLength(value);
      if (length < min) {
        ctx.addIssue({
          code: 'custom',
          message: min === 1 ? 'must not be empty' : `must be at least ${min} characters`,
        });
      } else if (length > max) {
        ctx.addIssue({ code: 'custom', message: `must be at most ${max} characters` });
      }
    });
}

/** An integer in `[min, max]` with a single clear message for both bounds. */
export function integerInRange(min: number, max: number) {
  const message = `must be a whole number between ${min} and ${max}`;
  return z.number().int({ error: message }).min(min, { error: message }).max(max, { error: message });
}
