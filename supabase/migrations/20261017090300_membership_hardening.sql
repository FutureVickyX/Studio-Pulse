-- Studio Pulse Phase 2A — 4/4: fixes for defects found by the RLS/RPC test suite
-- (tests/integration/supabase). Files 1/3–3/3 may already be applied to a project, so the fixes
-- are a new migration instead of edits to those files.
--
-- 1. Stale invitations re-admitted removed members.
--    remove_member() left the member's other pending invitations usable. A removed member (or one
--    who left) could therefore rejoin on their own, with no owner or admin action, and with the
--    role of that older invitation: e.g. removed as a member, back as an admin. Removing a member
--    (including leaving) now also revokes every pending invitation to that member's email in the
--    workspace, so only an invitation issued after the removal can bring them back.
--    Test: invitations.test.ts › "an invitation issued before a removal cannot bring the member back".
--
-- 2. Trigger functions were executable by `authenticated`.
--    Supabase's default privileges grant EXECUTE on every new function in `public` to anon,
--    authenticated and service_role; 1/3 revoked it from anon (and PUBLIC) only for its trigger
--    functions. A trigger function cannot be called directly, so this was not exploitable, but
--    the grants now match the least-privilege intent (2/3 already revokes them for its own).
--    Test: privileges.test.ts › "authenticated executes exactly the intended functions".
--
-- 3. Concurrent owner changes could leave a workspace without an owner.
--    Two owners demoting or removing each other at the same moment both passed the last-owner
--    check (READ COMMITTED; only the target row was locked), and set_member_role had no last-owner
--    check at all. Both functions now lock the workspace row first, which serialises every
--    membership change in a workspace, and refuse to demote or remove the last active owner.

create or replace function public.remove_member(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_role public.workspace_role;
  v_owner_count integer;
begin
  -- Serialise membership changes per workspace (see 3. above).
  perform 1 from public.workspaces where id = p_workspace_id for update;
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
  -- An invitation issued before the removal must not let the member back in.
  update public.workspace_invitations i
  set revoked_at = now()
  from auth.users u
  where u.id = p_user_id
    and i.workspace_id = p_workspace_id
    and i.email = lower(btrim(u.email))
    and i.accepted_at is null
    and i.revoked_at is null;
end;
$$;

create or replace function public.set_member_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role public.workspace_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.workspace_role;
  v_owner_count integer;
begin
  -- Serialise membership changes per workspace (see 3. above).
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not public.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'only owners can change roles' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;
  select role into v_current
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id and status = 'active'
  for update;
  if v_current is null then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_current = 'owner' and p_role <> 'owner' then
    select count(*) into v_owner_count
    from public.workspace_members
    where workspace_id = p_workspace_id and role = 'owner' and status = 'active';
    if v_owner_count <= 1 then
      raise exception 'a workspace needs at least one owner' using errcode = '42501';
    end if;
  end if;
  update public.workspace_members
  set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id;
end;
$$;

revoke execute on function
  public.set_updated_at(),
  public.prevent_workspace_change(),
  public.handle_new_user()
from authenticated;
