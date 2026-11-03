-- Studio Pulse Phase 2B — 8: the shared workspace (projects, tasks, notes) and time attribution.
--
-- Additive only. No table is replaced, no existing row is rewritten, and no existing policy is
-- relaxed for data that was protected before:
--  1. Projects gain planning / on hold / completed states, a lead (an active member, who may then
--     edit the project), start and due dates, and a version for conflict detection. A project
--     with work attached (tasks, notes or tracked time) cannot be deleted: archive it instead.
--  2. Tasks gain a version. A task with tracked time cannot be deleted: archive it instead.
--  3. task_subtasks (a checklist per task) and task_comments.
--  4. Shared ('workspace') notes become editable by every active member, with version checks in
--     the client. Only the owner changes a note's sharing, project, pin or archive state.
--  5. time_entries: the owner may attribute an entry to a project and optionally a task. Only
--     project_id and task_id are writable; everything measured stays immutable.
--  6. Clients may supply the id of a new project, task, note, subtask or comment, so a create
--     retried after a lost response fails with 23505 instead of creating a duplicate.
--  7. The shared tables join the supabase_realtime publication (RLS applies to subscribers).
-- Tests: tests/integration/supabase/collaboration.test.ts, plus projects, tasks, notes and time-entries.

-- ---------------------------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------------------------

-- Optimistic concurrency: every update increments `version`. Clients update
-- `where id = $1 and version = $expected` and treat 0 rows as a conflict to resolve.
create function public.bump_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

-- Who may edit a task (and therefore its checklist): its creator, its assignee, or an
-- owner/admin, all as active members. The same rule as the tasks_update policy.
create function private.can_edit_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task_id
      and private.is_workspace_member(t.workspace_id)
      and (
        t.created_by = auth.uid()
        or t.assignee_id = auth.uid()
        or private.has_workspace_role(t.workspace_id, array['owner', 'admin']::public.workspace_role[])
      )
  );
$$;

revoke execute on function private.can_edit_task(uuid) from public, anon;
grant execute on function private.can_edit_task(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. Projects
-- ---------------------------------------------------------------------------------------------

-- New values are not used elsewhere in this file (Postgres forbids using them in the same
-- transaction that adds them).
alter type public.project_status add value if not exists 'planning' before 'active';
alter type public.project_status add value if not exists 'on_hold' after 'active';
alter type public.project_status add value if not exists 'completed' after 'on_hold';

alter table public.projects
  add column lead_id uuid references public.profiles (id) on delete set null,
  add column start_date date,
  add column due_date date,
  add column version integer not null default 1 check (version >= 1),
  add constraint projects_dates_ordered
    check (start_date is null or due_date is null or start_date <= due_date);

create index projects_lead on public.projects (lead_id) where lead_id is not null;

create trigger projects_version before update on public.projects
  for each row execute function public.bump_version();

-- Owners/admins create projects; the lead must be an active member of the workspace.
alter policy projects_insert on public.projects
  with check (
    private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    and created_by = (select auth.uid())
    and (lead_id is null or private.is_active_member(workspace_id, lead_id))
  );

-- Owners/admins edit any project; a member edits the project they lead (without handing the
-- lead to someone else: only owners/admins reassign it).
alter policy projects_update on public.projects
  using (
    private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    or (lead_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
  )
  with check (
    (
      private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
      or (lead_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
    )
    and (lead_id is null or private.is_active_member(workspace_id, lead_id))
  );

grant insert (id, lead_id, start_date, due_date) on public.projects to authenticated;
grant update (lead_id, start_date, due_date) on public.projects to authenticated;

-- Deleting a project would detach its history; with work attached, archive it instead.
-- SECURITY DEFINER: the check must see every member's time entries, not only the caller's.
create function public.projects_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The workspace itself is being deleted (its projects cascade): nothing to keep.
  if not exists (select 1 from public.workspaces where id = old.workspace_id) then
    return old;
  end if;
  if exists (select 1 from public.tasks where project_id = old.id)
     or exists (select 1 from public.notes where project_id = old.id)
     or exists (select 1 from public.time_entries where project_id = old.id) then
    raise exception 'this project has tasks, notes or tracked time; archive it instead'
      using errcode = '23503';
  end if;
  return old;
end;
$$;

create trigger projects_delete_guard before delete on public.projects
  for each row execute function public.projects_guard_delete();

-- ---------------------------------------------------------------------------------------------
-- 2. Tasks
-- ---------------------------------------------------------------------------------------------

alter table public.tasks
  add column version integer not null default 1 check (version >= 1);

create trigger tasks_version before update on public.tasks
  for each row execute function public.bump_version();

create index tasks_workspace_status on public.tasks (workspace_id, status);

grant insert (id) on public.tasks to authenticated;

create function public.tasks_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.workspaces where id = old.workspace_id) then
    return old;
  end if;
  if exists (select 1 from public.time_entries where task_id = old.id) then
    raise exception 'this task has tracked time; archive it instead' using errcode = '23503';
  end if;
  return old;
end;
$$;

create trigger tasks_delete_guard before delete on public.tasks
  for each row execute function public.tasks_guard_delete();

-- ---------------------------------------------------------------------------------------------
-- 3. Subtasks and comments
-- ---------------------------------------------------------------------------------------------

create table public.task_subtasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  done boolean not null default false,
  position integer not null default 0 check (position >= 0),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (task_id, workspace_id)
    references public.tasks (id, workspace_id) on delete cascade
);

create index task_subtasks_task on public.task_subtasks (task_id, workspace_id, position);
create index task_subtasks_workspace on public.task_subtasks (workspace_id);
create index task_subtasks_created_by on public.task_subtasks (created_by)
  where created_by is not null;

create trigger task_subtasks_updated_at before update on public.task_subtasks
  for each row execute function public.set_updated_at();

create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_id uuid not null,
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set when the body changes after posting (shown as "edited").
  edited_at timestamptz,
  foreign key (task_id, workspace_id)
    references public.tasks (id, workspace_id) on delete cascade
);

