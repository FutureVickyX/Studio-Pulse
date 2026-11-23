-- Phase 3C integration hardening for Phase 3B automation. Applied migrations are never edited;
-- each function below is redefined in full with `create or replace`, which keeps its owner and grants.
--
-- 1. Preferences are stored canonically: integer settings as JSON integers (a client could save 9.0,
--    which passed validation and then made `::integer` raise 22P02 in the planner), and time zones in
--    their tz-database spelling (Intl accepts 'europe/london'; the old check demanded an exact match).
--    Reads go through private.automation_config, which also coerces any value stored before this
--    migration, so no consumer can hit a non-integral number again. A time-zone change retires
--    pending calendar jobs from the old zone so the new zone's occurrence is not swallowed.
-- 2. The planner isolates each membership: one bad schedule is pushed back an hour and logged by
--    SQLSTATE only, instead of rolling back the batch and stopping planning for every workspace.
-- 3. A reminder hour inside quiet hours is planned at the quiet-hours end on the same local day.
--    Before, the reminder was planned for day D and deferred into D+1, where delivery then skipped it.
-- 4. Claiming ignores rows whose retry budget is spent and tolerates an attempt-log row left by a
--    requeue, so a hand-requeued job can no longer abort every claim batch.
-- 5. Administrator outcome rows no longer reveal members' private preferences: preference skips read
--    as completed, no next-eligible or completion time is returned, and creation is day-level.

-- 1. Canonical preferences ---------------------------------------------------------------------------

