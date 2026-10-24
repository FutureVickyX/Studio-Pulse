/**
 * scripts/supabase/secret-scan.mjs (behind `npm run check:secrets`) on synthetic files in a temp
 * directory: every kind is detected in text and in binary (UTF-8 and UTF-16LE), the allowlist only
 * excuses reference kinds in the listed files, and the matched text is never printed.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ALLOWLIST,
  LEAK_KINDS,
  REFERENCE_KINDS,
  allowedBy,
  configuredLiterals,
  defaultTargets,
  main,
  scanBuffer,
  scanFiles,
} from '../../../scripts/supabase/secret-scan.mjs';
import { REPO_ROOT, fakeJwt, fakeSecretKey, legacyKey } from './helpers';

// Some tests spawn node processes: slow while the full suite runs in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET_KEY = fakeSecretKey();
const CONFIGURED_SECRET = fakeSecretKey('ConfiguredInEnvLocal_0123456789');
const DB_PASSWORD = 'Qz8-DbPassword-Unique-77';
const DB_URL = `postgresql://postgres.abcdefghijklmnopqrst:${DB_PASSWORD}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;
const SERVICE_JWT = legacyKey('service_role');
const ANON_JWT = legacyKey('anon');
const USER_JWT = fakeJwt({ sub: '11111111-1111-4111-8111-111111111111', role: 'authenticated', exp: 4_000_000_000 });

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-secrets-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function kinds(buf: Buffer, literals: { kind: string; value: string }[] = []) {
  return scanBuffer(buf, { literals }).map((f) => f.kind);
}

/** A fake PE-ish binary: NUL padding around a string encoded as `encoding`. */
function binaryWith(text: string, encoding: 'utf8' | 'utf16le', oddOffset = false): Buffer {
  return Buffer.concat([
    Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
    Buffer.alloc(oddOffset ? 101 : 100, 0),
    Buffer.from(text, encoding),
    Buffer.alloc(64, 0),
  ]);
}

