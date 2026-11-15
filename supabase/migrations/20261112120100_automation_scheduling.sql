-- Date-only deadlines are evaluated on the recipient's calendar, not as midnight UTC.
-- This planner only enqueues bounded work. It does not install a cron job or call a desktop.
create function private.plan_automation(p_now timestamptz,p_limit integer) returns integer
language plpgsql security definer set search_path='' as $$
declare m record; t record; cfg jsonb; ws public.workspace_automation_settings;
 local_now timestamp; local_day date; kind text; days integer; count_scanned integer:=0; payload jsonb;
 generation integer; key text; tasks_seen integer; last_task uuid;
begin
 if p_limit is null or p_limit not between 1 and 500 then raise exception 'Batch size must be 1-500' using errcode='22023'; end if;
 for m in select a.* from private.automation_schedules a join public.workspace_members b using(workspace_id,user_id)
   where b.status='active' and a.next_scan_at<=p_now order by a.next_scan_at,a.workspace_id,a.user_id
   for update of a skip locked limit p_limit loop
   cfg:=private.automation_config(m.workspace_id,m.user_id);
   select * into ws from public.workspace_automation_settings where workspace_id=m.workspace_id;
   local_now:=p_now at time zone (cfg->>'timezone'); local_day:=local_now::date;
   tasks_seen:=0; last_task:=null;
   if ws.enabled is distinct from false and ws.reminders_enabled is distinct from false
     and extract(hour from local_now)>=(cfg->>'reminderHour')::integer then
     for t in select q.*,s.deadline_version,s.review_version,s.review_started_at,s.last_activity_at,p.lead_id
       from public.tasks q join private.task_automation_state s on s.task_id=q.id
       left join public.projects p on p.id=q.project_id
       where q.workspace_id=m.workspace_id and q.status not in ('done','archived')
         and p.status is distinct from 'archived'
         and (q.assignee_id=m.user_id or (q.status='in_review' and p.lead_id=m.user_id))
         and (m.task_cursor is null or q.id>m.task_cursor) order by q.id limit 1000 loop
       tasks_seen:=tasks_seen+1; last_task:=t.id;
       kind:=null; generation:=t.deadline_version;
       if t.assignee_id=m.user_id and (cfg->>'deadlines')::boolean and t.due_date is not null then
         days:=t.due_date-local_day;
         if days=(cfg->>'dueSoonDays')::integer then kind:='due_soon';
         elsif days=0 then kind:='due_today';
         elsif days<0 and ((-days-1) % (cfg->>'overdueEveryDays')::integer)=0 then kind:='overdue'; end if;
         if kind is not null then
           key:=t.id||':'||m.user_id||':'||kind||':'||generation||':'||local_day;
           perform private.enqueue_automation(m.workspace_id,m.user_id,t.id,kind,key,
             jsonb_build_object('generation',generation,'localDate',local_day,'timezone',cfg->>'timezone'),
             private.automation_delivery_at(p_now,cfg));
         end if;
       end if;
       if t.status='in_review' and t.lead_id=m.user_id and (cfg->>'review')::boolean
         and local_day-(t.review_started_at at time zone (cfg->>'timezone'))::date >= (cfg->>'reviewAfterDays')::integer then
         perform private.enqueue_automation(m.workspace_id,m.user_id,t.id,'awaiting_review',
           t.id||':'||m.user_id||':awaiting_review:'||t.review_version||':'||local_day,
           jsonb_build_object('generation',t.review_version,'localDate',local_day,'timezone',cfg->>'timezone'),
           private.automation_delivery_at(p_now,cfg));
       end if;
       if t.assignee_id=m.user_id and t.status<>'in_review' and (cfg->>'inactive')::boolean then
         days:=local_day-(t.last_activity_at at time zone (cfg->>'timezone'))::date;
         if days>=(cfg->>'inactiveAfterDays')::integer and (days-(cfg->>'inactiveAfterDays')::integer)%7=0 then
           perform private.enqueue_automation(m.workspace_id,m.user_id,t.id,'inactive',
             t.id||':'||m.user_id||':inactive:'||local_day,
             jsonb_build_object('lastActivity',t.last_activity_at::text,'localDate',local_day,'timezone',cfg->>'timezone'),
             private.automation_delivery_at(p_now,cfg));
         end if;
       end if;
     end loop;
   end if;
   if ws.enabled is distinct from false and ws.digests_enabled is distinct from false then
     foreach kind in array array['daily','weekly'] loop
       if (cfg->>kind)::boolean and extract(hour from local_now)>=(cfg->>(kind||'Hour'))::integer
          and (kind='daily' or extract(isodow from local_now)=(cfg->>'weeklyDay')::integer) then
         payload:=jsonb_build_object('timezone',cfg->>'timezone','localDate',local_day);
         perform private.enqueue_automation(m.workspace_id,m.user_id,null,kind,
           m.workspace_id||':'||m.user_id||':'||kind||':'||local_day,payload,private.automation_delivery_at(p_now,cfg));
       end if;
     end loop;
   end if;
   update private.automation_schedules set task_cursor=case when tasks_seen=1000 then last_task else null end,
     next_scan_at=p_now+case when tasks_seen=1000 then interval '1 minute' else interval '15 minutes' end
     where workspace_id=m.workspace_id and user_id=m.user_id;
   count_scanned:=count_scanned+1;
 end loop;
 return count_scanned;
end; $$;

create function public.plan_automation_jobs(p_limit integer default 100) returns integer
language sql security definer set search_path='' as $$ select private.plan_automation(now(),p_limit) $$;
revoke execute on function public.plan_automation_jobs(integer) from public,anon,authenticated;
grant execute on function public.plan_automation_jobs(integer) to service_role;
revoke execute on function private.plan_automation(timestamptz,integer) from public,anon,authenticated;

-- A comment is task activity, without changing the task's version or inventing mentions.
create function private.automation_comment_activity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 update private.task_automation_state set last_activity_at=now() where task_id=new.task_id;
 return null;
end; $$;
create trigger comments_automation after insert on public.task_comments for each row execute function private.automation_comment_activity();
revoke execute on function private.automation_comment_activity() from public,anon,authenticated;

-- A workspace switch takes effect on the next planner tick, without waiting for old cursors.
create function private.automation_settings_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 update private.automation_schedules set next_scan_at=now(),task_cursor=null where workspace_id=new.workspace_id;
 return null;
end; $$;
create trigger automation_settings_schedule after insert or update on public.workspace_automation_settings
for each row execute function private.automation_settings_changed();
revoke execute on function private.automation_settings_changed() from public,anon,authenticated;

-- INSERT/UPDATE delivery events are recipient-filtered by RLS. No DELETE subscription is needed.
do $$ begin
 if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime') then
   alter publication supabase_realtime add table public.notifications;
 end if;
end; $$;