create index task_comments_task on public.task_comments (task_id, workspace_id, created_at);
create index task_comments_workspace on public.task_comments (workspace_id);
create index task_comments_author on public.task_comments (author_id);

create function public.task_comments_mark_edited()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

create trigger task_comments_updated_at before update on public.task_comments
  for each row execute function public.set_updated_at();
create trigger task_comments_edited before update on public.task_comments
  for each row execute function public.task_comments_mark_edited();

-- The length limits bound the stored value (7/7): extend the trim trigger to the new tables.
create or replace function public.trim_bounded_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  case tg_table_name
    when 'profiles' then new.display_name := btrim(new.display_name);
    when 'workspaces' then new.name := btrim(new.name);
    when 'projects' then new.name := btrim(new.name);
    when 'tasks' then new.title := btrim(new.title);
    when 'time_entries' then new.application_name := btrim(new.application_name);
    when 'task_subtasks' then new.title := btrim(new.title);
    when 'task_comments' then new.body := btrim(new.body);
  end case;
  return new;
end;
$$;

create trigger task_subtasks_trim before insert or update of title on public.task_subtasks
  for each row execute function public.trim_bounded_text();
create trigger task_comments_trim before insert or update of body on public.task_comments
  for each row execute function public.trim_bounded_text();

alter table public.task_subtasks enable row level security;
alter table public.task_comments enable row level security;

-- Subtasks: members read; whoever may edit the task manages its checklist.
create policy task_subtasks_select on public.task_subtasks for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy task_subtasks_insert on public.task_subtasks for insert to authenticated
  with check (
    private.is_workspace_member(workspace_id)
    and created_by = (select auth.uid())
    and private.can_edit_task(task_id)
  );
create policy task_subtasks_update on public.task_subtasks for update to authenticated
  using (private.can_edit_task(task_id))
  with check (private.can_edit_task(task_id));
create policy task_subtasks_delete on public.task_subtasks for delete to authenticated
  using (private.can_edit_task(task_id));

-- Comments: members read and post as themselves; authors edit their own; authors and
-- owners/admins delete.
create policy task_comments_select on public.task_comments for select to authenticated
  using (private.is_workspace_member(workspace_id));
create policy task_comments_insert on public.task_comments for insert to authenticated
  with check (
    private.is_workspace_member(workspace_id)
    and author_id = (select auth.uid())
  );
