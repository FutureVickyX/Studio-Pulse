/**
 * Teammates' changes arrive through Supabase Realtime (postgres_changes). INSERT and UPDATE
 * events are checked against each subscriber's RLS and filtered to this workspace, so a private
 * note's contents only ever reach its owner. DELETE events can be neither: Supabase sends every
 * subscriber the primary key (only the key) of every deleted row, so a delete refetches only when
 * it names a row this workspace's cache holds. Each change marks the matching cached queries
 * stale; the ones on screen refetch. When the tab comes back to the foreground, or the
 * connection returns, everything for the workspace is refetched, so a missed event costs at most
 * one refresh.
 */

import type { StudioPulseClient } from '@studio-pulse/database';

import { holdsRow } from './store';

export type WatchedTable = 'projects' | 'tasks' | 'task_subtasks' | 'task_comments' | 'notes';

const TABLES: readonly WatchedTable[] = ['projects', 'tasks', 'task_subtasks', 'task_comments', 'notes'];

export function watchWorkspace(
  client: StudioPulseClient,
  workspaceId: string,
  onChange: (table: WatchedTable | 'all') => void,
): () => void {
  let channel = client.channel(`workspace:${workspaceId}`);
  for (const table of TABLES) {
    // INSERT/UPDATE can be filtered by workspace; DELETE events carry only the primary key, from
    // any workspace, so they count only for rows we hold.
    channel = channel
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter: `workspace_id=eq.${workspaceId}` }, () =>
        onChange(table),
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter: `workspace_id=eq.${workspaceId}` }, () =>
        onChange(table),
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table }, (payload) => {
        const id = (payload.old as { id?: unknown } | undefined)?.id;
        if (typeof id === 'string' && holdsRow(`ws:${workspaceId}:`, id)) onChange(table);
      });
  }
  let wasSubscribed = false;
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      // A reconnect may have missed events: refresh once.
      if (wasSubscribed) onChange('all');
      wasSubscribed = true;
    }
  });

  const onVisible = () => {
    if (document.visibilityState === 'visible') onChange('all');
  };
  const onOnline = () => onChange('all');
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    void client.removeChannel(channel);
  };
}
