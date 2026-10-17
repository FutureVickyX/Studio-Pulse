/**
 * workspace_invitations: owners invite admins/members, admins invite members, nobody invites an
 * owner. The token is returned once and only its SHA-256 is stored (and never readable by
 * clients). Accepting requires the invited email; expired, revoked, used and unknown tokens are
 * rejected alike. Invitations are visible to owners/admins only and change only through RPCs.
 */

import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_DENIED,
  accept,
  buildWorld,
  fails,
  invite,
  membership,
  newUser,
  ok,
  only,
  removeMember,
  revokeInvitation,
  uniqueEmail,
  useDatabase,
} from './fixtures';
import type { Role } from './fixtures';
import type { TestUser } from './harness';

const db = useDatabase();

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

interface StoredInvitation {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  token_hash: string;
  invited_by: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by: string | null;
  revoked_at: Date | null;
  created_at: Date;
}

async function stored(id: string): Promise<StoredInvitation> {
  return only(
    await db().admin<StoredInvitation & Record<string, unknown>>(
      `select id, workspace_id, email, role::text as role, token_hash, invited_by, expires_at,
              accepted_at, accepted_by, revoked_at, created_at
         from public.workspace_invitations where id = $1`,
      [id],
    ),
  );
}

/** Ids of every invitation of `workspaceId`, as superuser. */
async function allInvitationIds(workspaceId: string): Promise<string[]> {
  const rows = await db().admin<{ id: string }>(
    `select id from public.workspace_invitations where workspace_id = $1`,
    [workspaceId],
  );
  return rows.map((row) => row.id).sort();
}

/** Ids of the invitations `who` can read (explicit columns: `select *` needs token_hash). */
async function readableInvitationIds(who: TestUser): Promise<string[]> {
  const rows = ok(await db().query<{ id: string }>(who, `select id from public.workspace_invitations`));
  return rows.map((row) => row.id).sort();
}

async function expire(invitationId: string): Promise<void> {
  await db().admin(
    `update public.workspace_invitations set expires_at = now() - interval '1 second' where id = $1`,
    [invitationId],
  );
}

const INVALID = /invalid or has expired/;

