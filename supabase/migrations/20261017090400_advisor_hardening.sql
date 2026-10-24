-- Studio Pulse Phase 2A — 5/5: hardening from the Supabase database advisors, run against the
-- dev project after 1/3–4/4 were applied. No behaviour changes: the same callers may do the same
-- things, and the RLS/RPC suite (tests/integration/supabase) passes unchanged apart from where it
-- names the helpers' schema.
--
-- 1. The RLS helpers leave the exposed API schema
--    (lint 0029, authenticated_security_definer_function_executable).
--    is_workspace_member, has_workspace_role, is_active_member and shares_workspace_with are
--    SECURITY DEFINER so that policies can read memberships without recursing. In `public`,
--    PostgREST also served them as /rest/v1/rpc/* endpoints. They only answer questions about the
--    caller's own memberships, which a member can already read, but they are not part of the API.
--    They move to a `private` schema that PostgREST does not expose. Policies reference functions
--    by OID and follow the move. The functions whose bodies name a helper are recreated below.
--    The SECURITY DEFINER functions left in `public` are the intended RPCs, and each checks the
--    caller's role before acting.
--
-- 2. auth.uid() is evaluated once per statement (lint 0003, auth_rls_initplan).
--    Policies wrap it as `(select auth.uid())`, so Postgres evaluates it once as an InitPlan
--    instead of once per row. The predicates and results are the same.
--
-- 3. Covering indexes for foreign keys (lint 0001, unindexed_foreign_keys).
--    Deleting a project, task or auth user finds the referencing rows without a sequential scan.
--    Partial indexes skip the null references, which are the common case.

-- ---------------------------------------------------------------------------------------------
-- 1. private schema for the RLS helpers
-- ---------------------------------------------------------------------------------------------

create schema private;
revoke all on schema private from public;
-- USAGE lets SECURITY INVOKER code (sync_time_entries) name the helpers. PostgREST serves only
-- the schemas in its configuration (public, graphql_public), so nothing here becomes an endpoint.
grant usage on schema private to authenticated;

alter function public.is_workspace_member(uuid) set schema private;
alter function public.has_workspace_role(uuid, public.workspace_role[]) set schema private;
alter function public.is_active_member(uuid, uuid) set schema private;
alter function public.shares_workspace_with(uuid) set schema private;

create or replace function private.is_active_member(p_workspace_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_workspace_member(p_workspace_id)
    and exists (
      select 1 from public.workspace_members m
      where m.workspace_id = p_workspace_id
        and m.user_id = p_user_id
        and m.status = 'active'
    );
$$;

-- The move keeps each function's privileges; restate them so this file alone is the record.
revoke execute on function
  private.is_workspace_member(uuid),
  private.has_workspace_role(uuid, public.workspace_role[]),
  private.is_active_member(uuid, uuid),
  private.shares_workspace_with(uuid)
from public, anon;
grant execute on function
  private.is_workspace_member(uuid),
  private.has_workspace_role(uuid, public.workspace_role[]),
  private.is_active_member(uuid, uuid),
  private.shares_workspace_with(uuid)
to authenticated;

-- RPCs whose bodies call a helper (unchanged apart from `private.`).

create or replace function public.create_invitation(
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
  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'only owners and admins can invite' using errcode = '42501';
  end if;
  if p_role = 'admin'
     and not private.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
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

create or replace function public.revoke_invitation(p_invitation_id uuid)
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
     or not private.has_workspace_role(v_workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  update public.workspace_invitations
  set revoked_at = now()
  where id = p_invitation_id and accepted_at is null and revoked_at is null;
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
  -- Serialise membership changes per workspace (4/4).
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not private.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
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
  -- Serialise membership changes per workspace (4/4).
  perform 1 from public.workspaces where id = p_workspace_id for update;
  select role into v_target_role
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id and status = 'active'
  for update;
  if v_target_role is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if p_user_id <> auth.uid() then
    if private.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
      null; -- owners may remove anyone (last-owner check below)
    elsif private.has_workspace_role(p_workspace_id, array['admin']::public.workspace_role[])
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

create or replace function public.set_time_entry_visibility(
  p_workspace_id uuid,
  p_visibility public.time_entry_visibility
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'only owners can change time-entry visibility' using errcode = '42501';
  end if;
  update public.workspaces set time_entry_visibility = p_visibility where id = p_workspace_id;
end;
$$;

create or replace function public.sync_time_entries(p_workspace_id uuid, p_entries jsonb)
returns table (entry_id uuid, status text, detail text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_entry jsonb;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to sync time entries' using errcode = '28000';
  end if;
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;
  if jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'entries must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_entries) > 500 then
    raise exception 'at most 500 entries per call' using errcode = '54000';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries) loop
    v_id := null;
    begin
      v_id := (v_entry ->> 'id')::uuid;
      if v_id is null then
        raise exception 'entry id is required' using errcode = '22023';
      end if;

      if exists (
        select 1 from public.time_entries t where t.id = v_id and t.user_id = auth.uid()
      ) then
        entry_id := v_id; status := 'synced'; detail := 'already present';
        return next;
        continue;
      end if;

      insert into public.time_entries (
        id, workspace_id, user_id, device_id, application_id, application_name, kind,
        started_at, ended_at, active_ms, idle_ms, end_reason, source, project_id, task_id,
        local_revision, recorded_at)
      values (
        v_id,
        p_workspace_id,
        auth.uid(),
        (v_entry ->> 'deviceId')::uuid,
        v_entry ->> 'applicationId',
        v_entry ->> 'applicationName',
        v_entry ->> 'kind',
        (v_entry ->> 'startedAt')::timestamptz,
        (v_entry ->> 'endedAt')::timestamptz,
        (v_entry ->> 'activeMs')::bigint,
        (v_entry ->> 'idleMs')::bigint,
        v_entry ->> 'endReason',
        'automatic',
        nullif(v_entry ->> 'projectId', '')::uuid,
        nullif(v_entry ->> 'taskId', '')::uuid,
        coalesce((v_entry ->> 'revision')::integer, 1),
        coalesce((v_entry ->> 'recordedAt')::timestamptz, now())
      );
      entry_id := v_id; status := 'synced'; detail := null;
      return next;
    exception
      -- Class 22 (data exception) and 23 (integrity violation: a constraint, a foreign key, or
      -- an id that already belongs to another user) are properties of the entry itself.
      when data_exception or integrity_constraint_violation then
        entry_id := v_id; status := 'rejected'; detail := sqlstate || ': ' || sqlerrm;
        return next;
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Policies: auth.uid() once per statement
-- ---------------------------------------------------------------------------------------------

alter policy profiles_select on public.profiles
  using (id = (select auth.uid()) or private.shares_workspace_with(id));
alter policy profiles_update on public.profiles
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

alter policy projects_insert on public.projects
  with check (
    private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    and created_by = (select auth.uid())
  );

alter policy tasks_insert on public.tasks
  with check (
    private.is_workspace_member(workspace_id)
    and created_by = (select auth.uid())
    and (assignee_id is null or private.is_active_member(workspace_id, assignee_id))
  );
alter policy tasks_update on public.tasks
  using (
    private.is_workspace_member(workspace_id)
    and (
      created_by = (select auth.uid())
      or assignee_id = (select auth.uid())
      or private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    )
  )
  with check (
    private.is_workspace_member(workspace_id)
    and (assignee_id is null or private.is_active_member(workspace_id, assignee_id))
  );
alter policy tasks_delete on public.tasks
  using (
    private.is_workspace_member(workspace_id)
    and (
      created_by = (select auth.uid())
      or private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    )
  );

alter policy notes_select on public.notes
  using (
    owner_id = (select auth.uid()) and private.is_workspace_member(workspace_id)
    or (visibility = 'workspace' and private.is_workspace_member(workspace_id))
  );
alter policy notes_insert on public.notes
  with check (owner_id = (select auth.uid()) and private.is_workspace_member(workspace_id));
alter policy notes_update on public.notes
  using (owner_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
  with check (owner_id = (select auth.uid()) and private.is_workspace_member(workspace_id));
alter policy notes_delete on public.notes
  using (
    owner_id = (select auth.uid()) and private.is_workspace_member(workspace_id)
    or (
      visibility = 'workspace'
      and private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    )
  );

alter policy time_entries_select on public.time_entries
  using (
    user_id = (select auth.uid())
    or (
      private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
      and exists (
        select 1 from public.workspaces w
        where w.id = workspace_id and w.time_entry_visibility = 'admins'
      )
    )
  );
alter policy time_entries_insert on public.time_entries
  with check (user_id = (select auth.uid()) and private.is_workspace_member(workspace_id));
alter policy time_entries_delete on public.time_entries
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- 3. Covering indexes for foreign keys
-- ---------------------------------------------------------------------------------------------

-- Composite (same-workspace) references: the index leads with the referencing columns.
drop index public.tasks_project;
create index tasks_project on public.tasks (project_id, workspace_id) where project_id is not null;
create index notes_project on public.notes (project_id, workspace_id) where project_id is not null;
create index time_entries_project on public.time_entries (project_id, workspace_id)
  where project_id is not null;
create index time_entries_task on public.time_entries (task_id, workspace_id)
  where task_id is not null;

-- References to auth.users that become null when an account is deleted.
create index workspaces_created_by on public.workspaces (created_by) where created_by is not null;
create index projects_created_by on public.projects (created_by) where created_by is not null;
create index tasks_created_by on public.tasks (created_by) where created_by is not null;
create index workspace_invitations_invited_by on public.workspace_invitations (invited_by)
  where invited_by is not null;
create index workspace_invitations_accepted_by on public.workspace_invitations (accepted_by)
  where accepted_by is not null;
