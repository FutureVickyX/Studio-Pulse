-- Studio Pulse Phase 2A — 7/7: the length limits bound what is actually stored.
--
-- Names and titles are checked with `char_length(btrim(col)) between 1 and N`, but the raw value
-- was stored. One visible character followed by any number of spaces passed the check, so any
-- member could store (and push to every teammate who reads the row) arbitrarily large values:
-- profiles.display_name, workspaces.name, projects.name, tasks.title, and
-- time_entries.application_name through sync_time_entries. Only create_workspace trimmed.
--
-- A BEFORE trigger now trims those columns, so the existing checks bound the stored value.
-- Leading and trailing spaces never carried meaning in these fields. Invitation emails also get
-- an upper bound (RFC 5321's 320 characters).
-- Test: text-bounds.test.ts.

create function public.trim_bounded_text()
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
  end case;
  return new;
end;
$$;

create trigger profiles_trim before insert or update of display_name on public.profiles
  for each row execute function public.trim_bounded_text();
create trigger workspaces_trim before insert or update of name on public.workspaces
  for each row execute function public.trim_bounded_text();
create trigger projects_trim before insert or update of name on public.projects
  for each row execute function public.trim_bounded_text();
create trigger tasks_trim before insert or update of title on public.tasks
  for each row execute function public.trim_bounded_text();
create trigger time_entries_trim before insert on public.time_entries
  for each row execute function public.trim_bounded_text();

alter table public.workspace_invitations
  add constraint workspace_invitations_email_length check (char_length(email) <= 320);

revoke execute on function public.trim_bounded_text() from public, anon, authenticated;
