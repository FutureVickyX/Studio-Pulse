// The scanner behind scripts/check-bundle-secrets.mjs (unit-tested in
// tests/unit/database/secret-scan.test.ts): build outputs and desktop sources must never contain
// Supabase secrets.
//
//   npm run check:secrets                      scan the default targets (below)
//   npm run check:secrets -- <file|dir> ...    scan these instead
//   options: --env-path <path>  (default supabase/.env.local)   --no-allowlist   --help
//
// Default targets: apps/desktop/dist (the webview bundle), the release executable and the NSIS
// installer(s) under $CARGO_TARGET_DIR/release (default %LOCALAPPDATA%/studio-pulse-build/target,
// the location docs/installation.md sets up), and apps/desktop/src-tauri/src. Missing default
// targets are reported and skipped (e.g. no release build yet); a missing explicit path is an
// error.
//
// Exit 0: nothing found. Exit 1: findings (file + kind + line/offset; the matched text is NEVER
// printed). Exit 2: usage error or nothing could be scanned.
//
// What is looked for (in UTF-8/ASCII and UTF-16LE):
//   always fatal ("leaks"):
//     configured-secret-key       the literal SUPABASE_SECRET_KEY value from supabase/.env.local
//     configured-db-url           the literal SUPABASE_DB_URL value
//     configured-db-password      the password inside SUPABASE_DB_URL (8+ characters)
//     sb-secret-key               sb_secret_ followed by key material
//     service-role-jwt            a JWT whose payload role is service_role
//     user-jwt                    a JWT whose payload role is authenticated (a user's access token)
//     postgres-connection-string  postgres:// or postgresql:// URLs
//   fatal unless allowlisted for that file ("references"):
//     sb-secret-prefix            the bare "sb_secret_" prefix
//     service-role-mention        "service_role"
//     secret-key-env-name         "SUPABASE_SECRET_KEY"
//     db-url-env-name             "SUPABASE_DB_URL"
//
// The desktop must recognise secret keys in order to refuse them, so its rejection rule
// (cloud/config.rs, and its compiled copy in the executable) necessarily contains the bare
// "sb_secret_" prefix and the "service_role" claim name. DEFAULT_ALLOWLIST permits exactly those
// two reference kinds there and nowhere else; real key material is still always fatal.
//
// Limits: compressed content cannot be searched. The NSIS installer's payload and the frontend
// assets Tauri embeds in the executable are compressed, which is why dist/ and the release
// executable are scanned directly.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

import { DEFAULT_ENV_FILE, REPO_ROOT, loadEnvFile } from './env.mjs';
import { jwtRole } from './keys.mjs';

/** Kinds that no allowlist can excuse. */
export const LEAK_KINDS = Object.freeze([
  'configured-secret-key',
  'configured-db-url',
  'configured-db-password',
  'sb-secret-key',
  'service-role-jwt',
  'user-jwt',
  'postgres-connection-string',
]);

/** Kinds that an allowlist entry may permit for a specific file. */
export const REFERENCE_KINDS = Object.freeze([
  'sb-secret-prefix',
  'service-role-mention',
  'secret-key-env-name',
  'db-url-env-name',
]);

/**
 * @typedef {{ kinds: readonly string[], reason: string, path?: string, binaryName?: RegExp }} AllowEntry
 *   `path`: repository-relative path (forward slashes) of a source file;
 *   `binaryName`: file-name pattern of a build output (matched anywhere).
 */

/** @type {readonly AllowEntry[]} */
export const DEFAULT_ALLOWLIST = Object.freeze([
  {
    path: 'apps/desktop/src-tauri/src/cloud/config.rs',
    kinds: ['sb-secret-prefix', 'service-role-mention'],
    reason: "the desktop's secret-key rejection rule",
  },
  {
    path: 'apps/desktop/src-tauri/build.rs',
    kinds: ['sb-secret-prefix', 'service-role-mention'],
    reason: 'the build-time refusal to embed a secret key',
  },
  {
    binaryName: /^(studio-pulse\.exe|studio_pulse.*\.(dll|rlib)|.*-setup\.exe)$/i,
    kinds: ['sb-secret-prefix', 'service-role-mention'],
    reason: 'the compiled copy of the rejection rule (cloud/config.rs)',
  },
]);

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * @typedef {{ kind: string, value: string }} Literal  an exact configured secret value
 * @typedef {{ kind: string, count: number, firstOffset: number, encoding: 'utf8' | 'utf16le' }} Finding
 */

