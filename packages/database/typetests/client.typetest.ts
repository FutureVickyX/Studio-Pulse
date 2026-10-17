/**
 * Compile-time checks that supabase-js, typed with `Database`, gives callers the shapes the
 * migrations produce. Never executed: `tsc -p packages/database/tsconfig.json` fails if an
 * assertion does not hold.
 */

import type { Database, StudioPulseClient, SyncTimeEntryPayload, Tables } from '../src/index';

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

declare const client: StudioPulseClient;
declare const workspaceId: string;
declare const entries: SyncTimeEntryPayload[];

async function shapes() {
  const synced = await client.rpc('sync_time_entries', { p_workspace_id: workspaceId, p_entries: entries });
  type SyncRow = NonNullable<typeof synced.data>[number];
  type _Sync = Assert<Equals<SyncRow, { entry_id: string | null; status: 'synced' | 'rejected'; detail: string | null }>>;

  const mine = await client.rpc('my_workspaces');
  type MineRow = NonNullable<typeof mine.data>[number];
  type _Mine = Assert<Equals<MineRow['role'], 'owner' | 'admin' | 'member'>>;

  const created = await client.rpc('create_workspace', { p_name: 'Studio' });
  type _Created = Assert<Equals<NonNullable<typeof created.data>['time_entry_visibility'], 'private' | 'admins'>>;

  const invited = await client.rpc('create_invitation', { p_workspace_id: workspaceId, p_email: 'a@example.com' });
  type _Invite = Assert<Equals<NonNullable<typeof invited.data>[number]['token'], string>>;

  const accepted = await client.rpc('accept_invitation', { p_token: 'x' });
  type _Accepted = Assert<Equals<typeof accepted.data, string | null>>;

  const rows = await client.from('time_entries').select('id, kind, active_ms, end_reason').eq('workspace_id', workspaceId);
  type EntryRow = NonNullable<typeof rows.data>[number];
  type _Kind = Assert<Equals<EntryRow['kind'], 'active' | 'idle'>>;
  type _Active = Assert<Equals<EntryRow['active_ms'], number>>;
  type _Reason = Assert<Equals<EntryRow['end_reason'], Tables<'time_entries'>['end_reason']>>;

  const notes = await client.from('notes').select('*').eq('visibility', 'workspace');
  type _Note = Assert<Equals<NonNullable<typeof notes.data>[number], Tables<'notes'>>>;

  // Unknown tables, columns, functions and argument names do not compile.
  // @ts-expect-error not a table
  client.from('tracking_events');
  // @ts-expect-error not a function
  void client.rpc('delete_everything');
  // @ts-expect-error wrong argument name
  void client.rpc('create_workspace', { name: 'x' });
  // @ts-expect-error not an enum value
  void client.rpc('set_time_entry_visibility', { p_workspace_id: workspaceId, p_visibility: 'everyone' });

  return [] as unknown as [_Sync, _Mine, _Created, _Invite, _Accepted, _Kind, _Active, _Reason, _Note];
}

/** The payload type matches what the SQL function reads (camelCase keys, no server-owned fields). */
type PayloadKeys = keyof SyncTimeEntryPayload;
type _NoServerFields = Assert<Equals<Extract<PayloadKeys, 'userId' | 'workspaceId' | 'source' | 'user_id'>, never>>;
type _Args = Assert<Equals<Database['public']['Functions']['sync_time_entries']['Args']['p_workspace_id'], string>>;

export type TypeTests = [typeof shapes, _NoServerFields, _Args];
