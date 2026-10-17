/**
 * profiles: created by the auth trigger; readable by the user and their active teammates only;
 * only `display_name` of your own profile is writable; no client INSERT or DELETE.
 */

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_DENIED,
  buildWorld,
  fails,
  invite,
  newUser,
  ok,
  only,
  removeMember,
  uniqueEmail,
  useDatabase,
  visibleIds,
} from './fixtures';
import type { TestUser } from './harness';

const db = useDatabase();

async function displayName(user: TestUser): Promise<string> {
  const rows = await db().admin<{ display_name: string }>(
    `select display_name from public.profiles where id = $1`,
    [user.id],
  );
  return only(rows).display_name;
}

describe('profile trigger (on auth.users insert)', () => {
  it('uses display_name from the sign-up metadata, trimmed', async () => {
    const user = await db().createUser(uniqueEmail('ana'), { displayName: '  Ana Lima  ' });
    expect(await displayName(user)).toBe('Ana Lima');
  });

  it('falls back to the email local part when metadata has no usable name', async () => {
    for (const metadata of [{}, null, { display_name: '   ' }, { display_name: '' }, ['x'], 'x']) {
      const email = `kai.${Math.random().toString(16).slice(2, 8)}@example.test`;
      const user = await db().createUser(email, { metadata });
      expect(await displayName(user), JSON.stringify(metadata)).toBe(email.split('@')[0]);
    }
  });

  it('falls back to a fixed name without metadata or email', async () => {
    const user = await db().createUser(null, { metadata: {} });
    expect(await displayName(user)).toBe('Studio Pulse user');
    const atOnly = await db().createUser('@example.test', { metadata: {} });
    expect(await displayName(atOnly)).toBe('Studio Pulse user');
  });

  it('truncates long names to 80 characters instead of failing the sign-up', async () => {
    const long = await db().createUser(uniqueEmail('long'), { displayName: 'x'.repeat(500) });
    expect(await displayName(long)).toBe('x'.repeat(80));

    const multibyte = await db().createUser(uniqueEmail('mb'), { displayName: '名'.repeat(100) });
    expect(await displayName(multibyte)).toBe('名'.repeat(80));

    const localPart = 'l'.repeat(120);
    const longEmail = await db().createUser(`${localPart}@example.test`, { metadata: {} });
    expect(await displayName(longEmail)).toBe('l'.repeat(80));
  });

  it('accepts non-string metadata values as text', async () => {
    const user = await db().createUser(uniqueEmail('num'), { metadata: { display_name: 42 } });
    expect(await displayName(user)).toBe('42');
  });

  it('creates exactly one profile with the auth user id', async () => {
    const user = await newUser(db(), 'one');
    const rows = await db().admin<{ n: number }>(
      `select count(*)::int as n from public.profiles where id = $1`,
      [user.id],
    );
    expect(only(rows).n).toBe(1);
  });
});

describe('reading profiles', () => {
  it('shows yourself and the active members of your workspaces only', async () => {
    const w = await buildWorld(db());
    const ids = (...users: TestUser[]) => users.map((u) => u.id).sort();

    expect(await visibleIds(db(), w.alice, 'profiles')).toEqual(
      ids(w.alice, w.bob, w.carol, w.dave, w.gina),
    );
    expect(await visibleIds(db(), w.erin, 'profiles')).toEqual(ids(w.erin, w.gina, w.frank));
    // gina is in both workspaces.
    expect(await visibleIds(db(), w.gina, 'profiles')).toEqual(
      ids(w.alice, w.bob, w.carol, w.dave, w.gina, w.erin, w.frank),
    );
    expect(await visibleIds(db(), w.mallory, 'profiles')).toEqual(ids(w.mallory));
  });

  it('never shows strangers, even by id', async () => {
    const w = await buildWorld(db());
    for (const stranger of [w.erin, w.frank, w.mallory]) {
      expect(await visibleIds(db(), w.carol, 'profiles', 'id = $1', [stranger.id])).toEqual([]);
    }
    expect(await visibleIds(db(), w.mallory, 'profiles', 'id = $1', [w.alice.id])).toEqual([]);
  });

  it('does not show someone who is only invited', async () => {
    const w = await buildWorld(db());
    ok(await invite(db(), w.alice, w.wsA, w.mallory.email!, 'member'));
    expect(await visibleIds(db(), w.alice, 'profiles', 'id = $1', [w.mallory.id])).toEqual([]);
    expect(await visibleIds(db(), w.mallory, 'profiles', 'id = $1', [w.alice.id])).toEqual([]);
  });

  it('stops showing a teammate as soon as they are removed', async () => {
    const w = await buildWorld(db());
    ok(await removeMember(db(), w.alice, w.wsA, w.dave));
    expect(await visibleIds(db(), w.alice, 'profiles', 'id = $1', [w.dave.id])).toEqual([]);
    expect(await visibleIds(db(), w.dave, 'profiles')).toEqual([w.dave.id]);
  });
});

describe('writing profiles', () => {
  it('lets you change your own display_name', async () => {
    const w = await buildWorld(db());
    const before = only(
      await db().admin<{ updated_at: Date }>(`select updated_at from public.profiles where id = $1`, [
        w.carol.id,
      ]),
    ).updated_at;
    expect(
      ok(
        await db().affected(w.carol, `update public.profiles set display_name = 'Carol B' where id = $1`, [
          w.carol.id,
        ]),
      ),
    ).toBe(1);
    expect(await displayName(w.carol)).toBe('Carol B');
    const after = only(
      await db().admin<{ updated_at: Date }>(`select updated_at from public.profiles where id = $1`, [
        w.carol.id,
      ]),
    ).updated_at;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('validates display_name', async () => {
    const w = await buildWorld(db());
    for (const name of ['', '   ', 'y'.repeat(81)]) {
      fails(
        await db().affected(w.carol, `update public.profiles set display_name = $1 where id = $2`, [
          name,
          w.carol.id,
        ]),
        '23514',
      );
    }
  });

  it("never changes someone else's profile, teammate or not", async () => {
    const w = await buildWorld(db());
    for (const target of [w.bob, w.alice, w.erin, w.mallory]) {
      expect(
        ok(
          await db().affected(w.carol, `update public.profiles set display_name = 'pwned' where id = $1`, [
            target.id,
          ]),
        ),
      ).toBe(0);
      expect(await displayName(target)).not.toBe('pwned');
    }
    // An unfiltered UPDATE touches only the caller's row.
    expect(ok(await db().affected(w.carol, `update public.profiles set display_name = 'Me'`))).toBe(1);
    expect(await displayName(w.bob)).toBe('Bob');
  });

  it('denies every other column', async () => {
    const w = await buildWorld(db());
    for (const assignment of [
      `id = gen_random_uuid()`,
      `created_at = now()`,
      `updated_at = now()`,
    ]) {
      fails(
        await db().affected(w.carol, `update public.profiles set ${assignment} where id = $1`, [
          w.carol.id,
        ]),
        '42501',
        PERMISSION_DENIED,
      );
    }
  });

  it('denies INSERT and DELETE', async () => {
    const w = await buildWorld(db());
    fails(
      await db().affected(w.mallory, `insert into public.profiles (id, display_name) values ($1, 'x')`, [
        w.mallory.id,
      ]),
      '42501',
      PERMISSION_DENIED,
    );
    fails(
      await db().affected(w.carol, `delete from public.profiles where id = $1`, [w.carol.id]),
      '42501',
      PERMISSION_DENIED,
    );
  });
});