const PATTERNS = /** @type {const} */ ([
  { kind: 'sb-secret-key', re: /sb_secret_[A-Za-z0-9_-]{16,}/gi },
  { kind: 'sb-secret-prefix', re: /sb_secret_(?![A-Za-z0-9_-]{16})/gi },
  { kind: 'service-role-mention', re: /service_role/gi },
  { kind: 'secret-key-env-name', re: /SUPABASE_SECRET_KEY/g },
  { kind: 'db-url-env-name', re: /SUPABASE_DB_URL/g },
  { kind: 'postgres-connection-string', re: /postgres(?:ql)?:\/\/[^\s"'`<>\\]+/gi },
]);
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/**
 * Search one decoded view of a file.
 * @param {string} text
 * @param {(index: number) => number} toOffset
 * @param {'utf8' | 'utf16le'} encoding
 * @param {Map<string, Finding>} into
 */
function scanText(text, toOffset, encoding, into) {
  /** @param {string} kind @param {number} index */
  const add = (kind, index) => {
    const offset = toOffset(index);
    const existing = into.get(kind);
    if (existing) {
      existing.count += 1;
      if (offset < existing.firstOffset) {
        existing.firstOffset = offset;
        existing.encoding = encoding;
      }
    } else {
      into.set(kind, { kind, count: 1, firstOffset: offset, encoding });
    }
  };
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) add(kind, match.index ?? 0);
  }
  JWT.lastIndex = 0;
  for (const match of text.matchAll(JWT)) {
    const role = jwtRole(match[0]);
    if (role === 'service_role') add('service-role-jwt', match.index ?? 0);
    else if (role === 'authenticated') add('user-jwt', match.index ?? 0);
  }
}

/**
 * Find secrets in a file's bytes. Returns one Finding per kind (count, first byte offset).
 * Never returns matched text.
 * @param {Buffer} buf
 * @param {{ literals?: readonly Literal[] }} [options]
 * @returns {Finding[]}
 */
export function scanBuffer(buf, { literals = [] } = {}) {
  /** @type {Map<string, Finding>} */
  const found = new Map();
  for (const { kind, value } of literals) {
    if (!value || value.length < 8) continue;
    for (const encoding of /** @type {const} */ (['utf8', 'utf16le'])) {
      const needle = Buffer.from(value, encoding);
      let index = buf.indexOf(needle);
      while (index >= 0) {
        const existing = found.get(kind);
        if (existing) existing.count += 1;
        else found.set(kind, { kind, count: 1, firstOffset: index, encoding });
        index = buf.indexOf(needle, index + needle.length);
      }
    }
  }
  // Byte-preserving view: every ASCII pattern matches at its byte offset.
  scanText(buf.toString('latin1'), (i) => i, 'utf8', found);
  // UTF-16LE views at both alignments (Windows resources, wide string literals). Only worth it
  // when the file contains NUL bytes; plain text cannot hold UTF-16 ASCII.
  if (buf.includes(0)) {
    scanText(buf.toString('utf16le'), (i) => i * 2, 'utf16le', found);
    if (buf.length > 1) scanText(buf.subarray(1).toString('utf16le'), (i) => i * 2 + 1, 'utf16le', found);
  }
  return [...found.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * The secret values configured in the env file, as exact-match literals (never printed).
 * @param {Readonly<Record<string, string>>} values
 * @returns {Literal[]}
 */
export function configuredLiterals(values) {
  /** @type {Literal[]} */
  const literals = [];
  const secretKey = values.SUPABASE_SECRET_KEY;
  if (secretKey) literals.push({ kind: 'configured-secret-key', value: secretKey });
  const dbUrl = values.SUPABASE_DB_URL;
  if (dbUrl) {
    literals.push({ kind: 'configured-db-url', value: dbUrl });
    try {
      const raw = new URL(dbUrl).password;
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        // keep the raw form
      }
      for (const value of new Set([raw, decoded])) {
        if (value.length >= 8) literals.push({ kind: 'configured-db-password', value });
      }
    } catch {
      // not a URL: the whole value is still checked
    }
  }
  return literals;
}

/**
 * @param {string} file absolute path
 * @param {string} kind
 * @param {readonly AllowEntry[]} allowlist
 * @returns {AllowEntry | undefined}
 */
export function allowedBy(file, kind, allowlist) {
  if (LEAK_KINDS.includes(kind)) return undefined;
  const rel = relative(REPO_ROOT, file).replaceAll('\\', '/');
  const name = basename(file);
  return allowlist.find(
    (entry) =>
      entry.kinds.includes(kind) &&
      ((entry.path !== undefined && entry.path === rel) || (entry.binaryName !== undefined && entry.binaryName.test(name))),
  );
}

/**
 * Line (1-based) of a byte offset in a text file.
 * @param {Buffer} buf
 * @param {number} offset
 */
function lineOf(buf, offset) {
  let line = 1;
  let i = buf.indexOf(10);
  while (i >= 0 && i < offset) {
    line += 1;
    i = buf.indexOf(10, i + 1);
  }
  return line;
}

/**
 * Files under `path` (recursively), skipping node_modules/.git and symbolic links.
 * @param {string} path
 * @returns {string[]}
 */
export function listFiles(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    files.push(...listFiles(join(path, entry.name)));
  }
  return files;
}

