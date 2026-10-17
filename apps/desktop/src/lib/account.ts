/**
 * Account and workspace input rules and labels. Pure (no DOM, no `@tauri-apps/api`), unit-tested
 * in tests/unit/desktop. The Rust core and Postgres validate again: these checks only give fast,
 * specific feedback before anything is sent.
 */

import type { AccountStatus, TimeEntryVisibility, WorkspaceRole, WorkspaceSummary } from '@studio-pulse/shared-types';

/** Roles an invitation can grant (`create_invitation` never grants ownership). */
export type InvitableRole = Exclude<WorkspaceRole, 'owner'>;

/** RFC 5321 path limit. */
export const EMAIL_MAX_LENGTH = 254;
/** Minimum for a new account. Supabase may require more; its message is shown then. */
export const PASSWORD_MIN_LENGTH = 8;
/** Supabase Auth (bcrypt) rejects passwords longer than 72 bytes. */
export const PASSWORD_MAX_BYTES = 72;
/** `profiles.display_name` and `workspaces.name`: 1–80 characters after trimming. */
export const NAME_MAX_LENGTH = 80;
/** `create_invitation` returns 64 lowercase hex characters (two random UUIDs without dashes). */
export const INVITE_CODE_LENGTH = 64;

const INVITE_CODE_PATTERN = /^[0-9a-f]{64}$/;

