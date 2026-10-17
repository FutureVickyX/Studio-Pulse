import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AccountState, AccountStatus, SyncOverview, SyncPhase } from '@studio-pulse/shared-types';

import {
  canSyncNow,
  claimDismissKey,
  claimPrompt,
  claimQuestion,
  describeSyncPhase,
  relativeSchedule,
  relativeTime,
  sidebarSyncLabel,
  UPLOADED_FIELDS,
} from '../../../apps/desktop/src/lib/sync';
import type { SyncToneName } from '../../../apps/desktop/src/lib/sync';

const PHASES: readonly SyncPhase[] = [
  'disabled',
  'idle',
  'syncing',
  'waitingForNetwork',
  'backoff',
  'needsSignIn',
  'needsWorkspace',
  'error',
];

const TONES: readonly SyncToneName[] = ['tracking', 'idle', 'paused', 'off', 'away', 'danger', 'accent'];

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

function overview(phase: SyncPhase, overrides: Partial<SyncOverview> = {}): SyncOverview {
  return {
    phase,
    pendingCount: 0,
    unclaimedCount: 0,
    rejectedCount: 0,
    lastSuccessAt: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastError: null,
    workspaceId: 'ws-1',
    workspaceName: 'Motion Team',
    ...overrides,
  };
}

describe('describeSyncPhase', () => {
  it.each(PHASES)('%s has a label, an explanation and a known tone', (phase) => {
    const text = describeSyncPhase(overview(phase));
    expect(text.phase).toBe(phase);
    expect(TONES).toContain(text.tone);
    expect(text.label.trim()).not.toBe('');
    expect(text.explanation.trim()).not.toBe('');
  });

  it('gives every phase its own text label, so colour is never the only signal', () => {
    const labels = PHASES.map((phase) => describeSyncPhase(overview(phase)).label);
    expect(new Set(labels).size).toBe(PHASES.length);
  });

  it('says "Up to date" only when nothing is pending', () => {
    expect(describeSyncPhase(overview('idle')).label).toBe('Up to date');
    const queued = describeSyncPhase(overview('idle', { pendingCount: 3 }));
    expect(queued.label).toBe('Queued');
    expect(queued.explanation).toBe('3 intervals will upload to “Motion Team” shortly.');
    expect(describeSyncPhase(overview('idle', { pendingCount: 1 })).explanation).toMatch(/^1 interval will/);
  });

  it('uses the supplied count format', () => {
    const text = describeSyncPhase(overview('idle', { pendingCount: 1234 }), { formatCount: () => '1,234' });
    expect(text.explanation).toMatch(/^1,234 intervals/);
  });

  it('reassures that nothing is lost while offline or backing off', () => {
    expect(describeSyncPhase(overview('waitingForNetwork')).explanation).toMatch(/keeps everything on this device/);
    expect(describeSyncPhase(overview('backoff')).explanation).toMatch(/Nothing is lost/);
  });

  it('marks only a real error as danger', () => {
    for (const phase of PHASES) {
      expect(describeSyncPhase(overview(phase)).tone === 'danger', phase).toBe(phase === 'error');
    }
  });

  it('falls back to a generic name without a workspace name', () => {
    expect(describeSyncPhase(overview('syncing', { workspaceName: null })).explanation).toMatch(/the sync workspace/);
  });
});

describe('canSyncNow', () => {
  it('is offered only when an upload can actually run', () => {
    expect(PHASES.filter(canSyncNow)).toEqual(['idle', 'syncing', 'waitingForNetwork', 'backoff', 'error']);
  });
});

describe('relativeTime', () => {
  it.each([
    [0, 'just now'],
    [-30_000, 'just now'],
    [-50_000, '1 min ago'],
    [-2 * MIN, '2 min ago'],
    [-59 * MIN, '59 min ago'],
    [-59.8 * MIN, '1 h ago'],
    [-3 * HOUR, '3 h ago'],
    [-30 * HOUR, '1 d ago'],
    [-49 * HOUR, '2 d ago'],
    [20_000, 'in a few seconds'],
    [3 * MIN, 'in 3 min'],
    [7 * 24 * HOUR, 'in 7 d'],
  ])('%i ms → %s', (delta, text) => {
    expect(relativeTime(NOW + delta, NOW)).toBe(text);
  });
});

