/**
 * Tracked time in the workspace: the synced, automatically measured intervals (time_entries).
 * Kept apart, exactly as measured:
 *   - foreground time: how long the application was in front (active + idle);
 *   - active time: foreground minus idle (the tracker's idle detection);
 * Neither is billable time, and nothing here infers a project from an application.
 * Totals count each entry id once, so an entry can never be added twice.
 */

import type { Tables } from '@studio-pulse/database';

export type TimeEntry = Pick<
  Tables<'time_entries'>,
  | 'id'
  | 'workspace_id'
  | 'user_id'
  | 'application_id'
  | 'application_name'
  | 'kind'
  | 'started_at'
  | 'ended_at'
  | 'active_ms'
  | 'idle_ms'
  | 'project_id'
  | 'task_id'
>;

export const TIME_ENTRY_COLUMNS =
  'id, workspace_id, user_id, application_id, application_name, kind, started_at, ended_at, active_ms, idle_ms, project_id, task_id';

export interface TimeTotals {
  readonly activeMs: number;
  readonly idleMs: number;
  /** active + idle: the time the application was in the foreground. */
  readonly foregroundMs: number;
  readonly entries: number;
}

export const NO_TIME: TimeTotals = { activeMs: 0, idleMs: 0, foregroundMs: 0, entries: 0 };

/** Each id once (a defensive guard: a list assembled from two sources must not double-count). */
export function uniqueEntries<T extends { id: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of entries) {
    const key = entry.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function totals(entries: readonly Pick<TimeEntry, 'id' | 'active_ms' | 'idle_ms'>[]): TimeTotals {
  let activeMs = 0;
  let idleMs = 0;
  const unique = uniqueEntries(entries);
  for (const entry of unique) {
    activeMs += entry.active_ms;
    idleMs += entry.idle_ms;
  }
  return { activeMs, idleMs, foregroundMs: activeMs + idleMs, entries: unique.length };
}

/** Totals per key (project id, task id, application id…); `null` keys collect the unattributed. */
export function totalsBy<K extends string | null>(
  entries: readonly TimeEntry[],
  keyOf: (entry: TimeEntry) => K,
): Map<K, TimeTotals> {
  const groups = new Map<K, TimeEntry[]>();
  for (const entry of uniqueEntries(entries)) {
    const key = keyOf(entry);
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  return new Map([...groups.entries()].map(([key, list]) => [key, totals(list)]));
}

export interface TimeFilter {
  /** Inclusive start / exclusive end, epoch ms. */
  readonly startMs: number;
  readonly endMs: number;
  readonly applicationId: string | null;
  /** 'unattributed' = no project; a project id; or null for any. */
  readonly projectId: string | 'unattributed' | null;
}

export function filterEntries(entries: readonly TimeEntry[], filter: TimeFilter): TimeEntry[] {
  return entries.filter((entry) => {
    const started = Date.parse(entry.started_at);
    if (Number.isNaN(started) || started < filter.startMs || started >= filter.endMs) return false;
    if (filter.applicationId !== null && entry.application_id !== filter.applicationId) return false;
    if (filter.projectId === 'unattributed' ? entry.project_id !== null : filter.projectId !== null && entry.project_id !== filter.projectId) {
      return false;
    }
    return true;
  });
}

/** Distinct applications in `entries`, by name. */
export function applicationsIn(entries: readonly TimeEntry[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const entry of entries) if (!byId.has(entry.application_id)) byId.set(entry.application_id, entry.application_name);
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