function characterCount(value: string): number {
  return Array.from(value).length;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ---------------------------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------------------------

/** What is sent for an email field: surrounding whitespace removed, nothing else changed. */
export function normalizeEmail(raw: string): string {
  return raw.trim();
}

/**
 * A deliberately lenient shape check (`local@domain`, no spaces). Supabase Auth has the final
 * word; this only catches typos such as a missing `@`.
 */
export function emailError(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (email === '') return 'Enter an email address.';
  if (email.length > EMAIL_MAX_LENGTH) return `Email addresses can be at most ${EMAIL_MAX_LENGTH} characters.`;
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const valid =
    at > 0 &&
    !/\s/.test(email) &&
    !local.includes('@') &&
    domain.length > 0 &&
    !domain.startsWith('.') &&
    !domain.endsWith('.') &&
    !domain.includes('..');
  return valid ? null : 'Enter a valid email address, like name@studio.com.';
}

// ---------------------------------------------------------------------------------------------
// Password (never trimmed: spaces are legitimate characters)
// ---------------------------------------------------------------------------------------------

export type PasswordPurpose = 'signIn' | 'signUp';

export function passwordError(password: string, purpose: PasswordPurpose): string | null {
  if (password === '') return 'Enter your password.';
  if (purpose === 'signIn') return null;
  if (password.trim() === '') return 'A password can’t be only spaces.';
  if (characterCount(password) < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (utf8Length(password) > PASSWORD_MAX_BYTES) return `Use at most ${PASSWORD_MAX_BYTES} characters.`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

export function normalizeName(raw: string): string {
  return raw.trim();
}

function nameError(raw: string, empty: string): string | null {
  const name = normalizeName(raw);
  if (name === '') return empty;
  if (characterCount(name) > NAME_MAX_LENGTH) return `Use at most ${NAME_MAX_LENGTH} characters.`;
  return null;
}

export function displayNameError(raw: string): string | null {
  return nameError(raw, 'Enter your name as teammates should see it.');
}

export function workspaceNameError(raw: string): string | null {
  return nameError(raw, 'Enter a workspace name.');
}

// ---------------------------------------------------------------------------------------------
// Invitation codes
// ---------------------------------------------------------------------------------------------

/** Pasted codes often carry line breaks or spaces; the code itself is lowercase hex. */
export function normalizeInviteCode(raw: string): string {
  return raw.replace(/\s+/g, '').toLowerCase();
}

export function inviteCodeError(raw: string): string | null {
  const code = normalizeInviteCode(raw);
  if (code === '') return 'Paste the invitation code you were sent.';
  if (!INVITE_CODE_PATTERN.test(code)) {
    return `That isn’t a complete invitation code. Codes are ${INVITE_CODE_LENGTH} characters, 0–9 and a–f.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Roles and visibility
// ---------------------------------------------------------------------------------------------

export const ROLE_LABELS: Readonly<Record<WorkspaceRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

export const ROLE_DESCRIPTIONS: Readonly<Record<WorkspaceRole, string>> = {
  owner: 'You manage the workspace and can invite admins and members.',
  admin: 'You can invite members.',
  member: 'You belong to the workspace. Owners and admins send invitations.',
};

/**
 * Roles the caller may grant, mirroring `create_invitation`: owners invite admins or members,
 * admins invite members, members invite nobody. Least privileged first (the default choice).
 */
export function inviteRoleOptions(role: WorkspaceRole): readonly InvitableRole[] {
  switch (role) {
    case 'owner':
      return ['member', 'admin'];
    case 'admin':
      return ['member'];
    case 'member':
      return [];
  }
}

export function canInvite(role: WorkspaceRole): boolean {
  return inviteRoleOptions(role).length > 0;
}

export interface VisibilityPresentation {
  label: string;
  description: string;
}

export function describeVisibility(visibility: TimeEntryVisibility): VisibilityPresentation {
  switch (visibility) {
    case 'private':
      return {
        label: 'Private to each member',
        description:
          'Each person’s detailed time entries are visible only to them. This is the default; only the workspace owner can change it.',
      };
    case 'admins':
      return {
        label: 'Owners and admins can see members’ entries',
        description:
          'The workspace owner allowed owners and admins to see every member’s detailed time entries in this workspace, including yours.',
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------------------------

/** The workspace this device uploads to, when it is among the known memberships. */
export function selectedWorkspace(account: AccountStatus): WorkspaceSummary | null {
  if (account.state !== 'signedIn' || !account.syncWorkspaceId) return null;
  return account.workspaces.find((workspace) => workspace.id === account.syncWorkspaceId) ?? null;
}

/** Memberships present in `after` but not in `before` (e.g. the workspace an invitation added). */
export function addedWorkspaces(
  before: readonly WorkspaceSummary[],
  after: readonly WorkspaceSummary[],
): WorkspaceSummary[] {
  const known = new Set(before.map((workspace) => workspace.id));
  return after.filter((workspace) => !known.has(workspace.id));
}

/** The name to greet the user with: display name, else email, else a neutral fallback. */
export function accountName(account: Pick<AccountStatus, 'displayName' | 'email'>): string {
  return account.displayName?.trim() || account.email?.trim() || 'Your account';
}

/**
 * Where this device's intervals go right now (Settings › Privacy), derived only from the account
 * status. Every state other than "signed in with a sync workspace" says plainly that nothing is
 * uploaded. Null while the status is unknown, rather than guessing either way.
 */
export function describeSharing(account: AccountStatus | undefined): string | null {
  if (!account) return null;
  switch (account.state) {
    case 'notConfigured':
      return 'Sync isn’t configured in this build, so nothing leaves this device.';
    case 'signedOut':
      return 'You’re not signed in, so nothing leaves this device.';
    case 'sessionExpired':
      return 'Your session expired, so nothing is being uploaded. Sign in again in Settings › Sync to resume.';
    case 'signedIn': {
      if (!account.syncWorkspaceId) {
        return 'You’re signed in but haven’t chosen a sync workspace, so nothing is being uploaded.';
      }
      const workspace = selectedWorkspace(account);
      if (!workspace) return 'This device uploads closed intervals to your selected sync workspace.';
      const who =
        workspace.timeEntryVisibility === 'private'
          ? 'Your entries there are private to you.'
          : `${describeVisibility(workspace.timeEntryVisibility).label} in that workspace, so they can see yours.`;
      return `This device uploads closed intervals to “${workspace.name}”. ${who}`;
    }
  }
}