describe('scanBuffer', () => {
  it('finds nothing in a clean bundle (publishable keys and anon JWTs are public)', () => {
    const clean = Buffer.from(
      `const url="https://abcdefghijklmnopqrst.supabase.co";const key="sb_publishable_AbCdEf_123";const legacy="${ANON_JWT}";`,
    );
    expect(kinds(clean)).toEqual([]);
  });

  it('detects each leak kind in text', () => {
    expect(kinds(Buffer.from(`key = "${SECRET_KEY}"`))).toEqual(['sb-secret-key']);
    expect(kinds(Buffer.from(`k='${SERVICE_JWT}'`))).toEqual(['service-role-jwt']);
    expect(kinds(Buffer.from(`token: ${USER_JWT}`))).toEqual(['user-jwt']);
    expect(kinds(Buffer.from(`db = "${DB_URL}"`))).toEqual(['postgres-connection-string']);
    expect(kinds(Buffer.from('postgres://localhost/db'))).toEqual(['postgres-connection-string']);
  });

  it('detects the reference kinds', () => {
    expect(kinds(Buffer.from('if key.starts_with("sb_secret_") {'))).toEqual(['sb-secret-prefix']);
    expect(kinds(Buffer.from('role == "service_role"'))).toEqual(['service-role-mention']);
    expect(kinds(Buffer.from('process.env.SUPABASE_SECRET_KEY'))).toEqual(['secret-key-env-name']);
    expect(kinds(Buffer.from('std::env::var("SUPABASE_DB_URL")'))).toEqual(['db-url-env-name']);
  });

  it('detects the configured values literally, and the DB password inside the URL', () => {
    const literals = configuredLiterals({ SUPABASE_SECRET_KEY: CONFIGURED_SECRET, SUPABASE_DB_URL: DB_URL });
    expect(literals.map((l) => l.kind)).toEqual(['configured-secret-key', 'configured-db-url', 'configured-db-password']);
    expect(kinds(Buffer.from(`x${CONFIGURED_SECRET}x`), literals)).toEqual(['configured-secret-key', 'sb-secret-key']);
    expect(kinds(Buffer.from(`pw=${DB_PASSWORD};`), literals)).toEqual(['configured-db-password']);
    expect(kinds(Buffer.from(DB_URL), literals)).toEqual(['configured-db-password', 'configured-db-url', 'postgres-connection-string']);
    // Percent-encoded passwords are checked in both forms.
    const encodedUrl = 'postgresql://u:p%40ss-w0rd-Long@h:5432/postgres';
    const encodedLiterals = configuredLiterals({ SUPABASE_DB_URL: encodedUrl });
    expect(encodedLiterals.filter((l) => l.kind === 'configured-db-password').map((l) => l.value)).toEqual([
      'p%40ss-w0rd-Long',
      'p@ss-w0rd-Long',
    ]);
    expect(kinds(Buffer.from('"p@ss-w0rd-Long"'), encodedLiterals)).toEqual(['configured-db-password']);
    // Values that are too short to search for reliably are ignored.
    expect(configuredLiterals({ SUPABASE_DB_URL: 'postgresql://u:short@h/db' }).map((l) => l.kind)).toEqual(['configured-db-url']);
  });

  it('finds secrets inside binaries, as UTF-8 and as UTF-16LE at either alignment', () => {
    const literals = [{ kind: 'configured-secret-key', value: CONFIGURED_SECRET }];
    for (const [encoding, odd] of [
      ['utf8', false],
      ['utf16le', false],
      ['utf16le', true],
    ] as const) {
      const found = scanBuffer(binaryWith(`${CONFIGURED_SECRET} ${SERVICE_JWT} service_role`, encoding, odd), { literals });
      expect(found.map((f) => f.kind), `${encoding} odd=${odd}`).toEqual([
        'configured-secret-key',
        'sb-secret-key',
        'service-role-jwt',
        'service-role-mention',
      ]);
      const literal = found.find((f) => f.kind === 'configured-secret-key')!;
      expect(literal.encoding).toBe(encoding);
      expect(literal.firstOffset).toBe(odd ? 105 : 104);
    }
  });

  it('counts repeated matches per kind and never returns the matched text', () => {
    const found = scanBuffer(Buffer.from(`${SECRET_KEY}\n${SECRET_KEY}\nservice_role SERVICE_ROLE`));
    expect(found).toEqual([
      { kind: 'sb-secret-key', count: 2, firstOffset: 0, encoding: 'utf8' },
      { kind: 'service-role-mention', count: 2, firstOffset: SECRET_KEY.length * 2 + 2, encoding: 'utf8' },
    ]);
    expect(JSON.stringify(found)).not.toContain(SECRET_KEY);
  });
});

describe('allowlist', () => {
  it('only excuses reference kinds, only in the listed files', () => {
    const configRs = join(REPO_ROOT, 'apps/desktop/src-tauri/src/cloud/config.rs');
    const otherRs = join(REPO_ROOT, 'apps/desktop/src-tauri/src/cloud/api.rs');
    const exe = join(tmpdir(), 'target', 'release', 'studio-pulse.exe');
    expect(allowedBy(configRs, 'sb-secret-prefix', DEFAULT_ALLOWLIST)).toBeDefined();
    expect(allowedBy(configRs, 'service-role-mention', DEFAULT_ALLOWLIST)).toBeDefined();
    expect(allowedBy(exe, 'service-role-mention', DEFAULT_ALLOWLIST)).toBeDefined();
    expect(allowedBy(otherRs, 'service-role-mention', DEFAULT_ALLOWLIST)).toBeUndefined();
    expect(allowedBy(configRs, 'secret-key-env-name', DEFAULT_ALLOWLIST)).toBeUndefined();
    for (const kind of LEAK_KINDS) {
      expect(allowedBy(configRs, kind, DEFAULT_ALLOWLIST), kind).toBeUndefined();
      expect(allowedBy(exe, kind, DEFAULT_ALLOWLIST), kind).toBeUndefined();
      // Even a hand-written allowlist entry cannot excuse a leak kind.
      expect(allowedBy(configRs, kind, [{ path: 'apps/desktop/src-tauri/src/cloud/config.rs', kinds: [kind], reason: 'x' }])).toBeUndefined();
    }
    expect([...REFERENCE_KINDS].sort()).toEqual(['db-url-env-name', 'sb-secret-prefix', 'secret-key-env-name', 'service-role-mention']);
  });
});