create or replace function private.automation_config(p_workspace uuid,p_user uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select private.automation_defaults() || coalesce((
   select jsonb_object_agg(e.key,case when jsonb_typeof(e.value)='number'
     then to_jsonb(trunc((e.value#>>'{}')::numeric)::integer) else e.value end)
   from public.notification_preferences p cross join lateral jsonb_each(p.config) e
   where p.workspace_id=p_workspace and p.user_id=p_user),'{}'::jsonb)
$$;

create or replace function private.validate_automation_preferences() returns trigger
language plpgsql security definer set search_path='' as $$
declare k text; v jsonb; hi integer; zone text; clean jsonb:='{}'::jsonb;
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
     clean:=clean||jsonb_build_object(k,v);
   elsif k='timezone' then
     zone:=null;
     if jsonb_typeof(v)='string' and (v#>>'{}') ~ '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+)+)$' then
       -- An exact match wins; otherwise the one tz-database name that differs only in case.
       select name into zone from pg_catalog.pg_timezone_names where lower(name)=lower(v#>>'{}')
       order by name=(v#>>'{}') desc,name limit 1;
     end if;
     if zone is null then raise exception 'Choose a valid time zone' using errcode='22023'; end if;
     clean:=clean||jsonb_build_object(k,zone);
   else
     hi:=case when k='dueSoonDays' then 14 when k in ('overdueEveryDays','reviewAfterDays','inactiveAfterDays') then 30 when k='weeklyDay' then 7 else 23 end;
     if jsonb_typeof(v)<>'number' or (v#>>'{}')::numeric<>trunc((v#>>'{}')::numeric)
       or (v#>>'{}')::numeric < (case when k in ('dueSoonDays','overdueEveryDays','reviewAfterDays','inactiveAfterDays','weeklyDay') then 1 else 0 end)
       or (v#>>'{}')::numeric>hi then raise exception 'Preference is outside its allowed range' using errcode='22023'; end if;
     clean:=clean||jsonb_build_object(k,((v#>>'{}')::numeric)::integer);
   end if;
 end loop;
 new.config:=private.automation_defaults()||clean;
 new.updated_at:=now();
 -- A time-zone change retires this member's not-yet-claimed calendar jobs from another zone. Delivery
 -- would skip them for the mismatch, and their occurrence keys (which carry only the local date)
 -- would swallow the re-planned occurrence. Renaming the key frees it; the row stays as an audit tombstone.
 update private.automation_jobs set state='skipped',completed_at=now(),occurrence_key=occurrence_key||':superseded:'||id
 where workspace_id=new.workspace_id and recipient_id=new.user_id and state in ('pending','retry')
   and payload ? 'timezone' and payload->>'timezone' is distinct from new.config->>'timezone';
 insert into private.automation_schedules(workspace_id,user_id,next_scan_at) values(new.workspace_id,new.user_id,now())
 on conflict(workspace_id,user_id) do update set next_scan_at=excluded.next_scan_at,task_cursor=null;
 return new;
end; $$;

-- Rewrite stored non-canonical rows through the trigger. Only active members' rows: the trigger
-- (re)creates the member's schedule, whose foreign key needs the membership row.
update public.notification_preferences p set config=p.config
where exists(select 1 from public.workspace_members m where m.workspace_id=p.workspace_id and m.user_id=p.user_id and m.status='active')
  and exists(select 1 from jsonb_each(p.config) e where jsonb_typeof(e.value)='number' and (e.value#>>'{}') !~ '^-?[0-9]+$');

-- 2 and 3. Planner --------------------------------------------------------------------------------

create or replace function private.plan_automation(p_now timestamptz,p_limit integer) returns integer
language plpgsql security definer set search_path='' as $$
declare m record; t record; cfg jsonb; ws public.workspace_automation_settings;
 local_now timestamp; local_day date; kind text; days integer; count_scanned integer:=0; payload jsonb;
 generation integer; key text; tasks_seen integer; last_task uuid; reminder_hour integer; qs integer; qe integer;
begin
 if p_limit is null or p_limit not between 1 and 500 then raise exception 'Batch size must be 1-500' using errcode='22023'; end if;
 for m in select a.* from private.automation_schedules a join public.workspace_members b using(workspace_id,user_id)
   where b.status='active' and a.next_scan_at<=p_now order by a.next_scan_at,a.workspace_id,a.user_id
   for update of a skip locked limit p_limit loop
   begin
     cfg:=private.automation_config(m.workspace_id,m.user_id);
     select * into ws from public.workspace_automation_settings where workspace_id=m.workspace_id;
     local_now:=p_now at time zone (cfg->>'timezone'); local_day:=local_now::date;
     tasks_seen:=0; last_task:=null;
     -- A reminder hour inside quiet hours is planned when quiet hours end on the same local day,
     -- so the reminder describes the day it is delivered on (delivery re-checks that day).
     reminder_hour:=(cfg->>'reminderHour')::integer; qs:=(cfg->>'quietStart')::integer; qe:=(cfg->>'quietEnd')::integer;
     if qs<>qe and ((qs<qe and reminder_hour>=qs and reminder_hour<qe) or (qs>qe and (reminder_hour>=qs or reminder_hour<qe))) then
       reminder_hour:=qe;
     end if;
     if ws.enabled is distinct from false and ws.reminders_enabled is distinct from false
       and extract(hour from local_now)>=reminder_hour then
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
   exception when others then
     -- This membership's jobs from this pass are rolled back with the subtransaction. The schedule
     -- is retried in an hour; the log line carries the SQLSTATE only, never preferences or task data.
     raise warning 'automation planning deferred one schedule (SQLSTATE %)',sqlstate;
     update private.automation_schedules set next_scan_at=p_now+interval '1 hour',task_cursor=null
       where workspace_id=m.workspace_id and user_id=m.user_id;
   end;
   count_scanned:=count_scanned+1;
 end loop;
 return count_scanned;
end; $$;
revoke execute on function private.plan_automation(timestamptz,integer),private.automation_config(uuid,uuid),
 private.validate_automation_preferences() from public,anon,authenticated;

-- 4. Claiming -------------------------------------------------------------------------------------

create or replace function public.claim_automation_jobs(p_limit integer default 20) returns jsonb
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
 -- `attempts<5`: a job whose budget is spent can only be failed, even if someone sets it back to retry
 -- without resetting attempts (see docs/automation.md for the supported requeue statement).
 for j in select * from private.automation_jobs where state in ('pending','retry') and run_after<=now() and attempts<5
 order by run_after,id for update skip locked limit p_limit loop
   token:=gen_random_uuid();
   update private.automation_jobs set state='processing',attempts=attempts+1,claim_token=token,lease_until=now()+interval '5 minutes' where id=j.id;
   -- A requeued job that kept its attempt log reuses the attempt number; that row starts over.
   insert into private.automation_attempts(job_id,attempt) values(j.id,j.attempts+1)
   on conflict(job_id,attempt) do update set started_at=now(),ended_at=null,outcome='processing',error_code=null;
   result:=result||jsonb_build_array(jsonb_build_object('id',j.id,'claim_token',token,'kind',j.kind,'recipient_id',j.recipient_id,
     'workspace_id',j.workspace_id,'task_id',j.task_id,'payload',j.payload));
 end loop;
 return result;
end; $$;

-- 5. Administrator outcomes -----------------------------------------------------------------------

create or replace function public.automation_outcomes(p_workspace_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not private.has_workspace_role(p_workspace_id,array['owner','admin']::public.workspace_role[]) then
   raise exception 'Workspace administrator required' using errcode='42501';
 end if;
 -- Operational metadata only. A preference skip reads as completed, a quiet-hours deferral as pending, no row carries a next-eligible
 -- or completion time, and creation is day-level, so rows do not expose members' opt-outs, quiet
 -- hours or chosen summary hours. Worker failures keep their failure time and code.
 return coalesce((select jsonb_agg(x) from (
   -- A quiet-hours deferral (retry with no error: finish_automation_job puts the attempt back) reads as
   -- pending, so it does not reveal that a member is inside their quiet hours.
   select j.id,j.kind,case when j.state='skipped' then 'completed' when j.state='retry' and j.last_error is null then 'pending' else j.state end as state,j.attempts,
     date_trunc('day',j.created_at) as created_at,
     -- No next-eligible time at all: a failed job deferred by quiet hours keeps its last_error, so even
     -- failure retries could carry a member's quiet-hours end.
     null::timestamptz as run_after,
     null::timestamptz as completed_at,j.failed_at,j.last_error
   -- Ordered by the exact creation time (qualified, so not the day-level output column).
   from private.automation_jobs j where j.workspace_id=p_workspace_id order by j.created_at desc,j.id limit 100)x),'[]'::jsonb);
end; $$;
