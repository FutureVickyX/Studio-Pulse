-- Studio Pulse Phase 2A — 1/3: identity, workspaces, membership and invitations.
--
-- Security model (docs/supabase.md):
-- * Every table has RLS enabled. Clients use the publishable key + the user's JWT, so policies
--   are evaluated as the `authenticated` role. `anon` gets no table access at all.
-- * Membership, roles and invitations are never written directly by clients. They change only
--   through the SECURITY DEFINER functions below, which check the caller's role first. A user can
--   therefore never grant themselves membership, ownership or an elevated role.
-- * All timestamps are `timestamptz` (stored as UTC instants); clients render local time.

-- ---------------------------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------------------------

create type public.workspace_role as enum ('owner', 'admin', 'member');
create type public.membership_status as enum ('active', 'removed');
-- Who may read members' detailed time entries: only the member themselves ('private', default),
-- or additionally the workspace's owners and admins ('admins').
create type public.time_entry_visibility as enum ('private', 'admins');

-- ---------------------------------------------------------------------------------------------
-- Shared trigger functions
-- ---------------------------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Workspace-owned rows may never move to another workspace (that would bypass the INSERT
-- checks of the target workspace).
create function public.prevent_workspace_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'workspace_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  time_entry_visibility public.time_entry_visibility not null default 'private',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.workspace_role not null default 'member',
  status public.membership_status not null default 'active',
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_active
  on public.workspace_members (user_id)
  where status = 'active';

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  role public.workspace_role not null default 'member' check (role <> 'owner'),
  -- SHA-256 (hex) of the invitation token. The token itself is returned once to the inviter and
  -- never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (accepted_at is null or revoked_at is null)
);

create index workspace_invitations_workspace on public.workspace_invitations (workspace_id);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger workspaces_updated_at before update on public.workspaces
  for each row execute function public.set_updated_at();
create trigger workspace_members_updated_at before update on public.workspace_members
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Authorization helpers (used by policies). SECURITY DEFINER so that policies on
-- workspace_members do not recurse into themselves; each reads only membership facts about the
-- calling user.
-- ---------------------------------------------------------------------------------------------

create function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create function public.has_workspace_role(p_workspace_id uuid, p_roles public.workspace_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = any (p_roles)
  );
$$;

-- Is `p_user_id` an active member of a workspace the caller is also an active member of?
-- Used to validate assignees and to let teammates see each other's profiles.
create function public.is_active_member(p_workspace_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_workspace_member(p_workspace_id)
    and exists (
      select 1 from public.workspace_members m
      where m.workspace_id = p_workspace_id
        and m.user_id = p_user_id
        and m.status = 'active'
    );
$$;

create function public.shares_workspace_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid() and mine.status = 'active'
      and theirs.user_id = p_user_id and theirs.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Profiles are created by the database when Supabase Auth creates a user.
-- ---------------------------------------------------------------------------------------------

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Studio Pulse user'
    ), 80)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------------------------
-- Privileged operations (the only way membership and invitations change)
-- ---------------------------------------------------------------------------------------------

-- Create a workspace; the caller becomes its owner.
create function public.create_workspace(p_name text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
begin
  if auth.uid() is null then
    raise exception 'sign in to create a workspace' using errcode = '28000';
  end if;
  insert into public.workspaces (name, created_by)
  values (btrim(p_name), auth.uid())
  returning * into v_workspace;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace.id, auth.uid(), 'owner');
  return v_workspace;
end;
$$;

-- Invite someone by email. Owners may invite admins or members; admins may invite members.
-- Returns the one-time token; only its hash is stored.
create function public.create_invitation(
  p_workspace_id uuid,
  p_email text,
  p_role public.workspace_role default 'member'
)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_email text := lower(btrim(p_email));
  v_id uuid;
  v_expires timestamptz;
begin
  if p_role = 'owner' then
    raise exception 'invitations cannot grant ownership' using errcode = '42501';
  end if;
  if not public.has_workspace_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'only owners and admins can invite' using errcode = '42501';
  end if;
  if p_role = 'admin'
     and not public.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'only owners can invite admins' using errcode = '42501';
  end if;
  -- 2 × 122 random bits from gen_random_uuid (no extension required).
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.workspace_invitations as i (workspace_id, email, role, token_hash, invited_by)
  values (
    p_workspace_id, v_email, p_role,
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    auth.uid()
  )
  returning i.id, i.expires_at into v_id, v_expires;
  return query select v_id, v_token, v_expires;
end;
$$;

-- Accept an invitation addressed to the caller's email. Returns the workspace id.
create function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.workspace_invitations;
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'sign in to accept an invitation' using errcode = '28000';
  end if;
  select * into v_invitation
  from public.workspace_invitations
  where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
  for update;
  if not found
     or v_invitation.revoked_at is not null
     or v_invitation.accepted_at is not null
     or v_invitation.expires_at <= now() then
    raise exception 'this invitation is invalid or has expired' using errcode = 'P0002';
  end if;
  if v_invitation.email <> v_email then
    raise exception 'this invitation was sent to a different email address' using errcode = '42501';
  end if;
  insert into public.workspace_members as m (workspace_id, user_id, role)
  values (v_invitation.workspace_id, auth.uid(), v_invitation.role)
  on conflict (workspace_id, user_id) do update
    set status = 'active',
        -- Re-joining after removal takes the invited role; an active member keeps their role.
        role = case when m.status = 'removed' then excluded.role else m.role end;
  update public.workspace_invitations
  set accepted_at = now(), accepted_by = auth.uid()
  where id = v_invitation.id;
  return v_invitation.workspace_id;
