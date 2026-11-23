-- Phase 3B: in-app delivery, recipient-owned preferences and a trusted transactional outbox.
-- No scheduler is enabled by this migration. See docs/automation.md for explicit deployment.

create table public.notification_preferences (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(workspace_id,user_id)
);
create table public.workspace_automation_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  enabled boolean not null default true,
  events_enabled boolean not null default true,
  reminders_enabled boolean not null default true,
  digests_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
create table private.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  occurrence_key text not null unique check(length(occurrence_key)<=500),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  kind text not null check(kind in ('assigned','review','completed','due_soon','due_today','overdue','awaiting_review','inactive','daily','weekly')),
  payload jsonb not null default '{}',
  state text not null default 'pending' check(state in ('pending','processing','retry','completed','skipped','failed')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  run_after timestamptz not null default now(),
  claim_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz,
  last_error text check(last_error in ('delivery_failed','reporting_failed','network','invalid_data','interrupted'))
);
create index automation_jobs_ready on private.automation_jobs(run_after,id) where state in ('pending','retry');
create index automation_jobs_leases on private.automation_jobs(lease_until) where state='processing';
create index automation_jobs_workspace on private.automation_jobs(workspace_id,created_at desc);
create table private.automation_attempts (
  job_id uuid not null references private.automation_jobs(id) on delete cascade,
  attempt integer not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text not null default 'processing',
  error_code text,
  primary key(job_id,attempt)
);
-- Only a hash is stored here. The raw, narrowly scoped invocation credential lives in Vault.
create table private.automation_worker_keys (
  key_hash bytea primary key check(octet_length(key_hash)=32),
  created_at timestamptz not null default now()
);
create table private.task_automation_state (
  task_id uuid primary key references public.tasks(id) on delete cascade,
  assignment_version integer not null,
  review_version integer not null,
  deadline_version integer not null,
  review_started_at timestamptz not null,
  last_activity_at timestamptz not null
);
insert into private.task_automation_state
select id,version,version,version,updated_at,updated_at from public.tasks;

create table private.automation_schedules (
  workspace_id uuid not null,
  user_id uuid not null,
  next_scan_at timestamptz not null default now(),
  task_cursor uuid,
  primary key(workspace_id,user_id),
  foreign key(workspace_id,user_id) references public.workspace_members(workspace_id,user_id) on delete cascade
);
create index automation_schedules_due on private.automation_schedules(next_scan_at,workspace_id,user_id);
insert into private.automation_schedules(workspace_id,user_id)
select workspace_id,user_id from public.workspace_members where status='active';

create table public.notifications (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check(kind in ('assigned','review','completed','due_soon','due_today','overdue','awaiting_review','inactive','daily','weekly')),
  title text not null check(length(title)<=200),
  task_id uuid references public.tasks(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_inbox on public.notifications(recipient_id,workspace_id,created_at desc,id);
create index notifications_unread on public.notifications(recipient_id,workspace_id) where read_at is null;
create index notifications_task on public.notifications(task_id) where task_id is not null;
create index notifications_project on public.notifications(project_id) where project_id is not null;
create index notifications_workspace on public.notifications(workspace_id);
create index notification_preferences_user on public.notification_preferences(user_id);
create index automation_jobs_task on private.automation_jobs(task_id) where task_id is not null;
create index automation_jobs_recipient on private.automation_jobs(recipient_id);

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.workspace_automation_settings enable row level security;
alter table private.automation_jobs enable row level security;
alter table private.automation_attempts enable row level security;
alter table private.task_automation_state enable row level security;
alter table private.automation_schedules enable row level security;
alter table private.automation_worker_keys enable row level security;

create policy notifications_select on public.notifications for select to authenticated
using(recipient_id=(select auth.uid()) and private.is_workspace_member(workspace_id));
create policy notifications_read on public.notifications for update to authenticated
using(recipient_id=(select auth.uid()) and private.is_workspace_member(workspace_id))
with check(recipient_id=(select auth.uid()) and private.is_workspace_member(workspace_id));
create policy preferences_select on public.notification_preferences for select to authenticated
using(user_id=(select auth.uid()) and private.is_workspace_member(workspace_id));
create policy preferences_insert on public.notification_preferences for insert to authenticated
with check(user_id=(select auth.uid()) and private.is_workspace_member(workspace_id));
create policy preferences_update on public.notification_preferences for update to authenticated
using(user_id=(select auth.uid()) and private.is_workspace_member(workspace_id))
with check(user_id=(select auth.uid()) and private.is_workspace_member(workspace_id));
create policy automation_settings_select on public.workspace_automation_settings for select to authenticated
using(private.is_workspace_member(workspace_id));
create policy automation_settings_insert on public.workspace_automation_settings for insert to authenticated
with check(private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]));
create policy automation_settings_update on public.workspace_automation_settings for update to authenticated
using(private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]))
with check(private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]));

