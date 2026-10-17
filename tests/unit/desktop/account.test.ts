import { describe, expect, it } from 'vitest';
import type { AccountStatus, TimeEntryVisibility, WorkspaceRole, WorkspaceSummary } from '@studio-pulse/shared-types';

import {
  accountName,
  addedWorkspaces,
  canInvite,
  describeSharing,
  describeVisibility,
  displayNameError,
  emailError,
  INVITE_CODE_LENGTH,
  inviteCodeError,
  inviteRoleOptions,
  NAME_MAX_LENGTH,
  normalizeEmail,
  normalizeInviteCode,
  normalizeName,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  passwordError,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  selectedWorkspace,
  workspaceNameError,
} from '../../../apps/desktop/src/lib/account';

const ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member'];

/** A code shaped exactly like `create_invitation`'s: two UUIDs without dashes. */
const CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90' + '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

function workspace(id: string, role: WorkspaceRole, timeEntryVisibility: TimeEntryVisibility = 'private'): WorkspaceSummary {
  return { id, name: `Studio ${id}`, role, timeEntryVisibility };
}

function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    state: 'signedIn',
    configurationError: null,
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'ada@studio.test',
    displayName: 'Ada',
    workspaces: [],
    syncWorkspaceId: null,
    ...overrides,
  };
}

describe('email', () => {
  it.each(['ada@studio.com', 'a.b+tag@sub.studio.co.uk', 'x@localhost', '  ada@studio.com  ', 'ADA@STUDIO.COM'])(
    'accepts %s',
    (value) => {
      expect(emailError(value)).toBeNull();
    },
  );

  it('asks for an address when empty or blank', () => {
    expect(emailError('')).toBe('Enter an email address.');
    expect(emailError('   ')).toBe('Enter an email address.');
  });

  it.each(['ada', '@studio.com', 'ada@', 'ada@@studio.com', 'a da@studio.com', 'ada@.studio.com', 'ada@studio.', 'ada@studio..com'])(
    'rejects %s',
    (value) => {
      expect(emailError(value)).toMatch(/valid email address/);
    },
  );

  it('rejects addresses longer than 254 characters', () => {
    const long = `${'a'.repeat(250)}@b.co`;
    expect(emailError(long)).toMatch(/at most 254/);
  });

  it('trims surrounding whitespace and changes nothing else', () => {
    expect(normalizeEmail('  Ada@Studio.com \n')).toBe('Ada@Studio.com');
  });
});

describe('password', () => {
  it('only requires something for sign-in (the server decides)', () => {
    expect(passwordError('', 'signIn')).toBe('Enter your password.');
    expect(passwordError('x', 'signIn')).toBeNull();
    expect(passwordError('   ', 'signIn')).toBeNull();
  });

  it(`requires at least ${PASSWORD_MIN_LENGTH} characters for a new account`, () => {
    expect(passwordError('', 'signUp')).toBe('Enter your password.');
    expect(passwordError('a'.repeat(PASSWORD_MIN_LENGTH - 1), 'signUp')).toMatch(/at least 8/);
    expect(passwordError('a'.repeat(PASSWORD_MIN_LENGTH), 'signUp')).toBeNull();
  });

  it('counts characters, not UTF-16 units, for the minimum', () => {
    // 7 emoji are 14 UTF-16 units but still only 7 characters.
    expect(passwordError('🎨'.repeat(7), 'signUp')).toMatch(/at least 8/);
    expect(passwordError('🎨'.repeat(8), 'signUp')).toBeNull();
  });

  it('rejects an all-space password for a new account', () => {
    expect(passwordError(' '.repeat(12), 'signUp')).toMatch(/only spaces/);
  });

  it(`rejects new passwords over ${PASSWORD_MAX_BYTES} UTF-8 bytes (Supabase Auth limit)`, () => {
    expect(passwordError('a'.repeat(PASSWORD_MAX_BYTES), 'signUp')).toBeNull();
    expect(passwordError('a'.repeat(PASSWORD_MAX_BYTES + 1), 'signUp')).toMatch(/at most 72/);
    // 19 four-byte characters = 76 bytes.
    expect(passwordError('🎨'.repeat(19), 'signUp')).toMatch(/at most 72/);
  });

  it('never trims: surrounding spaces are part of the password', () => {
    expect(passwordError('  secret  ', 'signUp')).toBeNull();
  });
});

describe('names', () => {
  it('requires a display name and a workspace name', () => {
    expect(displayNameError('  ')).toMatch(/Enter your name/);
    expect(workspaceNameError('')).toBe('Enter a workspace name.');
    expect(displayNameError('Ada Lovelace')).toBeNull();
    expect(workspaceNameError('Motion Team')).toBeNull();
  });

  it(`allows at most ${NAME_MAX_LENGTH} characters after trimming (the database checks)`, () => {
    expect(workspaceNameError(`  ${'x'.repeat(NAME_MAX_LENGTH)}  `)).toBeNull();
    expect(workspaceNameError('x'.repeat(NAME_MAX_LENGTH + 1))).toMatch(/at most 80/);
    expect(displayNameError('é'.repeat(NAME_MAX_LENGTH + 1))).toMatch(/at most 80/);
  });

  it('trims names before they are sent', () => {
    expect(normalizeName('  Motion Team \t')).toBe('Motion Team');
  });
});