end;
$$;

create function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id
  from public.workspace_invitations where id = p_invitation_id;
  if v_workspace_id is null
     or not public.has_workspace_role(v_workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  update public.workspace_invitations
  set revoked_at = now()
  where id = p_invitation_id and accepted_at is null and revoked_at is null;
end;
$$;

-- Owners change other members' roles (including granting ownership). Nobody changes their own
-- role, so a workspace can never lose its last owner this way.
create function public.set_member_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role public.workspace_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'only owners can change roles' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;
  update public.workspace_members
  set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id and status = 'active';
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Remove a member (or leave, when p_user_id is the caller). Owners may remove anyone except the
-- last owner; admins may remove members; anyone may leave unless they are the last owner.
create function public.remove_member(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_role public.workspace_role;
  v_owner_count integer;
begin
  select role into v_target_role
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id and status = 'active'
  for update;
  if v_target_role is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if p_user_id <> auth.uid() then
    if public.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
      null; -- owners may remove anyone (last-owner check below)
    elsif public.has_workspace_role(p_workspace_id, array['admin']::public.workspace_role[])
          and v_target_role = 'member' then
      null;
    else
      raise exception 'you cannot remove this member' using errcode = '42501';
    end if;
  end if;
  if v_target_role = 'owner' then
    select count(*) into v_owner_count
    from public.workspace_members
    where workspace_id = p_workspace_id and role = 'owner' and status = 'active';
    if v_owner_count <= 1 then
      raise exception 'a workspace needs at least one owner' using errcode = '42501';
    end if;
  end if;
  update public.workspace_members
  set status = 'removed'
  where workspace_id = p_workspace_id and user_id = p_user_id;
end;
$$;

-- Only owners decide whether admins may read members' detailed time entries.
create function public.set_time_entry_visibility(
  p_workspace_id uuid,
  p_visibility public.time_entry_visibility
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'only owners can change time-entry visibility' using errcode = '42501';
  end if;
  update public.workspaces set time_entry_visibility = p_visibility where id = p_workspace_id;
end;
$$;

-- The caller's workspaces with their role (what the desktop lists for sync).
create function public.my_workspaces()
returns table (
  workspace_id uuid,
  name text,
  role public.workspace_role,
  time_entry_visibility public.time_entry_visibility,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.id, w.name, m.role, w.time_entry_visibility, m.joined_at
  from public.workspace_members m
  join public.workspaces w on w.id = m.workspace_id
  where m.user_id = auth.uid() and m.status = 'active'
  order by m.joined_at, w.name;
$$;

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;

-- profiles: yourself and your teammates. Only you may edit your profile. Rows are created by
-- the auth trigger, so there is no INSERT policy; deletion follows the auth user.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_workspace_with(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- workspaces: members read; owners/admins rename; owners delete. Creation is create_workspace().
create policy workspaces_select on public.workspaces for select to authenticated
  using (public.is_workspace_member(id));
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (public.has_workspace_role(id, array['owner']::public.workspace_role[]));

-- workspace_members: members see the roster. No INSERT/UPDATE/DELETE policies: changes go
-- through the functions above.
create policy workspace_members_select on public.workspace_members for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- workspace_invitations: owners/admins see their workspace's invitations (hashes only).
create policy workspace_invitations_select on public.workspace_invitations for select
  to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- ---------------------------------------------------------------------------------------------
-- Privileges: start from nothing, grant exactly what the policies above expect.
-- ---------------------------------------------------------------------------------------------

revoke all on public.profiles, public.workspaces, public.workspace_members,
  public.workspace_invitations from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select, delete on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;
grant select on public.workspace_members to authenticated;
grant select (id, workspace_id, email, role, invited_by, expires_at, accepted_at, accepted_by,
  revoked_at, created_at) on public.workspace_invitations to authenticated;

revoke execute on function
  public.set_updated_at(),
  public.prevent_workspace_change(),
  public.handle_new_user(),
  public.is_workspace_member(uuid),
  public.has_workspace_role(uuid, public.workspace_role[]),
  public.is_active_member(uuid, uuid),
  public.shares_workspace_with(uuid),
  public.create_workspace(text),
  public.create_invitation(uuid, text, public.workspace_role),
  public.accept_invitation(text),
  public.revoke_invitation(uuid),
  public.set_member_role(uuid, uuid, public.workspace_role),
  public.remove_member(uuid, uuid),
  public.set_time_entry_visibility(uuid, public.time_entry_visibility),
  public.my_workspaces()
from public, anon;

grant execute on function
  public.is_workspace_member(uuid),
  public.has_workspace_role(uuid, public.workspace_role[]),
  public.is_active_member(uuid, uuid),
  public.shares_workspace_with(uuid),
  public.create_workspace(text),
  public.create_invitation(uuid, text, public.workspace_role),
  public.accept_invitation(text),
  public.revoke_invitation(uuid),
  public.set_member_role(uuid, uuid, public.workspace_role),
  public.remove_member(uuid, uuid),
  public.set_time_entry_visibility(uuid, public.time_entry_visibility),
  public.my_workspaces()
to authenticated;
