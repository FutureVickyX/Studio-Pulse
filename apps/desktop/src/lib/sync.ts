/**
 * Human presentation of the sync state. Pure (no DOM, no `@tauri-apps/api`), unit-tested in
 * tests/unit/desktop. Every phase has its own text label: the dot next to it is decoration, so
 * the state is never conveyed by colour alone.
 */

import type { AccountState, AccountStatus, SyncOverview, SyncPhase } from '@studio-pulse/shared-types';

/** Mirrors `StatusTone` in @studio-pulse/ui (kept local so this module stays DOM-free). */
export type SyncToneName = 'tracking' | 'idle' | 'paused' | 'off' | 'away' | 'danger' | 'accent';

export interface SyncPhasePresentation {
  phase: SyncPhase;
  tone: SyncToneName;
  label: string;
  explanation: string;
}

export interface CountFormat {
  /** Formats a count for display (locale grouping). Defaults to `String`. */
  formatCount?: (value: number) => string;
}

function intervals(value: number, formatCount: (value: number) => string): string {
  return `${formatCount(value)} ${value === 1 ? 'interval' : 'intervals'}`;
}

export function describeSyncPhase(overview: SyncOverview, options: CountFormat = {}): SyncPhasePresentation {
  const formatCount = options.formatCount ?? String;
  const workspace = overview.workspaceName ? `“${overview.workspaceName}”` : 'the sync workspace';
  const pending = overview.pendingCount;
  switch (overview.phase) {
    case 'disabled':
      return {
        phase: overview.phase,
        tone: 'off',
        label: 'Off',
        explanation: 'Sync is off. Everything stays on this device.',
      };
    case 'idle':
      return pending > 0
        ? {
            phase: overview.phase,
            tone: 'accent',
            label: 'Queued',
            explanation: `${intervals(pending, formatCount)} will upload to ${workspace} shortly.`,
          }
        : {
            phase: overview.phase,
            tone: 'tracking',
            label: 'Up to date',
            explanation: `Nothing is waiting to upload to ${workspace}.`,
          };
    case 'syncing':
      return {
        phase: overview.phase,
        tone: 'accent',
        label: 'Syncing',
        explanation: `Uploading closed intervals to ${workspace}.`,
      };
    case 'waitingForNetwork':
      return {
        phase: overview.phase,
        tone: 'idle',
        label: 'Offline',
        explanation:
          'The sync server can’t be reached. Studio Pulse keeps everything on this device and retries automatically.',
      };
    case 'backoff':
      return {
        phase: overview.phase,
        tone: 'idle',
        label: 'Retrying',
        explanation:
          'The sync server reported a problem. Studio Pulse retries automatically, waiting longer each time. Nothing is lost.',
      };
    case 'needsSignIn':
      return {
        phase: overview.phase,
        tone: 'paused',
        label: 'Sign-in needed',
        explanation: 'Intervals are waiting to upload, but there is no valid session. Sign in to resume.',
      };
    case 'needsWorkspace':
      return {
        phase: overview.phase,
        tone: 'paused',
        label: 'No workspace chosen',
        explanation: 'You’re signed in, but no sync workspace is selected, so nothing is uploaded.',
      };
    case 'error':
      return {
        phase: overview.phase,
        tone: 'danger',
        label: 'Needs attention',
        explanation: 'Sync stopped because of a problem it can’t solve on its own. Nothing is lost; it stays on this device.',
      };
  }
}

/** Phases in which a manual "Sync now" can do something. */
export function canSyncNow(phase: SyncPhase): boolean {
  return phase === 'idle' || phase === 'syncing' || phase === 'waitingForNetwork' || phase === 'backoff' || phase === 'error';
}

