/**
 * @studio-pulse/database — the typed Supabase layer shared by TypeScript callers.
 *
 * - `Database` and helpers: hand-written types for `supabase/migrations/*.sql`
 * - `readSupabaseConfig` / `validateSupabaseConfig`: publishable-key-only configuration
 * - `createStudioPulseClient`: the single supabase-js client factory
 * - `SyncTimeEntryPayload`: the `sync_time_entries` RPC contract
 *
 * The desktop app does not use this package: its sync runs in the Rust core
 * (apps/desktop/src-tauri/src/cloud) and tokens never reach the webview.
 */

export type {
  Database,
  Enums,
  FunctionArgs,
  FunctionReturns,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
  TimeEntryEndReason,
} from './types';

export {
  Constants,
  FUNCTIONS,
  SYNC_ENTRY_STATUSES,
  TABLE_COLUMNS,
  TABLE_RELATIONSHIPS,
  TIME_ENTRY_END_REASONS,
  TIME_ENTRY_KINDS,
  TIME_ENTRY_SOURCES,
} from './schema';
export type {
  ColumnSpec,
  ColumnType,
  FunctionName,
  FunctionSpec,
  RelationshipSpec,
  ReturnSpec,
  SchemaAssertions,
  TableName,
} from './schema';

export {
  SUPABASE_PUBLISHABLE_KEY_ENV,
  SUPABASE_URL_ENV,
  SupabaseConfigError,
  classifySupabaseKey,
  readSupabaseConfig,
  validateSupabaseConfig,
} from './config';
export type { SupabaseConfig, SupabaseConfigErrorCode, SupabaseKeyKind } from './config';

export { createStudioPulseClient } from './client';
export type { StudioPulseClient, StudioPulseClientOptions } from './client';

export { SYNC_TIME_ENTRIES_MAX_BATCH } from './sync';
export type { SyncTimeEntryPayload, SyncTimeEntryResult } from './sync';