create policy task_comments_update on public.task_comments for update to authenticated
  using (author_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
  with check (author_id = (select auth.uid()) and private.is_workspace_member(workspace_id));
create policy task_comments_delete on public.task_comments for delete to authenticated
  using (
    author_id = (select auth.uid()) and private.is_workspace_member(workspace_id)
    or private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
  );

revoke all on public.task_subtasks, public.task_comments from anon, authenticated;
grant select, delete on public.task_subtasks to authenticated;
grant insert (id, workspace_id, task_id, title, done, position, created_by)
  on public.task_subtasks to authenticated;
grant update (title, done, position) on public.task_subtasks to authenticated;
grant select, delete on public.task_comments to authenticated;
grant insert (id, workspace_id, task_id, author_id, body) on public.task_comments to authenticated;
grant update (body) on public.task_comments to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Notes
-- ---------------------------------------------------------------------------------------------

alter table public.notes add column archived_at timestamptz;

-- Private notes: the owner only, as before. Workspace notes: every active member may edit.
alter policy notes_update on public.notes
  using (
    private.is_workspace_member(workspace_id)
    and (owner_id = (select auth.uid()) or visibility = 'workspace')
  )
  with check (
    private.is_workspace_member(workspace_id)
    and (owner_id = (select auth.uid()) or visibility = 'workspace')
  );

-- Sharing, project, pin and archive state belong to the owner. Without this, a teammate could
-- make someone's shared note private (hiding it from the team) or move it to another project.
create function public.notes_guard_owner_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and old.owner_id <> auth.uid()
     and (
       new.visibility is distinct from old.visibility
       or new.project_id is distinct from old.project_id
       or new.pinned is distinct from old.pinned
       or new.archived_at is distinct from old.archived_at
     ) then
    raise exception 'only the note''s owner can change its sharing, project, pin or archive state'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger notes_owner_fields before update on public.notes
  for each row execute function public.notes_guard_owner_fields();

create index notes_workspace_updated on public.notes (workspace_id, updated_at);

grant insert (id) on public.notes to authenticated;
grant update (archived_at) on public.notes to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Time attribution
-- ---------------------------------------------------------------------------------------------

-- A task decides its project: choosing a task sets the entry's project to the task's project.
-- Archived projects and tasks keep the time they have but take no new time.
create function public.time_entries_attribution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_task_project uuid;
  v_task_status public.task_status;
begin
  if new.task_id is not null then
    select t.project_id, t.status into v_task_project, v_task_status
    from public.tasks t
    where t.id = new.task_id and t.workspace_id = new.workspace_id;
    if not found then
      raise exception 'that task is not in this workspace' using errcode = '23503';
    end if;
    new.project_id := v_task_project;
    if (tg_op = 'INSERT' or new.task_id is distinct from old.task_id)
       and v_task_status = 'archived' then
      raise exception 'archived tasks take no new time' using errcode = '22023';
    end if;
  end if;
  if new.project_id is not null
     and (tg_op = 'INSERT' or new.project_id is distinct from old.project_id)
     and exists (
       select 1 from public.projects p where p.id = new.project_id and p.status = 'archived'
     ) then
    raise exception 'archived projects take no new time' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger time_entries_attribution before insert or update of project_id, task_id
  on public.time_entries
  for each row execute function public.time_entries_attribution();

-- Only the attribution columns are writable, and only on your own entries while a member.
create policy time_entries_update on public.time_entries for update to authenticated
  using (user_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and private.is_workspace_member(workspace_id));
grant update (project_id, task_id) on public.time_entries to authenticated;

-- Attribute several of the caller's entries at once (pass neither target to clear). Entries
-- outside the project's or task's workspace are left alone. Returns the number changed.
create function public.set_time_entry_attribution(
  p_entry_ids uuid[],
  p_project_id uuid default null,
  p_task_id uuid default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'sign in to attribute time' using errcode = '28000';
  end if;
  if coalesce(cardinality(p_entry_ids), 0) > 1000 then
    raise exception 'at most 1000 entries per call' using errcode = '54000';
  end if;
  if p_task_id is not null then
    select workspace_id into v_workspace_id from public.tasks where id = p_task_id;
  elsif p_project_id is not null then
    select workspace_id into v_workspace_id from public.projects where id = p_project_id;
  end if;
  if (p_task_id is not null or p_project_id is not null) and v_workspace_id is null then
    raise exception 'project or task not found' using errcode = 'P0002';
  end if;
  update public.time_entries t
  set project_id = p_project_id, task_id = p_task_id
  where t.id = any (p_entry_ids)
    and t.user_id = auth.uid()
    and (v_workspace_id is null or t.workspace_id = v_workspace_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges for the new functions
-- ---------------------------------------------------------------------------------------------

revoke execute on function
  public.bump_version(),
  public.projects_guard_delete(),
  public.tasks_guard_delete(),
  public.task_comments_mark_edited(),
  public.notes_guard_owner_fields(),
  public.time_entries_attribution()
from public, anon, authenticated;

revoke execute on function public.set_time_entry_attribution(uuid[], uuid, uuid) from public, anon;
grant execute on function public.set_time_entry_attribution(uuid[], uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. Realtime (Supabase only; Realtime applies each subscriber's RLS)
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime
      add table public.projects, public.tasks, public.task_subtasks, public.task_comments,
        public.notes;
  end if;
end;
$$;