describe('create_invitation', () => {
  it('returns a one-time token and stores only its SHA-256', async () => {
    const w = await buildWorld(db());
    const email = uniqueEmail('newbie');
    const invitation = ok(await invite(db(), w.alice, w.wsA, email, 'admin'));
    expect(invitation.token).toMatch(/^[0-9a-f]{64}$/);

    const row = await stored(invitation.invitationId);
    expect(row.token_hash).toBe(sha256(invitation.token));
    expect(row).toMatchObject({
      workspace_id: w.wsA,
      email,
      role: 'admin',
      invited_by: w.alice.id,
      accepted_at: null,
      accepted_by: null,
      revoked_at: null,
    });
    expect(row.expires_at.getTime()).toBe(invitation.expiresAt.getTime());
    const [lifetime] = await db().admin<{ seven_days: boolean }>(
      `select expires_at - created_at = interval '7 days' as seven_days
         from public.workspace_invitations where id = $1`,
      [invitation.invitationId],
    );
    expect(lifetime?.seven_days).toBe(true);

    // The token itself is stored nowhere in the row.
    const [json] = await db().admin<{ row: string }>(
      `select row_to_json(i)::text as row from public.workspace_invitations i where id = $1`,
      [invitation.invitationId],
    );
    expect(json?.row).not.toContain(invitation.token);

    // Every invitation gets its own token.
    const again = ok(await invite(db(), w.alice, w.wsA, email, 'admin'));
    expect(again.token).not.toBe(invitation.token);
    expect((await stored(again.invitationId)).token_hash).toBe(sha256(again.token));
  });

  it('normalizes and validates the email', async () => {
    const w = await buildWorld(db());
    const invitation = ok(await invite(db(), w.alice, w.wsA, '  New.Person@Example.TEST  ', 'member'));
    expect((await stored(invitation.invitationId)).email).toBe('new.person@example.test');

    for (const email of ['nobody', '@example.test', '', '   ']) {
      fails(await invite(db(), w.alice, w.wsA, email, 'member'), '23514');
    }
    fails(
      await db().query(w.alice, `select * from public.create_invitation($1, null, 'member')`, [w.wsA]),
      '23502',
    );
  });

  it('owners invite admins and members; admins invite members', async () => {
    const w = await buildWorld(db());
    const before = (await allInvitationIds(w.wsA)).length;
    ok(await invite(db(), w.alice, w.wsA, uniqueEmail('a'), 'admin'));
    ok(await invite(db(), w.alice, w.wsA, uniqueEmail('b'), 'member'));
    ok(await invite(db(), w.bob, w.wsA, uniqueEmail('c'), 'member'));
    // Role defaults to member.
    const rows = ok(
      await db().query<{ invitation_id: string }>(
        w.bob,
        `select invitation_id from public.create_invitation($1, $2)`,
        [w.wsA, uniqueEmail('d')],
      ),
    );
    expect((await stored(only(rows).invitation_id)).role).toBe('member');
    expect(await allInvitationIds(w.wsA)).toHaveLength(before + 4);
  });

  it('admins cannot invite admins; members, outsiders and strangers cannot invite at all', async () => {
    const w = await buildWorld(db());
    const before = await allInvitationIds(w.wsA);
    fails(await invite(db(), w.bob, w.wsA, uniqueEmail('x'), 'admin'), '42501', /only owners can invite admins/);
    const outsiders: Array<[TestUser, Role]> = [
      [w.carol, 'member'],
      [w.carol, 'admin'],
      [w.gina, 'member'], // admin of B, member of A
      [w.erin, 'member'], // owner of B
      [w.frank, 'member'],
      [w.mallory, 'member'],
    ];
    for (const [caller, role] of outsiders) {
      fails(
        await invite(db(), caller, w.wsA, uniqueEmail('x'), role),
        '42501',
        /only owners and admins can invite/,
      );
    }
    expect(await allInvitationIds(w.wsA)).toEqual(before);
  });

  it('nobody can invite an owner, and an unknown workspace is refused', async () => {
    const w = await buildWorld(db());
    const before = await allInvitationIds(w.wsA);
    for (const caller of [w.alice, w.bob, w.carol, w.mallory]) {
      fails(
        await invite(db(), caller, w.wsA, uniqueEmail('boss'), 'owner'),
        '42501',
        /cannot grant ownership/,
      );
    }
    fails(await invite(db(), w.alice, '00000000-0000-4000-8000-000000000000', uniqueEmail('x')), '42501');
    expect(await allInvitationIds(w.wsA)).toEqual(before);

    // Defence in depth: the table itself refuses an owner invitation, even from the service role.
    fails(
      await db().query(
        'service',
        `insert into public.workspace_invitations (workspace_id, email, role, token_hash)
         values ($1, 'boss@example.test', 'owner', $2)`,
        [w.wsA, sha256('x')],
      ),
      '23514',
    );
  });
});