describe('invitation codes', () => {
  it(`accepts the ${INVITE_CODE_LENGTH}-character lowercase hex code create_invitation returns`, () => {
    expect(CODE).toHaveLength(INVITE_CODE_LENGTH);
    expect(inviteCodeError(CODE)).toBeNull();
  });

  it('tolerates pasted whitespace, line breaks and upper case', () => {
    const pasted = `  ${CODE.slice(0, 32).toUpperCase()}\n${CODE.slice(32)} `;
    expect(inviteCodeError(pasted)).toBeNull();
    expect(normalizeInviteCode(pasted)).toBe(CODE);
  });

  it('asks for a code when empty', () => {
    expect(inviteCodeError('  ')).toMatch(/Paste the invitation code/);
  });

  it.each([
    ['too short', CODE.slice(0, 63)],
    ['too long', `${CODE}0`],
    ['not hex', `${CODE.slice(0, 63)}g`],
    ['a dashed UUID', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'],
  ])('rejects a code that is %s', (_, value) => {
    expect(inviteCodeError(value)).toMatch(/isn’t a complete invitation code/);
  });
});

describe('roles', () => {
  it('limits invitable roles exactly like create_invitation', () => {
    expect(inviteRoleOptions('owner')).toEqual(['member', 'admin']);
    expect(inviteRoleOptions('admin')).toEqual(['member']);
    expect(inviteRoleOptions('member')).toEqual([]);
  });

  it('never offers ownership through an invitation', () => {
    for (const role of ROLES) expect(inviteRoleOptions(role)).not.toContain('owner');
  });

  it('defaults to the least privileged role', () => {
    for (const role of ROLES.filter(canInvite)) expect(inviteRoleOptions(role)[0]).toBe('member');
  });

  it('lets owners and admins invite, and members not', () => {
    expect(ROLES.filter(canInvite)).toEqual(['owner', 'admin']);
  });

  it('labels and explains every role', () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role].trim()).not.toBe('');
      expect(ROLE_DESCRIPTIONS[role].trim()).not.toBe('');
    }
  });
});

describe('describeVisibility', () => {
  it('says private is the default and only the owner changes it', () => {
    const text = describeVisibility('private');
    expect(text.label).toBe('Private to each member');
    expect(text.description).toMatch(/visible only to them/);
    expect(text.description).toMatch(/default/);
    expect(text.description).toMatch(/only the workspace owner can change it/);
  });

  it('says plainly who can see entries when the owner widened it', () => {
    const text = describeVisibility('admins');
    expect(text.label).toMatch(/Owners and admins can see/);
    expect(text.description).toMatch(/including yours/);
  });
});

describe('account helpers', () => {
  const a = workspace('a', 'owner');
  const b = workspace('b', 'member', 'admins');

  it('finds the selected sync workspace among the memberships', () => {
    expect(selectedWorkspace(account({ workspaces: [a, b], syncWorkspaceId: 'b' }))).toEqual(b);
  });

  it('returns null without a selection, for an unknown id, or when not signed in', () => {
    expect(selectedWorkspace(account({ workspaces: [a] }))).toBeNull();
    expect(selectedWorkspace(account({ workspaces: [a], syncWorkspaceId: 'zzz' }))).toBeNull();
    expect(selectedWorkspace(account({ state: 'sessionExpired', workspaces: [a], syncWorkspaceId: 'a' }))).toBeNull();
  });

  it('reports the memberships an operation added', () => {
    expect(addedWorkspaces([a], [a, b])).toEqual([b]);
    expect(addedWorkspaces([a, b], [a, b])).toEqual([]);
    expect(addedWorkspaces([], [])).toEqual([]);
  });

  it('describes where data goes, and never implies an upload unless signed in with a workspace', () => {
    expect(describeSharing(undefined)).toBeNull();
    const notUploading = [
      account({ state: 'notConfigured', userId: null, email: null }),
      account({ state: 'signedOut', userId: null, email: null }),
      account({ state: 'sessionExpired', workspaces: [a], syncWorkspaceId: 'a' }),
      account({ workspaces: [a], syncWorkspaceId: null }),
    ];
    for (const status of notUploading) {
      const text = describeSharing(status) ?? '';
      expect(text, status.state).toMatch(/nothing (leaves this device|is being uploaded)/);
      expect(text, status.state).not.toMatch(/This device uploads/);
    }
  });

  it('names the workspace and who can see the entries when uploading', () => {
    expect(describeSharing(account({ workspaces: [a], syncWorkspaceId: 'a' }))).toBe(
      'This device uploads closed intervals to “Studio a”. Your entries there are private to you.',
    );
    expect(describeSharing(account({ workspaces: [b], syncWorkspaceId: 'b' }))).toMatch(
      /^This device uploads closed intervals to “Studio b”\. Owners and admins can see .* so they can see yours\.$/,
    );
    expect(describeSharing(account({ workspaces: [], syncWorkspaceId: 'zzz' }))).toBe(
      'This device uploads closed intervals to your selected sync workspace.',
    );
  });

  it('names the account by display name, then email, then a neutral fallback', () => {
    expect(accountName({ displayName: ' Ada ', email: 'ada@studio.test' })).toBe('Ada');
    expect(accountName({ displayName: '  ', email: 'ada@studio.test' })).toBe('ada@studio.test');
    expect(accountName({ displayName: null, email: null })).toBe('Your account');
  });
});
