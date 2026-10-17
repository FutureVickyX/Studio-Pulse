# Supabase admin scripts (local only)

These scripts run on a developer's machine against the Supabase project configured in
`supabase/.env.local` (gitignored; copy `supabase/.env.example`). They are the **only** code in
the repository that may read `SUPABASE_SECRET_KEY` or `SUPABASE_DB_URL`. Nothing here is bundled
into the desktop app, and no script prints a key, password, token, connection string or
per-user activity detail.

| Command | Script | Needs |
| --- | --- | --- |
| `npm run supabase:migrate` | `migrate.mjs` | `SUPABASE_DB_URL` |
| `npm run supabase:migrate:dry-run` | `migrate.mjs --dry-run` | `SUPABASE_DB_URL` |
| `npm run supabase:migrate:status` | `migrate.mjs --status` | `SUPABASE_DB_URL` |
| `npm run supabase:verify` | `verify.mjs` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` |
| `npm run check:secrets` | `../check-bundle-secrets.mjs` | nothing (reads `.env.local` if present) |

Pass options after `--`, e.g. `npm run supabase:verify -- --keep-user`.

| Module | Role |
| --- | --- |
| `env.mjs` | Loads `supabase/.env.local` and reports missing keys by name |
| `keys.mjs` | Classifies an API key as publishable, secret or unknown |
| `migrations.mjs` | Lists, plans and applies migrations, and builds the TLS settings |
| `verify-lib.mjs` | Offline helpers for `verify.mjs` |
| `secret-scan.mjs` | The scanner behind `check-bundle-secrets.mjs` |

Every module has a `.d.mts` file next to it, so the strict TypeScript tests can import it.
Unit tests: `tests/unit/database/*.test.ts`.

## `supabase/.env.local` format

- One `KEY=VALUE` per line. Lines starting with `#` are comments, and so is ` # …` after an
  unquoted value.
- Values may be wrapped in `'…'` or `"…"`. Quotes are removed and escapes are not processed.
- A leading `export ` is accepted.
- An empty value counts as missing.

Malformed lines are reported by line number only, never by content.

## Migrations: `migrate.mjs`

```bash
npm run supabase:migrate:status    # applied / pending per file
npm run supabase:migrate:dry-run   # what would be applied; changes nothing
npm run supabase:migrate           # apply pending files
```

- **Order and history.** Files named `<digits>_<name>.sql` in `supabase/migrations/` run in
  byte-wise filename order. Other files are listed as ignored. Each applied file is recorded in
  `supabase_migrations.schema_migrations (version text primary key, name text,
  statements text[])`. The Supabase CLI uses the same table, with the same DDL, so
  `supabase db push` / `supabase migration list` can take over later.
- **Atomicity.** Each file runs in its own transaction together with its history row. A failing
  file is rolled back completely, nothing is recorded for it, and later files are not attempted.
  `BEGIN`/`COMMIT`, `CREATE INDEX CONCURRENTLY`, `VACUUM` and similar statements are refused up
  front, because they cannot run inside that transaction. So is `BEGIN ATOMIC`.
- **Concurrency.** A transaction-scoped advisory lock serialises runners. A second runner waits,
  then skips files the first one applied (`skipped … (applied concurrently)`).
- **Safety refusals** (nothing is changed):
  - The database records a version that has no local file. Your checkout is behind; update it.
  - A pending file is older than the newest applied version. Re-run with `--include-all` if
    that is intended, which is the same rule as the CLI.
  - `SUPABASE_DB_URL` is missing or malformed, or has `sslmode=disable` for a remote host.
- **Output.** File names, statement counts and summary counts only. Errors are reduced to
  SQLSTATE + message, and the URL, the password and anything shaped like a connection string
  are redacted.

Use the **Session pooler** connection string (port 5432) from Project Settings › Database ›
Connection string. Percent-encode special characters in the password (`#` → `%23`, `@` →
`%40`, …).

### TLS

Remote databases are always reached over TLS **with certificate and hostname verification**
(`rejectUnauthorized: true`). The trusted roots are Node's bundled Mozilla store plus the
operating-system store (the Windows certificate store on Windows). Any `sslmode` in the URL
cannot weaken this: the connection settings are built explicitly.

Supabase's database certificates chain to Supabase's own root CA, which is in neither store. If
the connection fails with a certificate error, the script says so and does not retry insecurely.
To fix it:

1. Download the CA certificate: Project Settings › Database › SSL Configuration › *Download
   certificate*.
2. Save it, e.g. as `supabase/prod-ca-2021.crt`. It is a public certificate, but keep it out of
   commits anyway.
3. Add `SUPABASE_DB_SSL_CA=supabase/prod-ca-2021.crt` to `supabase/.env.local`, or pass
   `--ssl-ca <file>`. The certificate is trusted *in addition to* the bundled and system roots.

`--ssl-no-verify` is an explicit, last-resort opt-in for a trusted network. It keeps the
connection encrypted but skips verification. Anyone who can intercept the network path could then
impersonate the database and capture the database password, so the script prints a warning each
time. It is never the default.

Local stacks (`supabase start`, host `localhost`/`127.0.0.1`/`::1`) use plain TCP unless the URL
asks for `sslmode=require` or stronger.

## Verification: `verify.mjs`

```bash
npm run supabase:verify
```

An end-to-end test of the real project.

- The secret key is used only to create three confirmed throwaway users
  (`sp-verify-<runid>-{a,b,c}@example.com`, random 192-bit passwords kept in memory), and to
  delete them and their workspaces afterwards.
- Every check acts only through the publishable key: anonymously, or as one of those users after
  `signInWithPassword`, exactly like a client.

What it proves (one `PASS`/`FAIL` line each):

- **auth**: sign-in works with the publishable key, a wrong password is refused, and the auth
  trigger creates a profile.
- **workspaces**: `create_workspace` makes the caller owner, private by default.
- **invitations**:
  - A invites B as a member, and only the token's hash is readable (`token_hash` is not granted).
  - C cannot accept B's invitation, B accepts, a used invitation cannot be reused, and a member
    cannot invite.
- **roles**: B cannot do any of the following, and the roster and settings are unchanged
  afterwards:
  - make itself owner, demote or remove the owner;
  - write `workspace_members` / `workspace_invitations`;
  - rename the workspace or change its visibility.

  C cannot add itself. The last owner cannot leave.
- **sync** (`sync_time_entries`):
  - A uploads 3 entries, and two retries return `synced` / `already present` with exactly 3 rows.
  - Nine kinds of invalid entry are each `rejected` with the expected SQLSTATE while a valid
    sibling syncs.
  - Stored values equal the uploaded ones exactly.
  - Batches over 500 entries are refused whole.
  - Another user's id is rejected and never overwritten.
  - References to another workspace's project or task are rejected (`23503`), and A cannot sync
    into a workspace it does not belong to.
  - Direct inserts cannot impersonate another user, and synced entries cannot be updated.
- **isolation**: C can neither read nor write anything in A's workspace (workspace, members,
  invitations, projects, tasks, notes, time entries, A's profile).
- **privacy**:
  - Entries are private by default, even from the owner.
  - Only the owner can switch visibility to `admins` and back.
  - Private notes stay private, workspace notes are shared, only the note's owner edits, and an
    edit bumps `version`.
- **anon**: the publishable key without a session can read no table and call no RPC.
- **removal**: after removal, B loses access to the workspace and cannot sync into it, but keeps
  read access to its own entries.

**Cleanup always runs**, in a `finally`, and also on Ctrl+C:

1. Workspaces are deleted first. This cascades to projects, tasks, notes, entries, memberships
   and invitations.
2. Then the users are deleted.

Cleanup also sweeps users with the run's email prefix and workspaces they created, in case a
response was lost after the server acted. If cleanup is incomplete, the script says what to
delete by hand (by email prefix) and exits non-zero.

**Exit codes**:

- `0`: every check passed and cleanup succeeded.
- `1`: a check failed or cleanup was incomplete.
- `2`: configuration error, such as a missing key, a secret key in the publishable slot (or the
  reverse), or a non-https URL.

The users have `example.com` addresses (reserved, no mail is ever delivered), and the admin API
creates them already confirmed, so the run works with *Confirm email* turned on.

### Dedicated live-test user: `--keep-user` / `--delete-live-user`

The Rust live test (`apps/desktop/src-tauri/tests/supabase_live.rs`) signs in as a real user.

```bash
npm run supabase:verify -- --keep-user
```

Only after **every** check passed, this:

1. deletes any previously recorded live-test user;
2. creates `sp-live-<runid>@example.com` (confirmed) and, through that user's own session, a
   workspace;
3. prints **only** the email and the workspace id;
4. writes `supabase/.live-test.local`. It refuses to write the file unless `git check-ignore`
   confirms the file is ignored.

`supabase/.live-test.local` holds the environment variables the Rust test reads:

```text
STUDIO_PULSE_SUPABASE_URL=…            (public)
STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY=… (public)
SP_LIVE_EMAIL=sp-live-<runid>@example.com
SP_LIVE_PASSWORD=…                      (the test user's password: local only)
SP_LIVE_USER_ID=…
SP_LIVE_WORKSPACE_ID=…
```

Run the live test with it (PowerShell):

```powershell
Get-Content supabase/.live-test.local | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object {
  $name, $value = $_ -split '=', 2; Set-Item "env:$name" $value }
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test supabase_live -- --ignored --nocapture
```

or bash: `set -a; . supabase/.live-test.local; set +a` and then the same `cargo test` command.

```bash
npm run supabase:verify -- --delete-live-user
```

This deletes that user, its workspaces and the file. It only ever deletes an address matching
`sp-live-<8 hex>@example.com` whose recorded id still belongs to that address.

## Secret scan: `check-bundle-secrets.mjs`

```bash
npm run check:secrets                       # default targets
npm run check:secrets -- <file|dir> ...     # scan these instead
```

**Default targets** (a missing one is reported and skipped; a missing explicit path is an error):

- `apps/desktop/dist`, the webview bundle;
- `studio-pulse.exe`, the release executable, and the NSIS installer(s) in `bundle/nsis/` under
  `$CARGO_TARGET_DIR/release`, default `%LOCALAPPDATA%/studio-pulse-build/target/release`;
- `apps/desktop/src-tauri/src`.

**What fails the scan.** Every file is searched in UTF-8/ASCII and in UTF-16LE (both alignments).

| Kind | Meaning | Allowlist |
| --- | --- | --- |
| `configured-secret-key` | the literal `SUPABASE_SECRET_KEY` value from `.env.local` | never |
| `configured-db-url` / `configured-db-password` | the literal `SUPABASE_DB_URL`, or its password (8+ chars) | never |
| `sb-secret-key` | `sb_secret_` followed by key material | never |
| `service-role-jwt` | a JWT whose payload `role` is `service_role` | never |
| `user-jwt` | a JWT whose payload `role` is `authenticated` (a user's access token) | never |
| `postgres-connection-string` | `postgres://` / `postgresql://` URLs | never |
| `sb-secret-prefix`, `service-role-mention` | the bare words `sb_secret_` / `service_role` | only the desktop's rejection rule: `cloud/config.rs`, `build.rs` and the compiled exe |
| `secret-key-env-name`, `db-url-env-name` | the names `SUPABASE_SECRET_KEY` / `SUPABASE_DB_URL` | never |

The desktop has to recognise a secret key in order to refuse one, so its rule necessarily
contains the two bare words. `--no-allowlist` fails on those too.

**Output and exit codes:**

- `0`: clean.
- `1`: findings. Each is printed as file + kind + count + line/offset, and the matched text is
  never printed.
- `2`: usage error or nothing to scan.

**Limits.** Compressed content cannot be searched. The NSIS payload and the frontend assets
Tauri embeds in the exe are compressed. That is why `dist/` and the exe itself are scanned
directly, and the installer scan covers only its uncompressed parts.

## What has been verified, and what still needs the real project

Verified offline (`npx vitest run tests/unit/database`):

- env parsing;
- key classification, which matches the TypeScript package;
- migration ordering and planning, plus statement splitting;
- `applyMigrations` against PGlite with Supabase-shaped `auth` / roles, covering fresh, partial,
  failing-file, concurrent and refusal cases;
- connection settings and redaction;
- the CLI refusals with a missing or bad env, and no secrets in output;
- every verification payload, run through the real `sync_time_entries` on PGlite;
- the secret scanner on synthetic files.

Not yet run, because it needs credentials in `supabase/.env.local`:

- `npm run supabase:migrate` / `:status` against the hosted project, including whether the
  pooler's certificate verifies with the system store or needs `SUPABASE_DB_SSL_CA`;
- `npm run supabase:verify` end to end;
- `--keep-user` together with the Rust live test.