describe('relativeSchedule', () => {
  it('reads like relativeTime for a future attempt', () => {
    expect(relativeSchedule(NOW + 3 * MIN, NOW)).toBe('in 3 min');
    expect(relativeSchedule(NOW + 20_000, NOW)).toBe('in a few seconds');
  });

  it('says "due now" for an overdue or current attempt instead of "… ago"', () => {
    expect(relativeSchedule(NOW, NOW)).toBe('due now');
    expect(relativeSchedule(NOW - 5 * MIN, NOW)).toBe('due now');
  });
});

describe('claimPrompt (earlier history is uploaded only with explicit consent)', () => {
  const USER = '00000000-0000-4000-8000-000000000001';

  function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
    return {
      state: 'signedIn',
      configurationError: null,
      userId: USER,
      email: 'ada@studio.test',
      displayName: 'Ada',
      workspaces: [{ id: 'ws-1', name: 'Motion Team', role: 'owner', timeEntryVisibility: 'private' }],
      syncWorkspaceId: 'ws-1',
      ...overrides,
    };
  }

  it('asks nothing when there is no unowned history', () => {
    expect(claimPrompt(account(), overview('idle'))).toEqual({ kind: 'none' });
  });

  it('asks only while signed in', () => {
    for (const state of ['notConfigured', 'signedOut', 'sessionExpired'] as const) {
      expect(claimPrompt(account({ state }), overview('idle', { unclaimedCount: 5 })), state).toEqual({ kind: 'none' });
    }
  });

  it('asks for consent naming the selected workspace', () => {
    expect(claimPrompt(account(), overview('idle', { unclaimedCount: 5 }))).toEqual({
      kind: 'ask',
      count: 5,
      workspaceName: 'Motion Team',
    });
  });

  it('names the workspace from the account selection, not a stale overview', () => {
    const stale = overview('idle', { unclaimedCount: 2, workspaceId: 'ws-old', workspaceName: 'Old Studio' });
    expect(claimPrompt(account(), stale)).toMatchObject({ kind: 'ask', workspaceName: 'Motion Team' });
    // Unknown membership: trust the overview only when it describes the same workspace.
    const unknown = account({ workspaces: [] });
    expect(claimPrompt(unknown, stale)).toMatchObject({ kind: 'ask', workspaceName: null });
    expect(claimPrompt(unknown, overview('idle', { unclaimedCount: 2 }))).toMatchObject({ workspaceName: 'Motion Team' });
  });

  it('asks the user to choose a workspace first when none is selected', () => {
    expect(claimPrompt(account({ syncWorkspaceId: null }), overview('needsWorkspace', { unclaimedCount: 3 }))).toEqual({
      kind: 'chooseWorkspace',
      count: 3,
    });
  });

  it('respects "Keep local only" for exactly that account and count', () => {
    const dismissed = new Set([claimDismissKey(USER, 5)]);
    expect(claimPrompt(account(), overview('idle', { unclaimedCount: 5 }), dismissed)).toEqual({ kind: 'none' });
    // More history recorded during a later signed-out stretch asks again.
    expect(claimPrompt(account(), overview('idle', { unclaimedCount: 6 }), dismissed).kind).toBe('ask');
    // So does another account on the same device.
    const other = account({ userId: '00000000-0000-4000-8000-000000000002' });
    expect(claimPrompt(other, overview('idle', { unclaimedCount: 5 }), dismissed).kind).toBe('ask');
  });

  it('phrases the question as the explicit consent it is', () => {
    expect(claimQuestion(3, 'Motion Team')).toBe(
      '3 intervals were recorded on this device while no account was signed in. Upload them to “Motion Team”?',
    );
    expect(claimQuestion(1, null)).toBe(
      '1 interval was recorded on this device while no account was signed in. Upload it to your sync workspace?',
    );
    expect(claimQuestion(1234, 'X', { formatCount: () => '1,234' })).toMatch(/^1,234 intervals were/);
  });
});

