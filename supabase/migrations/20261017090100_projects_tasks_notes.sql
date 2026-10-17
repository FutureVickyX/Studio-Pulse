-- Studio Pulse Phase 2A — 2/3: workspace-owned projects, tasks and notes.
--
-- The tables and policies exist now so Phase 2B can build the shared UI on a reviewed
-- foundation. Same-workspace integrity is structural: a task can only reference a project of
-- its own workspace through the composite foreign key (project_id, workspace_id), and
-- workspace_id can never change after insert.

create type public.project_status as enum ('active', 'archived');
create type public.task_status as enum ('inbox', 'todo', 'in_progress', 'in_review', 'done', 'archived');
create type public.task_priority as enum ('low', 'normal', 'high', 'urgent');
create type public.note_visibility as enum ('private', 'workspace');

-- ---------------------------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 4000),
  status public.project_status not null default 'active',
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);

create index projects_workspace on public.projects (workspace_id);

create trigger projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();
create trigger projects_workspace_fixed before update on public.projects
  for each row execute function public.prevent_workspace_change();

-- ---------------------------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text not null default '' check (char_length(description) <= 10000),
  status public.task_status not null default 'inbox',
  priority public.task_priority not null default 'normal',
  assignee_id uuid references public.profiles (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  due_date date,
  start_date date,
  estimated_minutes integer check (estimated_minutes between 1 and 100000),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete set null (project_id),
  check (start_date is null or due_date is null or start_date <= due_date)
);

create index tasks_workspace on public.tasks (workspace_id);
create index tasks_project on public.tasks (project_id) where project_id is not null;
create index tasks_assignee on public.tasks (assignee_id) where assignee_id is not null;

-- completed_at follows the status: set when a task becomes done, cleared when it leaves done.
create function public.tasks_track_completion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.completed_at := coalesce(new.completed_at, now());
  elsif new.status <> 'done' then
    new.completed_at := null;
  end if;
  return new;
end;
$$;

create trigger tasks_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();
create trigger tasks_workspace_fixed before update on public.tasks
  for each row execute function public.prevent_workspace_change();
create trigger tasks_completion before insert or update on public.tasks
  for each row execute function public.tasks_track_completion();

-- ---------------------------------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------------------------------

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  project_id uuid,
  title text not null default '' check (char_length(title) <= 200),
  body text not null default '' check (octet_length(body) <= 1000000),
  -- 'private' notes are visible to their owner only; 'workspace' notes to every member.
  visibility public.note_visibility not null default 'private',
  pinned boolean not null default false,
  -- Optimistic concurrency: every update increments version. Clients update
  -- `where id = $1 and version = $expected` and treat 0 rows as a conflict to surface, never
  -- silently overwriting a teammate's edit.
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete set null (project_id)
);

create index notes_workspace on public.notes (workspace_id);
create index notes_owner on public.notes (owner_id);

create function public.notes_bump_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

-- An owner can never be changed (that would let a member reassign someone's private note).
create function public.notes_owner_fixed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger notes_updated_at before update on public.notes
  for each row execute function public.set_updated_at();
create trigger notes_workspace_fixed before update on public.notes
  for each row execute function public.prevent_workspace_change();
create trigger notes_version before update on public.notes
  for each row execute function public.notes_bump_version();
create trigger notes_owner before update on public.notes
  for each row execute function public.notes_owner_fixed();

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.notes enable row level security;

-- projects: members read; owners/admins create, edit and delete.
create policy projects_select on public.projects for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy projects_insert on public.projects for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    and created_by = auth.uid()
  );
create policy projects_update on public.projects for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy projects_delete on public.projects for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- tasks: members read and create (as themselves, assigning only active members). The creator,
-- the assignee, or an owner/admin may edit; the creator or an owner/admin may delete.
create policy tasks_select on public.tasks for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and created_by = auth.uid()
    and (assignee_id is null or public.is_active_member(workspace_id, assignee_id))
  );
create policy tasks_update on public.tasks for update to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (
      created_by = auth.uid()
      or assignee_id = auth.uid()
      or public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    )
  )
  with check (
    public.is_workspace_member(workspace_id)
    and (assignee_id is null or public.is_active_member(workspace_id, assignee_id))
  );
create policy tasks_delete on public.tasks for delete to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (
      created_by = auth.uid()
      or public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    )
  );

-- notes: private notes are owner-only; workspace notes are readable by members. Only the owner
-- edits a note (collaborative editing arrives with Phase 2B); the owner or an owner/admin may
-- delete a workspace note.
create policy notes_select on public.notes for select to authenticated
  using (
    owner_id = auth.uid() and public.is_workspace_member(workspace_id)
    or (visibility = 'workspace' and public.is_workspace_member(workspace_id))
  );
create policy notes_insert on public.notes for insert to authenticated
  with check (owner_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy notes_update on public.notes for update to authenticated
  using (owner_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (owner_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy notes_delete on public.notes for delete to authenticated
  using (
    owner_id = auth.uid() and public.is_workspace_member(workspace_id)
    or (
      visibility = 'workspace'
      and public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    )
  );

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on public.projects, public.tasks, public.notes from anon, authenticated;

grant select, delete on public.projects to authenticated;
grant insert (workspace_id, name, description, status, created_by) on public.projects to authenticated;
grant update (name, description, status) on public.projects to authenticated;

grant select, delete on public.tasks to authenticated;
grant insert (workspace_id, project_id, title, description, status, priority, assignee_id,
  created_by, due_date, start_date, estimated_minutes) on public.tasks to authenticated;
grant update (project_id, title, description, status, priority, assignee_id, due_date,
  start_date, estimated_minutes) on public.tasks to authenticated;

grant select, delete on public.notes to authenticated;
grant insert (workspace_id, owner_id, project_id, title, body, visibility, pinned)
  on public.notes to authenticated;
grant update (project_id, title, body, visibility, pinned) on public.notes to authenticated;

revoke execute on function
  public.tasks_track_completion(),
  public.notes_bump_version(),
  public.notes_owner_fixed()
from public, anon, authenticated;
