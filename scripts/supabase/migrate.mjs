#!/usr/bin/env node
// Apply supabase/migrations/*.sql to the database in SUPABASE_DB_URL (supabase/.env.local).
//
//   npm run supabase:migrate                  apply pending migrations
//   npm run supabase:migrate -- --dry-run     list pending migrations, change nothing
//   npm run supabase:migrate:status           applied / pending per file, change nothing
//
// Options: --env-path <path>  --migrations-dir <path>  --ssl-ca <pem file>  --ssl-no-verify
//          --include-all (apply pending migrations older than the newest applied one)
//
// Each file runs in its own transaction together with its row in
// supabase_migrations.schema_migrations (the Supabase CLI's history table), so a failing file
// leaves no trace and later files are not attempted. Output: filenames and counts only. The
// connection string and password are never printed. See scripts/supabase/README.md.

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';

import pg from 'pg';

import { DEFAULT_ENV_FILE, REPO_ROOT, describeMissing, loadEnvFile } from './env.mjs';
import {
  applyMigrations,
  connectionConfig,
  describeError,
  isTlsVerifyError,
  listMigrations,
  planMigrations,
  readAppliedVersions,
  readMigration,
} from './migrations.mjs';

const USAGE = `Usage: node scripts/supabase/migrate.mjs [--dry-run | --status] [options]

  --dry-run              list pending migrations without applying them
  --status               show applied / pending migrations
  --env-path <path>      env file (default: supabase/.env.local)
  --migrations-dir <dir> migrations (default: supabase/migrations)
  --ssl-ca <file>        PEM CA certificate to trust in addition to the system store
                         (or SUPABASE_DB_SSL_CA=<file> in the env file)
  --ssl-no-verify        encrypt but do NOT verify the server certificate (see scripts/supabase/README.md)
  --include-all          also apply pending migrations older than the newest applied one`;