/**
 * The default scan targets: `[path, description]`.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ path: string, label: string }[]}
 */
export function defaultTargets(env = process.env) {
  const targetDir = env.CARGO_TARGET_DIR
    ? resolve(env.CARGO_TARGET_DIR)
    : env.LOCALAPPDATA
      ? join(env.LOCALAPPDATA, 'studio-pulse-build', 'target')
      : join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'target');
  const release = join(targetDir, 'release');
  /** @type {{ path: string, label: string }[]} */
  const targets = [
    { path: join(REPO_ROOT, 'apps', 'desktop', 'dist'), label: 'webview bundle' },
    { path: join(release, 'studio-pulse.exe'), label: 'release executable' },
  ];
  const nsis = join(release, 'bundle', 'nsis');
  try {
    for (const name of readdirSync(nsis).sort()) {
      if (name.toLowerCase().endsWith('.exe')) targets.push({ path: join(nsis, name), label: 'NSIS installer' });
    }
  } catch {
    targets.push({ path: join(nsis, '*-setup.exe'), label: 'NSIS installer' });
  }
  targets.push({ path: join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'src'), label: 'desktop Rust sources' });
  return targets;
}

/**
 * @typedef {{ file: string, kind: string, count: number, location: string, allowed?: string }} Reported
 */

/**
 * Scan files; returns findings per file, split into leaks and allowlisted references.
 * @param {readonly string[]} files
 * @param {{ literals?: readonly Literal[], allowlist?: readonly AllowEntry[] }} [options]
 */
export function scanFiles(files, { literals = [], allowlist = DEFAULT_ALLOWLIST } = {}) {
  /** @type {Reported[]} */
  const failures = [];
  /** @type {Reported[]} */
  const allowed = [];
  /** @type {string[]} */
  const skipped = [];
  let bytes = 0;
  let scanned = 0;
  for (const file of files) {
    const size = lstatSync(file).size;
    if (size > MAX_FILE_BYTES) {
      skipped.push(file);
      continue;
    }
    const buf = readFileSync(file);
    bytes += buf.length;
    scanned += 1;
    const binary = buf.includes(0);
    for (const finding of scanBuffer(buf, { literals })) {
      const location = binary
        ? `offset 0x${finding.firstOffset.toString(16)}${finding.encoding === 'utf16le' ? ' (UTF-16)' : ''}`
        : `line ${lineOf(buf, finding.firstOffset)}`;
      const entry = allowedBy(file, finding.kind, allowlist);
      const reported = { file, kind: finding.kind, count: finding.count, location };
      if (entry) allowed.push({ ...reported, allowed: entry.reason });
      else failures.push(reported);
    }
  }
  return { failures, allowed, skipped, scanned, bytes };
}