revoke all on public.notifications,public.notification_preferences,public.workspace_automation_settings from public,anon,authenticated;
grant select on public.notifications,public.notification_preferences,public.workspace_automation_settings to authenticated;
grant update(read_at) on public.notifications to authenticated;
grant insert(workspace_id,user_id,config),update(config) on public.notification_preferences to authenticated;
grant insert(workspace_id,enabled,events_enabled,reminders_enabled,digests_enabled),update(enabled,events_enabled,reminders_enabled,digests_enabled)
on public.workspace_automation_settings to authenticated;
grant all on public.notifications,public.notification_preferences,public.workspace_automation_settings to service_role;
revoke all on private.automation_jobs,private.automation_attempts,private.task_automation_state,private.automation_schedules from public,anon,authenticated;
revoke all on private.automation_worker_keys from public,anon,authenticated;

create function public.authorize_automation_worker(p_credential text) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(p_credential ~ '^[0-9a-f]{64}$' and exists(
   select 1 from private.automation_worker_keys where key_hash=sha256(convert_to(p_credential,'UTF8'))
 ),false)
$$;
revoke execute on function public.authorize_automation_worker(text) from public,anon,authenticated;
grant execute on function public.authorize_automation_worker(text) to service_role;

create function private.automation_defaults() returns jsonb language sql immutable set search_path='' as $$
 select '{"assignment":true,"deadlines":true,"review":true,"completion":false,"daily":false,"weekly":false,"inactive":false,
 "timezone":"UTC","dueSoonDays":1,"reminderHour":9,"overdueEveryDays":1,"reviewAfterDays":2,"inactiveAfterDays":7,
 "dailyHour":17,"weeklyHour":9,"weeklyDay":1,"quietStart":22,"quietEnd":7}'::jsonb