describe('reading invitations', () => {
  it('owners and admins see their workspace’s invitations; members, invitees and strangers see none', async () => {
    const w = await buildWorld(db());
    ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'member'));
    ok(await invite(db(), w.erin, w.wsB, uniqueEmail('b-guest'), 'member'));
    const invitationsA = await allInvitationIds(w.wsA);
    const invitationsB = await allInvitationIds(w.wsB);
    expect(invitationsA.length).toBeGreaterThan(0);

    expect(await readableInvitationIds(w.alice)).toEqual(invitationsA);
    expect(await readableInvitationIds(w.bob)).toEqual(invitationsA);
    expect(await readableInvitationIds(w.erin)).toEqual(invitationsB);
    // gina administers B but is only a member of A.
    expect(await readableInvitationIds(w.gina)).toEqual(invitationsB);
    for (const user of [w.carol, w.dave, w.frank, w.mallory]) {
      expect(await readableInvitationIds(user), user.label).toEqual([]);
    }
  });

  it('token_hash is never readable or usable as a filter, not even by the owner', async () => {
    const w = await buildWorld(db());
    const invitation = ok(await invite(db(), w.alice, w.wsA, uniqueEmail('x'), 'member'));
    const hash = sha256(invitation.token);
    for (const sql of [
      `select token_hash from public.workspace_invitations`,
      `select * from public.workspace_invitations`,
      `select id from public.workspace_invitations where token_hash = '${hash}'`,
      `select id from public.workspace_invitations order by token_hash`,
      `select count(*) from public.workspace_invitations where token_hash like 'a%'`,
    ]) {
      fails(await db().query(w.alice, sql), '42501', PERMISSION_DENIED);
    }
    // Admin tooling (service role) can, which is how the harness itself can see it.
    const rows = ok(
      await db().query<{ token_hash: string }>(
        'service',
        `select token_hash from public.workspace_invitations where id = $1`,
        [invitation.invitationId],
      ),
    );
    expect(only(rows).token_hash).toBe(hash);
  });

  it('nobody writes invitations directly: insert, update and delete are denied, even for the owner', async () => {
    const w = await buildWorld(db());
    const invitation = ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'member'));
    ok(await revokeInvitation(db(), w.alice, invitation.invitationId));
    const before = await stored(invitation.invitationId);

    fails(
      await db().affected(
        w.alice,
        `insert into public.workspace_invitations (workspace_id, email, role, token_hash)
         values ($1, $2, 'admin', $3)`,
        [w.wsA, w.mallory.email, sha256('chosen')],
      ),
      '42501',
      PERMISSION_DENIED,
    );
    for (const assignment of [
      `revoked_at = null`,
      `expires_at = now() + interval '1 year'`,
      `role = 'admin'`,
      `email = 'someone@example.test'`,
      `accepted_at = now()`,
      `token_hash = '${sha256('chosen')}'`,
    ]) {
      for (const who of [w.alice, w.bob, w.mallory]) {
        fails(
          await db().affected(who, `update public.workspace_invitations set ${assignment} where id = $1`, [
            invitation.invitationId,
          ]),
          '42501',
          PERMISSION_DENIED,
        );
      }
    }
    for (const who of [w.alice, w.bob]) {
      fails(
        await db().affected(who, `delete from public.workspace_invitations where id = $1`, [
          invitation.invitationId,
        ]),
        '42501',
        PERMISSION_DENIED,
      );
    }
    expect(await stored(invitation.invitationId)).toEqual(before);
  });
});

