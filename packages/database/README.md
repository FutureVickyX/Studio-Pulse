# @studio-pulse/database

The typed Supabase layer for TypeScript callers: local scripts, tests, and the future web app.
It is the **single** place a TypeScript Supabase client is created.

The desktop app does not use this package. Its sign-in and sync run in the Rust core
(`apps/desktop/src-tauri/src/cloud`), and tokens never reach the webview.

```ts
import { createStudioPulseClient, readSupabaseConfig } from '@studio-pulse/database';

const supabase = createStudioPulseClient(readSupabaseConfig(process.env));
await supabase.auth.signInWithPassword({ email, password });
const { data } = await supabase.rpc('my_workspaces'); // typed rows
```

## What it exports

| Export | |
| --- | --- |
| `Database`, `Tables<T>`, `TablesInsert<T>`, `TablesUpdate<T>`, `Enums<T>`, `FunctionArgs<F>`, `FunctionReturns<F>`, `Json` | Hand-written types for `supabase/migrations/*.sql`, in the `supabase gen types typescript` layout |
| `Constants`, `TIME_ENTRY_KINDS`, `TIME_ENTRY_END_REASONS`, `TIME_ENTRY_SOURCES`, `SYNC_ENTRY_STATUSES` | Enum and CHECK-constrained values at runtime |
| `TABLE_COLUMNS`, `TABLE_RELATIONSHIPS`, `FUNCTIONS` | Runtime description of the schema, used by the drift test |
| `readSupabaseConfig(env)`, `validateSupabaseConfig(url, key)`, `classifySupabaseKey(key)`, `SupabaseConfigError` | Configuration validation |
| `createStudioPulseClient(config, options?)` | `createClient<Database>` with the publishable key |
| `SyncTimeEntryPayload`, `SyncTimeEntryResult`, `SYNC_TIME_ENTRIES_MAX_BATCH` | The `sync_time_entries` RPC contract, the shape the Rust `RemoteTimeEntry` serializes |

## Types: `Database`

The types follow the generator's layout, so a later `supabase gen types` output can replace the
file without changing callers. The hand-written version adds three refinements:

- `CHECK (col IN (...))` text columns are literal unions (`time_entries.kind`, `end_reason`,
  `source`).
- `RETURNS TABLE` columns carry their real nullability and fixed values (`sync_time_entries` →
  `status: 'synced' | 'rejected'`).
- Trigger-only functions are omitted, because they cannot be called through the API.

`Insert` / `Update` describe the table shape. What a signed-in user may actually write is decided
by the column-level GRANTs and RLS policies in the migrations.

### Drift protection

1. **At compile time**, `src/schema.ts` asserts that its runtime description and `Database` agree
   on tables, columns, nullability, defaults, enums, relationships and function signatures. A
   mismatch fails `tsc`.
2. **At test time**, `tests/unit/database/schema.test.ts` applies the real migrations to Postgres
   (PGlite) and compares the catalog with that description. Any change to `supabase/migrations`
   that is not mirrored here fails the test.
3. `typetests/client.typetest.ts` checks the shapes supabase-js produces from `Database`, for
   example `rpc('sync_time_entries')` rows, and that unknown tables, functions and arguments do
   not compile.

## Configuration: publishable key only

`readSupabaseConfig(env)` reads `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` and throws
`SupabaseConfigError` (`code`: `missing` | `invalidUrl` | `invalidKey` | `secretKey`).

- **URL**: `https://…`, or plain `http://` only for `localhost` / `127.0.0.1` / `[::1]`. No
  credentials, path, query or fragment. A trailing `/` is removed.
- **Key**: the same rule as the desktop (`cloud/config.rs`) and the scripts
  (`scripts/supabase/keys.mjs`):
  - `sb_secret_…` → **refused** (`secretKey`).
  - A JWT whose payload `role` is `service_role` → **refused** (`secretKey`).
  - `sb_publishable_…`, or a JWT whose `role` is `anon` → accepted.
  - Anything else → `invalidKey`.

  JWTs are decoded, not verified. This guards against shipping the wrong key; it is not
  authentication.

Error messages never contain the key or the URL.

`createStudioPulseClient` validates the config **again**, so a hand-built object carrying a
secret key cannot reach a client either.

Sessions are in memory by default (`persistSession: false`, `autoRefreshToken: false`,
`detectSessionInUrl: false`), which is right for scripts and tests. A browser app opts in:
`createStudioPulseClient(config, { persistSession: true, detectSessionInUrl: true })`.

The admin scripts in `scripts/supabase/` that legitimately need the secret key build their own
client and never import this package.

## Checks

```bash
npx tsc -p packages/database/tsconfig.json      # or: npm run typecheck -w @studio-pulse/database
npx vitest run tests/unit/database
```