class UsageError extends Error {}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {
    mode: /** @type {'apply' | 'dry-run' | 'status'} */ ('apply'),
    envFile: DEFAULT_ENV_FILE,
    migrationsDir: resolve(REPO_ROOT, 'supabase', 'migrations'),
    sslCa: /** @type {string | null} */ (null),
    sslNoVerify: false,
    includeAll: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${arg} needs a value.`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--dry-run':
      case '--status': {
        const mode = arg === '--dry-run' ? 'dry-run' : 'status';
        if (options.mode !== 'apply' && options.mode !== mode) throw new UsageError('Use either --dry-run or --status.');
        options.mode = mode;
        break;
      }
      case '--env-path':
        options.envFile = resolve(value());
        break;
      case '--migrations-dir':
        options.migrationsDir = resolve(value());
        break;
      case '--ssl-ca':
        options.sslCa = resolve(value());
        break;
      case '--ssl-no-verify':
        options.sslNoVerify = true;
        break;
      case '--include-all':
        options.includeAll = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new UsageError(`Unknown option ${arg}.`);
    }
  }
  if (options.sslCa && options.sslNoVerify) throw new UsageError('Use either --ssl-ca or --ssl-no-verify.');
  return options;
}

/** @param {string} path */
function resolveFromRepo(path) {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

async function main() {
  /** @type {ReturnType<typeof parseArgs>} */
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  // 1. Local migrations (validated before anything touches the network).
  /** @type {ReturnType<typeof listMigrations>} */
  let local;
  try {
    local = listMigrations(options.migrationsDir);
    for (const migration of local.migrations) readMigration(migration);
  } catch (error) {
    console.error(`Migrations are not valid: ${describeError(error, [])}`);
    return 1;
  }
  const shownIgnored = local.ignored.filter((f) => !f.startsWith('.'));
  if (shownIgnored.length > 0) console.log(`Ignoring files that are not <version>_<name>.sql: ${shownIgnored.join(', ')}`);
  console.log(`${local.migrations.length} local migration file(s).`);

  // 2. Configuration. Only key names are ever printed.
  const env = loadEnvFile({ path: options.envFile, required: ['SUPABASE_DB_URL'] });
  if (env.invalidLines.length > 0) {
    console.log(`Note: ignored malformed line(s) ${env.invalidLines.join(', ')} in the env file.`);
  }
  if (env.missing.length > 0) {
    console.error(
      `${describeMissing(env)}\nRefusing to run: the database URL is required ` +
        '(Project Settings → Database → Connection string → Session pooler).',
    );
    return 2;
  }
  const caSetting = env.values.SUPABASE_DB_SSL_CA;
  const caPath = options.sslCa ?? (caSetting ? resolveFromRepo(caSetting) : null);
  /** @type {string | undefined} */
  let ca;
  if (caPath) {
    try {
      ca = readFileSync(caPath, 'utf8');
    } catch {
      console.error(`Cannot read the CA certificate file ${caPath}.`);
      return 2;
    }
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
      console.error(`${caPath} is not a PEM certificate (expected -----BEGIN CERTIFICATE-----).`);
      return 2;
    }
  }
  /** @type {ReturnType<typeof connectionConfig>} */
  let connection;
  try {
    connection = connectionConfig(env.values.SUPABASE_DB_URL ?? '', { ca, noVerify: options.sslNoVerify });
  } catch (error) {
    console.error(describeError(error, []));
    return 2;
  }
  const { secrets } = connection;
  if (options.sslNoVerify) {
    console.warn(
      'WARNING: --ssl-no-verify: the connection is encrypted but the server certificate is NOT verified. ' +
        'Anyone able to intercept this network path could impersonate the database and capture the password. ' +
        'Prefer --ssl-ca with the CA certificate from Project Settings → Database → SSL Configuration.',
    );
  }

  // 3. Connect.
  const client = new pg.Client(connection.config);
  client.on('error', () => {}); // surfaced through the failing query instead
  try {
    await client.connect();
  } catch (error) {
    if (isTlsVerifyError(error)) {
      const code = /** @type {{ code: string }} */ (error).code;
      console.error(
        `Could not verify the database server's TLS certificate (${code}).\n` +
          "Supabase database certificates are issued by Supabase's own root CA, which is in neither Node's nor the system's trust store.\n" +
          '  Fix: download the CA certificate (Project Settings → Database → SSL Configuration → Download certificate),\n' +
          '       save it e.g. as supabase/prod-ca-2021.crt and set SUPABASE_DB_SSL_CA=supabase/prod-ca-2021.crt in supabase/.env.local\n' +
          '       (or pass --ssl-ca <file>).\n' +
          '  Last resort on a trusted network: --ssl-no-verify (encrypted, not verified).',
      );
    } else {
      console.error(`Could not connect to the database: ${describeError(error, secrets)}`);
    }
    await client.end().catch(() => {});
    return 1;
  }

  try {
    return await run(client, options, local.migrations, secrets);
  } catch (error) {
    console.error(`Migration run failed: ${describeError(error, secrets)}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * @param {pg.Client} client
 * @param {ReturnType<typeof parseArgs>} options
 * @param {import('./migrations.mjs').Migration[]} migrations
 * @param {readonly string[]} secrets
 */
async function run(client, options, migrations, secrets) {
  if (options.mode !== 'apply') {
    const plan = planMigrations(migrations, await readAppliedVersions(client));
    if (options.mode === 'status') {
      const pendingSet = new Set(plan.pending.map((m) => m.version));
      for (const m of migrations) console.log(`${pendingSet.has(m.version) ? 'pending ' : 'applied '} ${m.file}`);
      for (const v of plan.unknownApplied) console.log(`applied  ${v} (no local file)`);
      console.log(`${plan.applied.length} applied, ${plan.pending.length} pending.`);
    } else {
      for (const m of plan.pending) console.log(`would apply  ${m.file}`);
      console.log(`${plan.pending.length} pending migration(s); ${plan.applied.length} already applied. Nothing was changed (dry run).`);
    }
    if (plan.unknownApplied.length > 0) {
      console.log(`Warning: ${plan.unknownApplied.length} applied version(s) have no local file; applying would be refused.`);
    }
    if (plan.outOfOrder.length > 0) {
      console.log(`Warning: ${plan.outOfOrder.length} pending migration(s) are older than the newest applied one (needs --include-all).`);
    }
    return 0;
  }

  const result = await applyMigrations(client, migrations, {
    includeAll: options.includeAll,
    onApplied: (m, count) => console.log(`applied  ${m.file} (${count} statements)`),
    onSkipped: (m) => console.log(`skipped  ${m.file} (applied concurrently)`),
  });
  if (result.status === 'refused') {
    if (result.reason === 'unknownApplied') {
      console.error(
        `Refusing to apply: the database records ${result.versions.length} migration(s) with no local file ` +
          `(${result.versions.join(', ')}). Update your checkout first.`,
      );
    } else {
      console.error(
        `Refusing to apply: version(s) ${result.versions.join(', ')} are older than the newest applied migration. ` +
          'Re-run with --include-all if that is intended.',
      );
    }
    return 1;
  }
  if (result.status === 'failed') {
    console.error(`FAILED   ${result.failed.file}: ${describeError(result.error, secrets)}`);
    console.error(
      `${result.applied.length} applied in this run; ${result.failed.file} was rolled back; later files were not attempted.`,
    );
    return 1;
  }
  if (result.applied.length === 0 && result.skipped.length === 0) {
    console.log(`Database is up to date (${migrations.length} applied).`);
  } else {
    console.log(`${result.applied.length} migration(s) applied.`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`Unexpected error: ${describeError(error, [])}`);
    process.exitCode = 1;
  },
);