describe('accept_invitation', () => {
  it('adds the invitee with the invited role; the token works once', async () => {
    const w = await buildWorld(db());
    const newbie = await newUser(db(), 'newbie');
    const invitation = ok(await invite(db(), w.alice, w.wsA, newbie.email!, 'admin'));

    expect(ok(await accept(db(), newbie, invitation.token))).toBe(w.wsA);
    expect(await membership(db(), w.wsA, newbie)).toEqual({ role: 'admin', status: 'active' });
    const row = await stored(invitation.invitationId);
    expect(row.accepted_by).toBe(newbie.id);
    expect(row.accepted_at).toBeInstanceOf(Date);
    expect(row.revoked_at).toBeNull();
    const mine = ok(
      await db().query(newbie, `select workspace_id, role::text as role from public.my_workspaces()`),
    );
    expect(mine).toEqual([{ workspace_id: w.wsA, role: 'admin' }]);

    fails(await accept(db(), newbie, invitation.token), 'P0002', INVALID);
  });

  it('is bound to the invited email: another account holding the token cannot use it', async () => {
    const w = await buildWorld(db());
    const invitation = ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'admin'));
    for (const thief of [w.frank, w.erin, w.carol]) {
      fails(await accept(db(), thief, invitation.token), '42501', /different email address/);
    }
    expect(await membership(db(), w.wsA, w.frank)).toBeUndefined();
    expect(await membership(db(), w.wsA, w.erin)).toBeUndefined();
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'member', status: 'active' });
    expect((await stored(invitation.invitationId)).accepted_at).toBeNull();

    // The rightful invitee can still accept.
    expect(ok(await accept(db(), w.mallory, invitation.token))).toBe(w.wsA);
    expect(await membership(db(), w.wsA, w.mallory)).toEqual({ role: 'admin', status: 'active' });
  });

  it('compares emails case-insensitively', async () => {
    const w = await buildWorld(db());
    const tag = randomBytes(3).toString('hex');
    const shouty = await db().createUser(`Mixed.Case.${tag}@Example.TEST`, { label: 'shouty' });
    const invitation = ok(
      await invite(db(), w.alice, w.wsA, `mixed.case.${tag}@example.test`, 'member'),
    );
    expect(ok(await accept(db(), shouty, invitation.token))).toBe(w.wsA);
  });

  it('an account without an email (phone sign-up) cannot accept', async () => {
    const w = await buildWorld(db());
    const phoneUser = await db().createUser(null, { label: 'phone' });
    const invitation = ok(await invite(db(), w.alice, w.wsA, uniqueEmail('phone'), 'member'));
    fails(await accept(db(), phoneUser, invitation.token), '42501', /different email address/);
    expect(await membership(db(), w.wsA, phoneUser)).toBeUndefined();
  });

  it('rejects unknown, empty, hashed, expired and revoked tokens with one indistinguishable error', async () => {
    const w = await buildWorld(db());
    const email = w.mallory.email!;
    const expired = ok(await invite(db(), w.alice, w.wsA, email, 'member'));
    await expire(expired.invitationId);
    const revoked = ok(await invite(db(), w.alice, w.wsA, email, 'member'));
    ok(await revokeInvitation(db(), w.alice, revoked.invitationId));
    const pending = ok(await invite(db(), w.alice, w.wsA, email, 'member'));

    const messages = new Set<string>();
    for (const token of [
      randomBytes(32).toString('hex'),
      '',
      null,
      sha256(pending.token), // knowing the stored hash is useless
      pending.token.toUpperCase(),
      ` ${pending.token}`,
      expired.token,
      revoked.token,
    ]) {
      messages.add(fails(await accept(db(), w.mallory, token), 'P0002', INVALID).message);
    }
    expect(messages.size).toBe(1);
    expect(await membership(db(), w.wsA, w.mallory)).toBeUndefined();
    expect((await stored(expired.invitationId)).accepted_at).toBeNull();
    expect((await stored(revoked.invitationId)).accepted_at).toBeNull();
  });

  it('an active member keeps their role when accepting another invitation', async () => {
    const w = await buildWorld(db());
    const demote = ok(await invite(db(), w.alice, w.wsA, w.bob.email!, 'member'));
    expect(ok(await accept(db(), w.bob, demote.token))).toBe(w.wsA);
    expect(await membership(db(), w.wsA, w.bob)).toEqual({ role: 'admin', status: 'active' });

    const promote = ok(await invite(db(), w.alice, w.wsA, w.carol.email!, 'admin'));
    expect(ok(await accept(db(), w.carol, promote.token))).toBe(w.wsA);
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'member', status: 'active' });
    expect((await stored(promote.invitationId)).accepted_by).toBe(w.carol.id);
  });

  it('after a removal, a new invitation re-activates the member with the newly invited role', async () => {
    const w = await buildWorld(db());
    ok(await removeMember(db(), w.alice, w.wsA, w.bob)); // was admin
    ok(await removeMember(db(), w.alice, w.wsA, w.carol)); // was member

    const bobBack = ok(await invite(db(), w.alice, w.wsA, w.bob.email!, 'member'));
    expect(ok(await accept(db(), w.bob, bobBack.token))).toBe(w.wsA);
    expect(await membership(db(), w.wsA, w.bob)).toEqual({ role: 'member', status: 'active' });

    const carolBack = ok(await invite(db(), w.alice, w.wsA, w.carol.email!, 'admin'));
    expect(ok(await accept(db(), w.carol, carolBack.token))).toBe(w.wsA);
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'admin', status: 'active' });
  });

  it('an invitation issued before a removal cannot bring the member back', async () => {
    const w = await buildWorld(db());
    // mallory was sent two invitations and joined as a member through the second one.
    const stale = ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'admin'));
    const used = ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'member'));
    ok(await accept(db(), w.mallory, used.token));
    // Unrelated pending invitations: another address in A, and mallory in B.
    const other = ok(await invite(db(), w.alice, w.wsA, uniqueEmail('other'), 'member'));
    const elsewhere = ok(await invite(db(), w.erin, w.wsB, w.mallory.email!, 'member'));

    ok(await removeMember(db(), w.alice, w.wsA, w.mallory));
    fails(await accept(db(), w.mallory, stale.token), 'P0002', INVALID);
    expect(await membership(db(), w.wsA, w.mallory)).toEqual({ role: 'member', status: 'removed' });
    expect((await stored(stale.invitationId)).revoked_at).toBeInstanceOf(Date);
    expect((await stored(other.invitationId)).revoked_at).toBeNull();
    expect((await stored(elsewhere.invitationId)).revoked_at).toBeNull();
    expect(ok(await accept(db(), w.mallory, elsewhere.token))).toBe(w.wsB);

    // Leaving voluntarily is no way around it either (leave, then rejoin as admin).
    const carolStale = ok(await invite(db(), w.alice, w.wsA, w.carol.email!, 'admin'));
    ok(await removeMember(db(), w.carol, w.wsA, w.carol));
    fails(await accept(db(), w.carol, carolStale.token), 'P0002', INVALID);
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'member', status: 'removed' });

    // Only a new invitation brings them back.
    const fresh = ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'member'));
    expect(ok(await accept(db(), w.mallory, fresh.token))).toBe(w.wsA);
    expect(await membership(db(), w.wsA, w.mallory)).toEqual({ role: 'member', status: 'active' });
  });

  it('an invitation to a deleted workspace no longer works', async () => {
    const w = await buildWorld(db());
    const invitation = ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'member'));
    expect(ok(await db().affected(w.alice, `delete from public.workspaces where id = $1`, [w.wsA]))).toBe(1);
    fails(await accept(db(), w.mallory, invitation.token), 'P0002', INVALID);
    expect(ok(await db().query(w.mallory, `select * from public.my_workspaces()`))).toEqual([]);
  });
});

