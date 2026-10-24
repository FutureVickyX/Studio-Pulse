-- Studio Pulse Phase 2A — 6/6: deleting an account never leaves a workspace without an owner.
--
-- remove_member and set_member_role refuse to remove or demote the last active owner (4/4).
-- Deleting the owner's account bypassed that (Authentication › Users, the Auth admin API or SQL,
-- for example for an erasure request). The cascade auth.users → profiles → workspace_members
-- deletes the membership row directly. The remaining members could then no longer change roles,
-- invite admins, change time-entry visibility or delete the workspace, and no RPC could restore
-- an owner.
--
-- Now, when an active owner's membership row is deleted and no active owner remains, the
-- longest-standing active admin becomes owner, or else the longest-standing active member.
-- Removed members are never promoted. A workspace whose last active member was the deleted
-- owner keeps its rows (removed members still own their time entries) and has no one to manage
-- it. Deleting the workspace itself cascades to its members and promotes nobody.
-- Test: owner-succession.test.ts.

create function public.promote_successor_owner()
returns trigger
language plpgsql
-- Runs inside the cascade of whoever deletes the account (e.g. supabase_auth_admin), which has no
-- privileges on public tables.
security definer
set search_path = ''
as $$
declare
  v_successor uuid;
begin
  if old.role <> 'owner' or old.status <> 'active' then
    return null;
  end if;
  -- The workspace itself is being deleted (its members cascade): nothing to keep.
  if not exists (select 1 from public.workspaces where id = old.workspace_id) then
    return null;
  end if;
  -- Serialise with the membership RPCs, which lock the workspace row first (4/4).
  perform 1 from public.workspaces where id = old.workspace_id for update;
  if exists (
    select 1 from public.workspace_members
    where workspace_id = old.workspace_id and role = 'owner' and status = 'active'
  ) then
    return null;
  end if;
  select m.user_id into v_successor
  from public.workspace_members m
  where m.workspace_id = old.workspace_id and m.status = 'active'
  order by (m.role = 'admin') desc, m.joined_at, m.user_id
  limit 1;
  if v_successor is not null then
    update public.workspace_members
    set role = 'owner'
    where workspace_id = old.workspace_id and user_id = v_successor;
  end if;
  return null;
end;
$$;

create trigger workspace_members_owner_succession
  after delete on public.workspace_members
  for each row execute function public.promote_successor_owner();

revoke execute on function public.promote_successor_owner() from public, anon, authenticated;