$$;
create function private.automation_config(p_workspace uuid,p_user uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select private.automation_defaults() || coalesce((select config from public.notification_preferences where workspace_id=p_workspace and user_id=p_user),'{}'::jsonb)
$$;
create function private.validate_automation_preferences() returns trigger
language plpgsql security definer set search_path='' as $$
declare k text; v jsonb; hi integer;
begin
 if current_setting('role',true)='authenticated' and
   (new.user_id is distinct from auth.uid() or not private.is_workspace_member(new.workspace_id)) then
   raise exception 'Preferences require your own active membership' using errcode='42501';
 end if;
 if jsonb_typeof(new.config) <> 'object' or octet_length(new.config::text)>4000 then
   raise exception 'Invalid notification preferences' using errcode='22023';
 end if;
 for k,v in select * from jsonb_each(new.config) loop
   if not (private.automation_defaults() ? k) then raise exception 'Unknown preference' using errcode='22023'; end if;
   if k in ('assignment','deadlines','review','completion','daily','weekly','inactive') then
     if jsonb_typeof(v)<>'boolean' then raise exception 'Expected a boolean preference' using errcode='22023'; end if;
   elsif k='timezone' then
     if jsonb_typeof(v)<>'string' or (v#>>'{}') !~ '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+)+)$'
       or not exists(select 1 from pg_catalog.pg_timezone_names where name=v#>>'{}') then
       raise exception 'Choose a valid time zone' using errcode='22023';
     end if;
   else
     hi:=case when k='dueSoonDays' then 14 when k in ('overdueEveryDays','reviewAfterDays','inactiveAfterDays') then 30 when k='weeklyDay' then 7 else 23 end;
     if jsonb_typeof(v)<>'number' or (v#>>'{}')::numeric<>trunc((v#>>'{}')::numeric)
       or (v#>>'{}')::numeric < (case when k in ('dueSoonDays','overdueEveryDays','reviewAfterDays','inactiveAfterDays','weeklyDay') then 1 else 0 end)
       or (v#>>'{}')::numeric>hi then raise exception 'Preference is outside its allowed range' using errcode='22023'; end if;
   end if;
 end loop;
 new.config:=private.automation_defaults()||new.config;
 new.updated_at:=now();
 insert into private.automation_schedules(workspace_id,user_id,next_scan_at) values(new.workspace_id,new.user_id,now())
 on conflict(workspace_id,user_id) do update set next_scan_at=excluded.next_scan_at,task_cursor=null;
 return new;
end; $$;
create trigger notification_preferences_validate before insert or update on public.notification_preferences
for each row execute function private.validate_automation_preferences();
create trigger automation_settings_updated before update on public.workspace_automation_settings
for each row execute function public.set_updated_at();

create function private.automation_delivery_at(p_time timestamptz,p_config jsonb) returns timestamptz
language plpgsql stable set search_path='' as $$
declare local_time timestamp; h integer; s integer; e integer; d date;
begin
 local_time:=p_time at time zone (p_config->>'timezone'); h:=extract(hour from local_time);
 s:=(p_config->>'quietStart')::integer; e:=(p_config->>'quietEnd')::integer;
 if s=e or (s<e and (h<s or h>=e)) or (s>e and h>=e and h<s) then return p_time; end if;
 d:=local_time::date;
 if s>e and h>=s then d:=d+1; end if;
 return (d::timestamp + make_interval(hours=>e)) at time zone (p_config->>'timezone');
end; $$;

create function private.enqueue_automation(p_workspace uuid,p_user uuid,p_task uuid,p_kind text,p_key text,p_payload jsonb,p_after timestamptz)
returns void language sql security definer set search_path='' as $$
 insert into private.automation_jobs(workspace_id,recipient_id,task_id,kind,occurrence_key,payload,run_after)
 select p_workspace,p_user,p_task,p_kind,p_key,p_payload,p_after
 where p_user is not null and exists(select 1 from public.workspace_members
   where workspace_id=p_workspace and user_id=p_user and status='active')
 on conflict(occurrence_key) do nothing
$$;
create function private.task_automation_events() returns trigger
language plpgsql security definer set search_path='' as $$
declare lead_user uuid; assignment_changed boolean; status_changed boolean; deadline_changed boolean;
begin
 assignment_changed:=tg_op='INSERT'; status_changed:=tg_op='INSERT'; deadline_changed:=tg_op='INSERT';
 if tg_op='UPDATE' then
   assignment_changed:=new.assignee_id is distinct from old.assignee_id;
   status_changed:=new.status is distinct from old.status;
   deadline_changed:=new.due_date is distinct from old.due_date or assignment_changed
     or new.project_id is distinct from old.project_id
     or (status_changed and (new.status in ('done','archived') or old.status in ('done','archived')));
 end if;
 insert into private.task_automation_state values(new.id,new.version,new.version,new.version,now(),now())
 on conflict(task_id) do update set
 assignment_version=case when assignment_changed then new.version else private.task_automation_state.assignment_version end,
 review_version=case when status_changed then new.version else private.task_automation_state.review_version end,
 deadline_version=case when deadline_changed then new.version else private.task_automation_state.deadline_version end,
 review_started_at=case when status_changed then now() else private.task_automation_state.review_started_at end,
 last_activity_at=now();
 if new.project_id is not null then select lead_id into lead_user from public.projects where id=new.project_id; end if;
 if assignment_changed and new.assignee_id is not null and new.assignee_id is distinct from auth.uid() then
   perform private.enqueue_automation(new.workspace_id,new.assignee_id,new.id,'assigned',new.id||':assigned:'||new.version,
     jsonb_build_object('generation',new.version),now());
 end if;
 if status_changed and new.status='in_review' and lead_user is distinct from auth.uid() then
   perform private.enqueue_automation(new.workspace_id,lead_user,new.id,'review',new.id||':review:'||new.version,
     jsonb_build_object('generation',new.version),now());
 end if;
 if status_changed and new.status='done' and new.created_by is distinct from auth.uid() then
   perform private.enqueue_automation(new.workspace_id,new.created_by,new.id,'completed',new.id||':completed:'||new.version,
     jsonb_build_object('generation',new.version),now());
 end if;
 return null;
end; $$;
create trigger tasks_automation after insert or update on public.tasks for each row execute function private.task_automation_events();

create function private.automation_membership_schedule() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status='active' then
   insert into private.automation_schedules(workspace_id,user_id) values(new.workspace_id,new.user_id)
   on conflict(workspace_id,user_id) do update set next_scan_at=now(),task_cursor=null;
 else
   delete from private.automation_schedules where workspace_id=new.workspace_id and user_id=new.user_id;
 end if;
 return null;
end; $$;
create trigger membership_automation after insert or update of status on public.workspace_members
for each row execute function private.automation_membership_schedule();

create function public.claim_automation_jobs(p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.automation_jobs; expired private.automation_jobs; result jsonb:='[]'; token uuid;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Batch size must be 1-100' using errcode='22023'; end if;
 for expired in select * from private.automation_jobs where state='processing' and lease_until<=now()
 order by lease_until,id for update skip locked limit p_limit loop
   update private.automation_attempts set ended_at=now(),outcome='interrupted',error_code='interrupted'
     where job_id=expired.id and attempt=expired.attempts;
   update private.automation_jobs set state=case when attempts>=5 then 'failed' else 'retry' end,
     run_after=now(),claim_token=null,lease_until=null,last_error='interrupted',failed_at=case when attempts>=5 then now() else null end
     where id=expired.id;
 end loop;
 for j in select * from private.automation_jobs where state in ('pending','retry') and run_after<=now()
 order by run_after,id for update skip locked limit p_limit loop
   token:=gen_random_uuid();
   update private.automation_jobs set state='processing',attempts=attempts+1,claim_token=token,lease_until=now()+interval '5 minutes' where id=j.id;
   insert into private.automation_attempts(job_id,attempt) values(j.id,j.attempts+1);
   result:=result||jsonb_build_array(jsonb_build_object('id',j.id,'claim_token',token,'kind',j.kind,'recipient_id',j.recipient_id,
     'workspace_id',j.workspace_id,'task_id',j.task_id,'payload',j.payload));
 end loop;
 return result;
end; $$;

create function public.finish_automation_job(p_id uuid,p_token uuid,p_summary jsonb default null) returns text
language plpgsql security definer set search_path='' as $$
declare j private.automation_jobs; t public.tasks; s private.task_automation_state; cfg jsonb; ws public.workspace_automation_settings;
 project public.projects; result text:='completed'; next_delivery timestamptz; preference text; local_day date;
begin
 select * into j from private.automation_jobs where id=p_id for update;
 if not found then raise exception 'Job not found' using errcode='P0002'; end if;
 if j.state in ('completed','skipped') then return j.state; end if;
 if j.state<>'processing' or j.claim_token is distinct from p_token or j.lease_until<=now() then
   raise exception 'Job claim expired' using errcode='40001';
 end if;
 -- Lock membership until delivery commits: removal cannot race the authorization check.
 perform 1 from public.workspace_members where workspace_id=j.workspace_id and user_id=j.recipient_id and status='active' for share;
 if not found then result:='skipped'; end if;
 cfg:=private.automation_config(j.workspace_id,j.recipient_id);
 local_day:=(now() at time zone (cfg->>'timezone'))::date;
 if j.kind in ('due_soon','due_today','overdue','awaiting_review','inactive','daily','weekly')
   and j.payload->>'timezone' is distinct from cfg->>'timezone' then result:='skipped'; end if;
 select * into ws from public.workspace_automation_settings where workspace_id=j.workspace_id;
 preference:=case when j.kind='assigned' then 'assignment' when j.kind in ('due_soon','due_today','overdue') then 'deadlines'
   when j.kind in ('review','awaiting_review') then 'review' when j.kind='completed' then 'completion' else j.kind end;
 if not (cfg->>preference)::boolean or ws.enabled=false
   or (j.kind in ('assigned','review','completed') and ws.events_enabled=false)
   or (j.kind in ('due_soon','due_today','overdue','awaiting_review','inactive') and ws.reminders_enabled=false)
   or (j.kind in ('daily','weekly') and ws.digests_enabled=false) then result:='skipped'; end if;
 if j.task_id is not null then
   select * into t from public.tasks where id=j.task_id and workspace_id=j.workspace_id for share;
   if not found then result:='skipped'; else
     select * into s from private.task_automation_state where task_id=t.id;
     if t.project_id is not null then select * into project from public.projects where id=t.project_id; end if;
     if t.status='archived' or project.status='archived' or (t.status='done' and j.kind<>'completed') then result:='skipped'; end if;
     if j.kind='assigned' and (t.assignee_id is distinct from j.recipient_id or s.assignment_version<>(j.payload->>'generation')::integer) then result:='skipped'; end if;
     if j.kind in ('review','awaiting_review') and (t.status<>'in_review' or project.lead_id is distinct from j.recipient_id or s.review_version<>(j.payload->>'generation')::integer) then result:='skipped'; end if;
     if j.kind='completed' and (t.status<>'done' or t.created_by is distinct from j.recipient_id or s.review_version<>(j.payload->>'generation')::integer) then result:='skipped'; end if;
     if j.kind in ('due_soon','due_today','overdue') and (t.assignee_id is distinct from j.recipient_id or s.deadline_version<>(j.payload->>'generation')::integer) then result:='skipped'; end if;
     if (j.kind='due_soon' and (t.due_date is null or t.due_date<=local_day))
       or (j.kind='due_today' and t.due_date is distinct from local_day)
       or (j.kind='overdue' and (t.due_date is null or t.due_date>=local_day or j.payload->>'localDate'<>local_day::text)) then result:='skipped'; end if;
     if j.kind='inactive' and (t.assignee_id is distinct from j.recipient_id or s.last_activity_at::text is distinct from j.payload->>'lastActivity') then result:='skipped'; end if;
   end if;
 end if;
 if result<>'skipped' then
   next_delivery:=private.automation_delivery_at(now(),cfg);
   if next_delivery>now() then
     update private.automation_jobs set state='retry',run_after=next_delivery,claim_token=null,lease_until=null,attempts=attempts-1 where id=j.id;
     delete from private.automation_attempts where job_id=j.id and attempt=j.attempts;
     return 'deferred';
   end if;
   if j.kind in ('daily','weekly') and (p_summary is null or jsonb_typeof(p_summary)<>'object' or octet_length(p_summary::text)>100000) then
     raise exception 'A generated summary is required' using errcode='22023';
   end if;
   insert into public.notifications(id,workspace_id,recipient_id,kind,title,task_id,project_id,payload)
   values(j.id,j.workspace_id,j.recipient_id,j.kind,left(coalesce(t.title,case when j.kind='daily' then 'Daily summary' else 'Weekly summary' end),200),
     t.id,t.project_id,case when j.kind in ('daily','weekly') then p_summary else jsonb_build_object('projectName',project.name) end)
   on conflict(id) do nothing;
 end if;
 update private.automation_jobs set state=result,completed_at=now(),claim_token=null,lease_until=null,last_error=null where id=j.id;
 update private.automation_attempts set ended_at=now(),outcome=result where job_id=j.id and attempt=j.attempts;
 return result;
end; $$;

create function public.fail_automation_job(p_id uuid,p_token uuid,p_code text) returns void
language plpgsql security definer set search_path='' as $$
declare j private.automation_jobs;
begin
 if p_code is null or p_code not in ('delivery_failed','reporting_failed','network','invalid_data') then raise exception 'Invalid error code' using errcode='22023'; end if;
 select * into j from private.automation_jobs where id=p_id for update;
 if not found or j.state<>'processing' or j.claim_token is distinct from p_token or j.lease_until<=now() then
   raise exception 'Job claim expired' using errcode='40001';
 end if;
 update private.automation_jobs set state=case when attempts>=5 then 'failed' else 'retry' end,
 run_after=now()+make_interval(secs=>least(3600,60*power(2,attempts-1)::integer)),
 failed_at=case when attempts>=5 then now() else null end,last_error=p_code,claim_token=null,lease_until=null where id=j.id;
 update private.automation_attempts set ended_at=now(),outcome='failed',error_code=p_code where job_id=j.id and attempt=j.attempts;
end; $$;

create function public.automation_outcomes(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not private.has_workspace_role(p_workspace_id,array['owner','admin']::public.workspace_role[]) then
   raise exception 'Workspace administrator required' using errcode='42501';
 end if;
 return coalesce((select jsonb_agg(x) from (select id,kind,state,attempts,created_at,run_after,completed_at,failed_at,last_error
 from private.automation_jobs where workspace_id=p_workspace_id order by created_at desc,id limit 100)x),'[]'::jsonb);
end; $$;

revoke execute on function public.claim_automation_jobs(integer),public.finish_automation_job(uuid,uuid,jsonb),public.fail_automation_job(uuid,uuid,text),public.automation_outcomes(uuid)
from public,anon,authenticated;
grant execute on function public.claim_automation_jobs(integer),public.finish_automation_job(uuid,uuid,jsonb),public.fail_automation_job(uuid,uuid,text) to service_role;
grant execute on function public.automation_outcomes(uuid) to authenticated;
revoke execute on function private.automation_defaults(),private.automation_config(uuid,uuid),private.validate_automation_preferences(),
private.automation_delivery_at(timestamptz,jsonb),private.enqueue_automation(uuid,uuid,uuid,text,text,jsonb,timestamptz),
private.task_automation_events(),private.automation_membership_schedule() from public,anon,authenticated;
