-- Studio Pulse Phase 2B — 9: fixes from the Phase 2B review. Additive: no table or data is
-- replaced, and no access is widened.
--  1. A project's lead and a task's assignee are checked when they change, not on every update.
--     Before, once a lead or assignee left the workspace, nobody (owners included) could archive,
--     restore or edit that project or task without first changing the lead/assignee, because
--     every new row had to name an active member. A new lead or assignee must still be an active
--     member; inserts are still checked by their policies.
--  2. Moving a task to another project moves its tracked time with it, so "a task decides its
--     project" keeps holding for time entries. Moving a timed task into an archived project is
--     refused like any other new time on an archived project.
-- Tests: tests/integration/supabase/collaboration.test.ts ("former members" and "moving a task").

-- ---------------------------------------------------------------------------------------------
-- 1. Leads and assignees are validated when they change
-- ---------------------------------------------------------------------------------------------

-- Same rule as before for who may update; the lead's membership moves to the trigger below.
alter policy projects_update on public.projects
  using (
    private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    or (lead_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
  )
  with check (
    private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    or (lead_id = (select auth.uid()) and private.is_workspace_member(workspace_id))
  );

create function public.projects_check_lead()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.lead_id is not null
     and new.lead_id is distinct from old.lead_id
     and not private.is_active_member(new.workspace_id, new.lead_id) then
    raise exception 'the lead must be an active member of this workspace' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- UPDATE OF fires whenever lead_id is in the SET list, so the function compares old and new.
create trigger projects_check_lead before update of lead_id on public.projects
  for each row execute function public.projects_check_lead();

alter policy tasks_update on public.tasks
  using (
    private.is_workspace_member(workspace_id)
    and (
      created_by = (select auth.uid())
      or assignee_id = (select auth.uid())
      or private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    )
  )
  with check (private.is_workspace_member(workspace_id));

create function public.tasks_check_assignee()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.assignee_id is not null
     and new.assignee_id is distinct from old.assignee_id
     and not private.is_active_member(new.workspace_id, new.assignee_id) then
    raise exception 'the assignee must be an active member of this workspace' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger tasks_check_assignee before update of assignee_id on public.tasks
  for each row execute function public.tasks_check_assignee();

-- ---------------------------------------------------------------------------------------------
-- 2. Time follows its task
-- ---------------------------------------------------------------------------------------------

-- SECURITY DEFINER: the task's time belongs to whoever tracked it, not only to the caller. The
-- time_entries_attribution trigger still runs for each row (it takes the project from the task
-- and refuses archived projects), so a refused row rolls back the whole move.
create function public.tasks_move_time()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id then
    update public.time_entries
    set project_id = new.project_id
    where task_id = new.id
      and project_id is distinct from new.project_id;
  end if;
  return null;
end;
$$;

create trigger tasks_move_time after update of project_id on public.tasks
  for each row execute function public.tasks_move_time();

revoke execute on function
  public.projects_check_lead(),
  public.tasks_check_assignee(),
  public.tasks_move_time()
from public, anon, authenticated;