describe('scanFiles and the command line', () => {
  function fakeTree() {
    const dir = tempDir();
    mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
    mkdirSync(join(dir, 'dist', 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.html'), '<script src="/assets/index.js"></script>');
    writeFileSync(join(dir, 'dist', 'assets', 'index.js'), `const k="sb_publishable_x";\nconst s="${SECRET_KEY}";\n`);
    writeFileSync(join(dir, 'dist', 'assets', 'chunk.js'), `const t="${SERVICE_JWT}";`);
    writeFileSync(join(dir, 'dist', 'node_modules', 'ignored.js'), `const s="${SECRET_KEY}";`);
    writeFileSync(join(dir, 'app.exe'), binaryWith(`${DB_URL}\u0000${CONFIGURED_SECRET}`, 'utf16le'));
    writeFileSync(join(dir, 'clean.txt'), 'nothing to see\n');
    const envPath = join(dir, '.env.local');
    writeFileSync(envPath, `SUPABASE_SECRET_KEY=${CONFIGURED_SECRET}\nSUPABASE_DB_URL="${DB_URL}"\n`);
    return { dir, envPath };
  }

  it('reports file, kind, count and line/offset; skips node_modules', () => {
    const { dir } = fakeTree();
    const literals = configuredLiterals({ SUPABASE_SECRET_KEY: CONFIGURED_SECRET, SUPABASE_DB_URL: DB_URL });
    const report = scanFiles(
      [join(dir, 'dist', 'assets', 'index.js'), join(dir, 'dist', 'assets', 'chunk.js'), join(dir, 'app.exe'), join(dir, 'clean.txt')],
      { literals },
    );
    const summary = report.failures.map((f) => [f.file.slice(dir.length + 1).replaceAll('\\', '/'), f.kind, f.location]);
    expect(summary).toEqual([
      ['dist/assets/index.js', 'sb-secret-key', 'line 2'],
      ['dist/assets/chunk.js', 'service-role-jwt', 'line 1'],
      ['app.exe', 'configured-db-password', expect.stringMatching(/^offset 0x[0-9a-f]+ \(UTF-16\)$/)],
      ['app.exe', 'configured-db-url', expect.stringMatching(/\(UTF-16\)$/)],
      ['app.exe', 'configured-secret-key', expect.stringMatching(/\(UTF-16\)$/)],
      ['app.exe', 'postgres-connection-string', expect.stringMatching(/\(UTF-16\)$/)],
      ['app.exe', 'sb-secret-key', expect.stringMatching(/\(UTF-16\)$/)],
    ]);
    expect(report.scanned).toBe(4);
  });

  it('main(): exit 1 with file + kind on findings, never printing a secret', () => {
    const { dir, envPath } = fakeTree();
    const lines: string[] = [];
    const code = main([join(dir, 'dist'), join(dir, 'app.exe'), '--env-path', envPath], {
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    const output = lines.join('\n');
    expect(output).toMatch(/FAIL {2}.*dist\/assets\/index\.js: sb-secret-key x1 \(first at line 2\)/);
    expect(output).toMatch(/FAIL {2}.*chunk\.js: service-role-jwt/);
    expect(output).toMatch(/FAIL {2}.*app\.exe: configured-secret-key/);
    expect(output).toMatch(/Configured values checked literally: SUPABASE_SECRET_KEY yes, SUPABASE_DB_URL yes/);
    expect(output).not.toMatch(/ignored\.js/);
    for (const secret of [SECRET_KEY, CONFIGURED_SECRET, DB_PASSWORD, DB_URL, SERVICE_JWT, 'postgresql://']) {
      expect(output).not.toContain(secret);
    }
  });

  it('main(): exit 0 on clean input, 2 on usage errors and missing paths', () => {
    const { dir } = fakeTree();
    const quiet = { out: () => {}, err: () => {} };
    expect(main([join(dir, 'clean.txt'), '--env-path', join(dir, 'none.env')], quiet)).toBe(0);
    expect(main([join(dir, 'does-not-exist')], quiet)).toBe(2);
    expect(main(['--bogus'], quiet)).toBe(2);
    expect(main(['--env-path'], quiet)).toBe(2);
    const empty = tempDir();
    expect(main([empty, '--env-path', join(dir, 'none.env')], quiet)).toBe(2);
  });

  it('main(): the allowlist excuses the rejection rule in config.rs; --no-allowlist does not', () => {
    const dir = tempDir();
    const configRs = join(REPO_ROOT, 'apps/desktop/src-tauri/src/cloud/config.rs');
    const quiet = { out: () => {}, err: () => {} };
    expect(main([configRs, '--env-path', join(dir, 'none.env')], quiet)).toBe(0);
    // The real file contains the rule's literals (or its documentation of them) once implemented.
    const text = readFileSync(configRs, 'utf8');
    if (text.includes('sb_secret_') || text.includes('service_role')) {
      expect(main([configRs, '--env-path', join(dir, 'none.env'), '--no-allowlist'], quiet)).toBe(1);
    }
    // The same literals anywhere else fail.
    writeFileSync(join(dir, 'other.rs'), 'if key.starts_with("sb_secret_") || role == "service_role" {}');
    expect(main([join(dir, 'other.rs'), '--env-path', join(dir, 'none.env')], quiet)).toBe(1);
  });

  it('defaults to dist, the release exe, the NSIS installers and the Rust sources', () => {
    const targetDir = tempDir();
    mkdirSync(join(targetDir, 'release', 'bundle', 'nsis'), { recursive: true });
    writeFileSync(join(targetDir, 'release', 'bundle', 'nsis', 'Studio Pulse_0.1.0_x64-setup.exe'), '');
    const targets = defaultTargets({ CARGO_TARGET_DIR: targetDir });
    expect(targets.map((t) => t.label)).toEqual(['webview bundle', 'release executable', 'NSIS installer', 'desktop Rust sources']);
    expect(targets[1]!.path).toBe(join(targetDir, 'release', 'studio-pulse.exe'));
    expect(targets[2]!.path).toBe(join(targetDir, 'release', 'bundle', 'nsis', 'Studio Pulse_0.1.0_x64-setup.exe'));
    expect(targets.map((t) => t.required)).toEqual([true, true, false, true]);
    // Without CARGO_TARGET_DIR: Cargo's own default next to the crate, whatever LOCALAPPDATA says.
    const fallback = defaultTargets({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
    expect(fallback[1]!.path).toBe(join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'studio-pulse.exe'));
  });

  it('fails the default scan when the release executable is missing, instead of passing without it', () => {
    const targetDir = tempDir(); // no release build in it
    const lines: string[] = [];
    const code = main(['--env-path', join(targetDir, 'none.env')], {
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      env: { CARGO_TARGET_DIR: targetDir },
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/Missing (webview bundle|release executable)/);
    expect(lines.join('\n')).not.toMatch(/No secrets found/);
  });

  it('the npm entry point exits 1 on a synthetic leak and prints no secret', () => {
    const { dir } = fakeTree();
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts/check-bundle-secrets.mjs'), join(dir, 'dist'), '--env-path', join(dir, 'none.env')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/sb-secret-key/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET_KEY);
  });
});