// ---------------------------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Short relative time: `just now`, `5 min ago`, `in 3 min`, `2 h ago`, `in 1 d`. */
export function relativeTime(targetMs: number, nowMs: number): string {
  const delta = targetMs - nowMs;
  const future = delta > 0;
  const distance = Math.abs(delta);
  if (distance < 45_000) return future ? 'in a few seconds' : 'just now';
  let amount: string;
  const minutes = Math.round(distance / MINUTE_MS);
  if (minutes < 60) amount = `${Math.max(1, minutes)} min`;
  else {
    const hours = Math.round(distance / HOUR_MS);
    amount = hours < 24 ? `${hours} h` : `${Math.round(distance / DAY_MS)} d`;
  }
  return future ? `in ${amount}` : `${amount} ago`;
}

/**
 * Relative text for a scheduled attempt. A time that has already passed (the attempt is overdue
 * or about to run) reads `due now`, never `… ago`, which would suggest it already happened.
 */
export function relativeSchedule(targetMs: number, nowMs: number): string {
  return targetMs <= nowMs ? 'due now' : relativeTime(targetMs, nowMs);
}

// ---------------------------------------------------------------------------------------------
// Consent for history recorded while signed out (`claim_local_history` is never automatic)
// ---------------------------------------------------------------------------------------------

/**
 * - `none`            nothing to ask (no unowned intervals, not signed in, or dismissed)
 * - `chooseWorkspace` unowned intervals exist but there is no sync workspace to upload them to yet
 * - `ask`             ask for explicit consent to upload them to `workspaceName`
 */
export type ClaimPrompt =
  | { kind: 'none' }
  | { kind: 'chooseWorkspace'; count: number }
  | { kind: 'ask'; count: number; workspaceName: string | null };

/**
 * Identifies one "Keep local only" answer. Keyed by account and count, so history recorded during
 * a later signed-out stretch (a different count) or another account asks again.
 */
export function claimDismissKey(userId: string | null, unclaimedCount: number): string {
  return `${userId ?? ''}:${unclaimedCount}`;
}

export function claimPrompt(
  account: AccountStatus,
  overview: SyncOverview,
  dismissed: ReadonlySet<string> = new Set(),
): ClaimPrompt {
  const count = overview.unclaimedCount;
  if (account.state !== 'signedIn' || !Number.isFinite(count) || count <= 0) return { kind: 'none' };
  if (dismissed.has(claimDismissKey(account.userId, count))) return { kind: 'none' };
  const workspaceId = account.syncWorkspaceId;
  if (!workspaceId) return { kind: 'chooseWorkspace', count };
  const workspaceName =
    account.workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
    (overview.workspaceId === workspaceId ? overview.workspaceName : null);
  return { kind: 'ask', count, workspaceName };
}

/** The consent question, e.g. `3 intervals were recorded … Upload them to “Motion Team”?` */
export function claimQuestion(count: number, workspaceName: string | null, options: CountFormat = {}): string {
  const formatCount = options.formatCount ?? String;
  const one = count === 1;
  const where = workspaceName ? `“${workspaceName}”` : 'your sync workspace';
  return (
    `${formatCount(count)} ${one ? 'interval was' : 'intervals were'} recorded on this device while no account was ` +
    `signed in. Upload ${one ? 'it' : 'them'} to ${where}?`
  );
}

// ---------------------------------------------------------------------------------------------
// Sidebar footer
// ---------------------------------------------------------------------------------------------

export interface SidebarSyncLabel {
  text: string;
  /** Longer explanation (tooltip / accessible description). */
  title: string;
  /** `attention`: the user has to act for sync to continue. */
  emphasis: 'quiet' | 'attention';
}

export interface SidebarSyncInput {
  /** Undefined while the account status is unknown (loading or failed). */
  account: AccountState | undefined;
  overview: SyncOverview | undefined;
  nowMs: number;
  /** Parses an ISO timestamp to epoch ms, or null. */
  parse?: (iso: string | null) => number | null;
  formatCount?: (value: number) => string;
}

