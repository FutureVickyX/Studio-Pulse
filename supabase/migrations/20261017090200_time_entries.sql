-- Studio Pulse Phase 2A — 3/3: synchronized tracking intervals and the idempotent sync RPC.
--
-- A row is one closed interval recorded by the desktop tracker (docs/architecture.md §4):
-- one application in the foreground, wholly active or wholly idle. The semantics are kept
-- exactly; nothing is derived or invented here:
--   * id            the desktop's stable UUIDv7, the idempotency key (primary key)
--   * started_at / ended_at   UTC instants (timestamptz); clients render local time
--   * active_ms / idle_ms     measured split; active_ms + idle_ms = ended_at - started_at
-- This table holds automatically measured FOREGROUND time only. It has no billable flag and is
-- never treated as billable work. Manually recorded task time is a separate, later table.

create table public.time_entries (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  device_id uuid not null,
  application_id text not null check (application_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  application_name text not null check (char_length(btrim(application_name)) between 1 and 80),
  kind text not null check (kind in ('active', 'idle')),
  started_at timestamptz not null check (started_at >= timestamptz '2020-01-01 00:00:00+00'),
  ended_at timestamptz not null,
  active_ms bigint not null check (active_ms >= 0),
  idle_ms bigint not null check (idle_ms >= 0),
  end_reason text not null check (end_reason in (
    'appSwitch', 'becameIdle', 'inputResumed', 'untracked', 'sessionAway', 'paused', 'disabled',
    'timeGap', 'clockChange', 'shutdown', 'recovered', 'settingsChanged')),
  -- Only automatic tracker intervals live here (see header).
  source text not null default 'automatic' check (source = 'automatic'),
  -- Optional attribution, always a user action (Phase 3); must belong to the same workspace.
  project_id uuid,
  task_id uuid,
  local_revision integer not null default 1 check (local_revision >= 1),
  -- When the desktop first recorded the row (its local created_at), and when the server got it.
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ended_at >= started_at),
  check (ended_at - started_at <= interval '31 days'),
  check (active_ms + idle_ms = round(extract(epoch from (ended_at - started_at)) * 1000)::bigint),
  check (kind <> 'active' or idle_ms = 0),
  check (kind <> 'idle' or active_ms = 0),
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete set null (project_id),
  foreign key (task_id, workspace_id)
    references public.tasks (id, workspace_id) on delete set null (task_id)
);

create index time_entries_workspace_started on public.time_entries (workspace_id, started_at);
create index time_entries_user_started on public.time_entries (user_id, started_at);

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------

alter table public.time_entries enable row level security;

-- Read: always your own entries. Owners/admins additionally read members' entries only when the
-- workspace owner chose visibility 'admins'. Default is private.
create policy time_entries_select on public.time_entries for select to authenticated
  using (
    user_id = auth.uid()
    or (
      public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
      and exists (
        select 1 from public.workspaces w
        where w.id = workspace_id and w.time_entry_visibility = 'admins'
      )
    )
  );

-- Insert: only as yourself, only into a workspace you are an active member of. Project/task
-- references are checked by the composite foreign keys (same workspace).
create policy time_entries_insert on public.time_entries for insert to authenticated
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- Delete: your own history (personal deletion). There is no UPDATE policy: synced intervals
-- are immutable, exactly as closed intervals are on the desktop.
create policy time_entries_delete on public.time_entries for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.time_entries from anon, authenticated;
grant select, delete on public.time_entries to authenticated;
grant insert (id, workspace_id, user_id, device_id, application_id, application_name, kind,
  started_at, ended_at, active_ms, idle_ms, end_reason, source, project_id, task_id,
  local_revision, recorded_at) on public.time_entries to authenticated;

-- ---------------------------------------------------------------------------------------------
-- sync_time_entries: idempotent batch upload used by the desktop sync service.
--
-- SECURITY INVOKER: every insert is checked by the RLS policies above as the calling user.
-- Per entry the result is:
--   'synced'   inserted now, or already present and owned by the caller (a retry after a lost
--              response) — safe to mark synced locally;
--   'rejected' the entry itself is invalid (constraint/data error) or its id belongs to someone
--              else — retrying the same payload cannot succeed.
-- Anything else (not a member, not signed in, transient errors) fails the whole call so the
-- client keeps every entry pending and retries later.
-- ---------------------------------------------------------------------------------------------

create function public.sync_time_entries(p_workspace_id uuid, p_entries jsonb)
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
  if not public.is_workspace_member(p_workspace_id) then
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

revoke execute on function public.sync_time_entries(uuid, jsonb) from public, anon;
grant execute on function public.sync_time_entries(uuid, jsonb) to authenticated;