describe('sidebarSyncLabel', () => {
  function label(account: AccountState | undefined, sync?: SyncOverview) {
    return sidebarSyncLabel({ account, overview: sync, nowMs: NOW });
  }

  it('shows nothing while the account state is unknown, instead of guessing', () => {
    expect(label(undefined, overview('idle'))).toBeNull();
    expect(label('signedIn', undefined)).toBeNull();
  });

  it('says "Local only" when sync is not configured or nobody is signed in', () => {
    expect(label('notConfigured', overview('disabled'))?.text).toBe('Local only');
    expect(label('signedOut', overview('disabled'))?.text).toBe('Local only');
    expect(label('signedOut', undefined)?.text).toBe('Local only');
    expect(label('signedOut', overview('disabled'))?.emphasis).toBe('quiet');
  });

  it('never says "Local only" while signed in', () => {
    for (const phase of PHASES) expect(label('signedIn', overview(phase))?.text, phase).not.toBe('Local only');
  });

  it('asks to sign in when the session expired or pending records need a session', () => {
    expect(label('sessionExpired', overview('needsSignIn'))?.text).toBe('Sync paused — sign in');
    expect(label('sessionExpired', undefined)?.emphasis).toBe('attention');
    expect(label('signedOut', overview('needsSignIn'))?.text).toBe('Sync paused — sign in');
    expect(label('signedIn', overview('needsSignIn'))?.text).toBe('Sync paused — sign in');
  });

  it('asks for a workspace when none is selected', () => {
    const result = label('signedIn', overview('needsWorkspace', { workspaceName: null }));
    expect(result?.text).toBe('Choose a sync workspace');
    expect(result?.emphasis).toBe('attention');
  });

  it('counts what is waiting', () => {
    expect(label('signedIn', overview('idle', { pendingCount: 4 }))?.text).toBe('4 waiting to sync');
    expect(label('signedIn', overview('backoff', { pendingCount: 2 }))?.text).toBe('2 waiting to sync');
    expect(label('signedIn', overview('waitingForNetwork', { pendingCount: 2 }))?.text).toBe('Offline · 2 waiting to sync');
    expect(label('signedIn', overview('waitingForNetwork'))?.text).toBe('Offline');
  });

  it('says when it last synced, relative to now', () => {
    const lastSuccessAt = new Date(NOW - 2 * MIN).toISOString();
    expect(label('signedIn', overview('idle', { lastSuccessAt }))?.text).toBe('Synced 2 min ago');
    expect(label('signedIn', overview('idle'))?.text).toBe('Up to date');
  });

  it('never claims a sync in the future when the clock is behind', () => {
    const lastSuccessAt = new Date(NOW + 10 * MIN).toISOString();
    expect(label('signedIn', overview('idle', { lastSuccessAt }))?.text).toBe('Synced just now');
  });

  it('ignores an unreadable timestamp rather than inventing a time', () => {
    expect(label('signedIn', overview('idle', { lastSuccessAt: 'yesterday' }))?.text).toBe('Up to date');
  });

  it('flags errors for attention and stays quiet otherwise', () => {
    expect(label('signedIn', overview('error'))?.emphasis).toBe('attention');
    expect(label('signedIn', overview('syncing'))?.text).toBe('Syncing…');
    expect(label('signedIn', overview('syncing'))?.emphasis).toBe('quiet');
  });

  it('gives every label a longer explanation', () => {
    for (const state of ['notConfigured', 'signedOut', 'sessionExpired', 'signedIn'] as const) {
      for (const phase of PHASES) {
        const result = label(state, overview(phase));
        if (result) expect(result.title.trim(), `${state}/${phase}`).not.toBe('');
      }
    }
  });
});

describe('UPLOADED_FIELDS', () => {
  const migration = readFileSync(
    fileURLToPath(new URL('../../../supabase/migrations/20261017090200_time_entries.sql', import.meta.url)),
    'utf8',
  );
  const insertGrant = /grant insert \(([^)]*)\) on public\.time_entries/i.exec(migration)?.[1] ?? '';
  const insertable = insertGrant.split(',').map((column) => column.trim());

  it('lists only columns the desktop may write, so Privacy never shows a field that is not uploaded', () => {
    expect(insertable.length).toBeGreaterThan(0);
    for (const field of UPLOADED_FIELDS) expect(insertable, field).toContain(field);
  });

  it('lists every writable column except the constant `source`', () => {
    expect([...UPLOADED_FIELDS].sort()).toEqual(insertable.filter((column) => column !== 'source').sort());
  });

  it('never lists content the tracker does not record', () => {
    for (const field of UPLOADED_FIELDS) expect(field).not.toMatch(/title|path|key|clip|screen|url|content/i);
  });
});