function defaultParse(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

const LOCAL_ONLY_TITLE = 'Not signed in. Nothing leaves this device.';

/**
 * The one-line sync state under the sidebar navigation. Returns null while the state is unknown,
 * rather than guessing ("Local only" would be wrong if the device is actually syncing).
 */
export function sidebarSyncLabel(input: SidebarSyncInput): SidebarSyncLabel | null {
  const { account, overview, nowMs } = input;
  const parse = input.parse ?? defaultParse;
  const formatCount = input.formatCount ?? String;
  const signInLabel: SidebarSyncLabel = {
    text: 'Sync paused — sign in',
    title: 'Sign in again in Settings › Sync to resume syncing. Your data stays on this device meanwhile.',
    emphasis: 'attention',
  };

  switch (account) {
    case undefined:
      return null;
    case 'notConfigured':
      return { text: 'Local only', title: 'Sync isn’t configured in this build. Nothing leaves this device.', emphasis: 'quiet' };
    case 'sessionExpired':
      return signInLabel;
    case 'signedOut':
      return overview?.phase === 'needsSignIn' ? signInLabel : { text: 'Local only', title: LOCAL_ONLY_TITLE, emphasis: 'quiet' };
    case 'signedIn':
      break;
  }

  if (!overview) return null;
  const pending = overview.pendingCount;
  const waiting = `${formatCount(pending)} waiting to sync`;
  const where = overview.workspaceName ? ` to “${overview.workspaceName}”` : '';
  switch (overview.phase) {
    case 'disabled':
      return { text: 'Sync off', title: 'Nothing is being uploaded from this device.', emphasis: 'quiet' };
    case 'needsSignIn':
      return signInLabel;
    case 'needsWorkspace':
      return {
        text: 'Choose a sync workspace',
        title: 'Signed in, but no workspace is selected in Settings › Sync, so nothing is uploaded.',
        emphasis: 'attention',
      };
    case 'syncing':
      return { text: 'Syncing…', title: `Uploading closed intervals${where}.`, emphasis: 'quiet' };
    case 'waitingForNetwork':
      return {
        text: pending > 0 ? `Offline · ${waiting}` : 'Offline',
        title: 'The sync server can’t be reached. Studio Pulse retries automatically; nothing is lost.',
        emphasis: 'quiet',
      };
    case 'backoff':
      return {
        text: pending > 0 ? waiting : 'Retrying sync',
        title: 'The sync server reported a problem. Studio Pulse retries automatically; nothing is lost.',
        emphasis: 'quiet',
      };
    case 'error':
      return { text: 'Sync needs attention', title: 'Open Settings › Sync for details.', emphasis: 'attention' };
    case 'idle': {
      if (pending > 0) return { text: waiting, title: `Closed intervals will upload${where} shortly.`, emphasis: 'quiet' };
      const lastMs = parse(overview.lastSuccessAt);
      if (lastMs === null) return { text: 'Up to date', title: `Nothing is waiting to upload${where}.`, emphasis: 'quiet' };
      return {
        text: `Synced ${relativeTime(Math.min(lastMs, nowMs), nowMs)}`,
        title: `Nothing is waiting to upload${where}.`,
        emphasis: 'quiet',
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// What sync uploads (supabase/migrations/20261017090200_time_entries.sql)
// ---------------------------------------------------------------------------------------------

/** Columns of `public.time_entries` written for each uploaded interval, verbatim. */
export const UPLOADED_FIELDS: readonly string[] = [
  'id',
  'workspace_id',
  'user_id',
  'device_id',
  'application_id',
  'application_name',
  'kind',
  'started_at',
  'ended_at',
  'active_ms',
  'idle_ms',
  'end_reason',
  'project_id',
  'task_id',
  'local_revision',
  'recorded_at',
];

/** The same, in words. */
export const UPLOADED_SUMMARY: readonly string[] = [
  'The interval’s random ID, this device’s random ID, your account and the workspace',
  'Which tracked application was in front (its ID and name)',
  'When the interval started and ended, and whether it was active or idle',
  'Why it ended (for example an app switch, idle time or a locked screen)',
  'When this device recorded it',
];