describe('revoke_invitation', () => {
  it('owners and admins revoke pending invitations, which then cannot be accepted', async () => {
    const w = await buildWorld(db());
    const byOwner = ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'admin'));
    const byAdmin = ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'member'));
    ok(await revokeInvitation(db(), w.alice, byOwner.invitationId));
    ok(await revokeInvitation(db(), w.bob, byAdmin.invitationId));
    for (const invitation of [byOwner, byAdmin]) {
      expect((await stored(invitation.invitationId)).revoked_at).toBeInstanceOf(Date);
      fails(await accept(db(), w.mallory, invitation.token), 'P0002', INVALID);
    }
    expect(await membership(db(), w.wsA, w.mallory)).toBeUndefined();
  });

  it('members, other workspaces, the invitee and strangers get "not found" and change nothing', async () => {
    const w = await buildWorld(db());
    const invitation = ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'member'));
    for (const caller of [w.carol, w.dave, w.gina, w.erin, w.frank, w.mallory]) {
      fails(await revokeInvitation(db(), caller, invitation.invitationId), 'P0002', /invitation not found/);
    }
    fails(
      await revokeInvitation(db(), w.alice, '00000000-0000-4000-8000-000000000000'),
      'P0002',
      /invitation not found/,
    );
    expect((await stored(invitation.invitationId)).revoked_at).toBeNull();
    expect(ok(await accept(db(), w.mallory, invitation.token))).toBe(w.wsA);
  });

  it('revoking an accepted invitation removes nobody; revoking twice is harmless', async () => {
    const w = await buildWorld(db());
    const [carolInvitation] = await db().admin<{ id: string }>(
      `select id from public.workspace_invitations where workspace_id = $1 and accepted_by = $2`,
      [w.wsA, w.carol.id],
    );
    ok(await revokeInvitation(db(), w.alice, carolInvitation!.id));
    const accepted = await stored(carolInvitation!.id);
    expect(accepted.revoked_at).toBeNull();
    expect(accepted.accepted_at).toBeInstanceOf(Date);
    expect(await membership(db(), w.wsA, w.carol)).toEqual({ role: 'member', status: 'active' });

    const pending = ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'member'));
    ok(await revokeInvitation(db(), w.alice, pending.invitationId));
    const first = (await stored(pending.invitationId)).revoked_at;
    ok(await revokeInvitation(db(), w.bob, pending.invitationId));
    expect((await stored(pending.invitationId)).revoked_at).toEqual(first);
  });
});
