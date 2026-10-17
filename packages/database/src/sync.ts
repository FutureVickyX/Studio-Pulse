/**
 * The `sync_time_entries` RPC contract (supabase/migrations/20261017090200_time_entries.sql).
 *
 * One payload element is one closed interval recorded by the desktop tracker, serialized with the
 * camelCase keys the SQL function reads (the Rust `cloud::api::RemoteTimeEntry` produces exactly
 * this shape). Nothing here is derived or invented: values are copied from the local record.
 */

import type { Database, TimeEntryEndReason } from './types';

/** At most this many entries per `sync_time_entries` call (the function raises 54000 above it). */
export const SYNC_TIME_ENTRIES_MAX_BATCH = 500;

// A type alias (not an interface) so an array of payloads is assignable to the RPC's `Json`
// argument without a cast.
export type SyncTimeEntryPayload = {
  /** The desktop's stable UUIDv7: the idempotency key. */
  id: string;
  deviceId: string;
  /** `^[a-z0-9][a-z0-9-]{1,63}$` */
  applicationId: string;
  /** 1–80 characters after trimming. */
  applicationName: string;
  kind: 'active' | 'idle';
  /** ISO-8601 UTC instant. */
  startedAt: string;
  endedAt: string;
  /** Measured split: `activeMs + idleMs = endedAt - startedAt`; idle intervals have `activeMs = 0` and vice versa. */
  activeMs: number;
  idleMs: number;
  endReason: TimeEntryEndReason;
  /** Optional attribution (a user action); must belong to the same workspace. */
  projectId?: string | null;
  taskId?: string | null;
  /** Local revision (default 1). */
  revision?: number;
  /** When the desktop first recorded the interval (default: the server's `now()`). */
  recordedAt?: string;
};

/**
 * One result per payload element:
 * - `synced`   inserted now, or already present and owned by the caller (`detail = 'already present'`)
 * - `rejected` the entry is invalid or its id belongs to someone else; retrying cannot succeed
 */
export type SyncTimeEntryResult = Database['public']['Functions']['sync_time_entries']['Returns'][number];