const USAGE = `Usage: node scripts/check-bundle-secrets.mjs [options] [file|dir ...]

  (no paths)          scan apps/desktop/dist, the release exe, the NSIS installer(s) and
                      apps/desktop/src-tauri/src
  --env-path <path>   where to read SUPABASE_SECRET_KEY / SUPABASE_DB_URL values to look for
                      (default: supabase/.env.local; values are never printed)
  --no-allowlist      also fail on the reference kinds the default allowlist permits`;

/** @param {string} path */
function display(path) {
  const rel = relative(REPO_ROOT, path);
  return (rel.startsWith('..') || isAbsolute(rel) ? path : rel).replaceAll('\\', '/');
}

/**
 * @param {string[]} argv
 * @param {{ out?: (line: string) => void, err?: (line: string) => void, env?: NodeJS.ProcessEnv }} [io]
 * @returns {number} exit code
 */
export function main(argv, { out = (l) => console.log(l), err = (l) => console.error(l), env = process.env } = {}) {
  let envFile = DEFAULT_ENV_FILE;
  let useAllowlist = true;
  /** @type {string[]} */
  const paths = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = /** @type {string} */ (argv[i]);
    if (arg === '--help' || arg === '-h') {
      out(USAGE);
      return 0;
    } else if (arg === '--env-path') {
      const v = argv[i + 1];
      if (v === undefined) {
        err(`--env-path needs a value.\n\n${USAGE}`);
        return 2;
      }
      envFile = resolve(v);
      i += 1;
    } else if (arg === '--no-allowlist') {
      useAllowlist = false;
    } else if (arg.startsWith('--')) {
      err(`Unknown option ${arg}.\n\n${USAGE}`);
      return 2;
    } else {
      paths.push(resolve(arg));
    }
  }

  const loaded = loadEnvFile({ path: envFile });
  const literals = configuredLiterals(loaded.values);
  out(
    `Configured values checked literally: SUPABASE_SECRET_KEY ${loaded.values.SUPABASE_SECRET_KEY ? 'yes' : 'no (not set)'}, ` +
      `SUPABASE_DB_URL ${loaded.values.SUPABASE_DB_URL ? 'yes' : 'no (not set)'}.`,
  );

  /** @type {string[]} */
  const files = [];
  if (paths.length > 0) {
    for (const path of paths) {
      try {
        files.push(...listFiles(path));
      } catch {
        err(`Cannot read ${display(path)}.`);
        return 2;
      }
    }
  } else {
    for (const target of defaultTargets(env)) {
      let found;
      try {
        found = listFiles(target.path);
      } catch {
        found = null;
      }
      if (found === null) out(`skip  ${target.label}: ${display(target.path)} not found`);
      else {
        out(`scan  ${target.label}: ${display(target.path)} (${found.length} file(s))`);
        files.push(...found);
      }
    }
  }
  if (files.length === 0) {
    err('Nothing to scan.');
    return 2;
  }

  const report = scanFiles(files, { literals, allowlist: useAllowlist ? DEFAULT_ALLOWLIST : [] });
  for (const a of report.allowed) {
    out(`allow ${display(a.file)}: ${a.kind} x${a.count} at ${a.location} (${a.allowed})`);
  }
  for (const s of report.skipped) out(`skip  ${display(s)}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  for (const f of report.failures) {
    err(`FAIL  ${display(f.file)}: ${f.kind} x${f.count} (first at ${f.location})`);
  }
  const mb = (report.bytes / 1024 / 1024).toFixed(1);
  if (report.failures.length > 0) {
    err(`${report.failures.length} finding(s) in ${report.scanned} file(s) (${mb} MB). Matched text is not shown.`);
    return 1;
  }
  out(`No secrets found in ${report.scanned} file(s) (${mb} MB).`);
  return 0;
}

