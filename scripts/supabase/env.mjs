// Loader for supabase/.env.local (gitignored). Local admin scripts only.
//
// Format: one KEY=VALUE per line. `#` starts a comment line; an unquoted value may end with an
// inline comment (` # ...`, whitespace before the `#`). Values may be wrapped in single or double
// quotes, which are removed (no escape processing). An optional leading `export ` is accepted.
// Empty values count as missing.
//
// This module never prints anything and never puts a value in an error message: problems are
// reported by key name and line number only.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (two levels above this file). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Default env file: supabase/.env.local. */
export const DEFAULT_ENV_FILE = resolve(REPO_ROOT, 'supabase', '.env.local');

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse env-file text.
 * @param {string} text
 * @returns {{ values: Record<string, string>, invalidLines: number[] }}
 *   `values` holds non-empty values only (the last assignment of a key wins); `invalidLines` are
 *   1-based line numbers that are neither blank, comments nor KEY=VALUE.
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const values = Object.create(null);
  /** @type {number[]} */
  const invalidLines = [];
  const lines = stripBom(text).split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;
    const body = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eq = body.indexOf('=');
    const key = eq > 0 ? body.slice(0, eq).trim() : '';
    if (!KEY.test(key)) {
      invalidLines.push(index + 1);
      return;
    }
    const value = parseValue(body.slice(eq + 1).trim());
    if (value === null) {
      invalidLines.push(index + 1);
      return;
    }
    if (value === '') delete values[key];
    else values[key] = value;
  });
  return { values: { ...values }, invalidLines };
}

/**
 * @param {string} raw text after `=`, trimmed
 * @returns {string | null} the value, or null when a quote is not closed properly
 */
function parseValue(raw) {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    if (end < 0) return null;
    const rest = raw.slice(end + 1).trim();
    if (rest !== '' && !rest.startsWith('#')) return null;
    return raw.slice(1, end);
  }
  const comment = raw.search(/\s#/);
  return (comment >= 0 ? raw.slice(0, comment) : raw).trim();
}

/**
 * Load an env file and report which of `required` are missing (absent or empty).
 * A missing file is not an error: every required key is then missing and `exists` is false.
 * @param {{ path?: string, required?: readonly string[] }} [options]
 * @returns {{ path: string, exists: boolean, values: Record<string, string>, missing: string[], invalidLines: number[] }}
 */
export function loadEnvFile({ path = DEFAULT_ENV_FILE, required = [] } = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { path, exists: false, values: {}, missing: [...required], invalidLines: [] };
    }
    throw new Error(`Cannot read ${path} (${describeFsError(error)}).`);
  }
  const { values, invalidLines } = parseEnv(text);
  const missing = required.filter((key) => !Object.hasOwn(values, key));
  return { path, exists: true, values, missing, invalidLines };
}

/**
 * A one-paragraph explanation for missing keys (names only, never values).
 * @param {{ path: string, exists: boolean, missing: readonly string[] }} loaded
 */
export function describeMissing(loaded) {
  const where = loaded.exists
    ? loaded.path
    : `${loaded.path} (file not found: copy supabase/.env.example to supabase/.env.local)`;
  return `Missing in ${where}: ${loaded.missing.join(', ')}.`;
}

/**
 * @param {string} text
 * @returns {string} `text` without a leading UTF-8 byte-order mark
 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** @param {unknown} error */
function describeFsError(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown error';
}
