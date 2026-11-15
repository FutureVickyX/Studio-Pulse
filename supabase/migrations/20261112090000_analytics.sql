-- Studio Pulse Phase 3A — 10: analytics.
--
-- Additive: one read-only reporting function. No table, view, policy, index or grant on data
-- changes, and no access is widened.
--  1. analytics_time_summary() aggregates synced time entries on the server, so the web app never
--     downloads a tracking history to add it up. It is SECURITY INVOKER: it reads
--     public.time_entries as the caller, so the time_entries_select policy decides which rows
--     count, exactly as for a plain select. Members count only their own time. Owners and admins
--     count teammates' time only when the owner chose 'admins' visibility, and then also former
--     members' time, as the policy already allows. The caller must be an active member (P0002
--     otherwise, also for a removed member and for a workspace that does not exist).
--     teammates_visible on the total row says which case applied. When teammates are not
--     visible the user filter is narrowed to the caller: a planner hint, since RLS already
--     enforces it.
--  2. Reconciliation (docs/analytics.md). Within one user, each instant belongs to the first row
--     in (started_at, ended_at, id) order among the user's active rows covering it, else among
--     their idle rows. Ordering uses the unclipped times (truncated to ms), so attribution never
--     depends on the report range. Different users are never reconciled against each other.
--     Filters (project, unattributed = no project and no task, application) apply after
--     reconciliation, so a filtered figure is a part of the unfiltered one. overlap_ms (total row)
--     is the clipped raw time of the rows that pass the filters minus their reconciled time.
--  3. Days are local calendar days in p_time_zone. A day starts at the first instant whose
--     wall-clock date is on or after it: a skipped midnight moves forward, a repeated midnight
--     uses the earlier instant. That expression is written inline (no helper function may be
--     added) and does not depend on the session time zone. Weeks are ISO weeks (Monday), months
--     start on the 1st; both roll up days.
--  4. Filter-restricted input: with a filter set, only rows of the same user that overlap a
--     matching row are reconciled. A row's share depends only on the rows covering its instants,
--     so the figures are exactly those of the full computation. The matching rows are read, and
--     checked by RLS, once; their non-matching neighbours are found through the existing
--     indexes. A selective filter so reads a small part of the range under RLS instead of every
--     row; a filter that matches most rows costs about the same as no filter, not more.
--  5. Limits (22023): 2020-01-01 <= days < 2100-01-01; at most 366 days, or with a project
--     366 (day), 1100 (week) or 3660 (month) days; at most 500 users; IANA zone names only
--     (POSIX strings such as UTC+3 and fixed abbreviations such as CET are refused).
--  6. Performance, measured in PGlite 18.6 (WASM, one connection): 10 people with a year of
--     entries, about 30k or 125k rows in the workspace; Europe/Berlin; best warm call. The
--     owner reads everyone ('admins' visibility).
--                                              30k rows     125k rows
--       member, last 30 days                      18 ms         38 ms
--       member, 366 days by day                   92 ms        298 ms
--       member, a project, all time by month      25 ms         69 ms
--       owner, last 30 days                      109 ms        407 ms
--       owner, 366 days by day                 1,209 ms      5,412 ms
--       owner, 366 days by month               1,196 ms      5,373 ms
--       owner, a project, all time by month      410 ms      1,593 ms
--       owner under 'private', 366 days           74 ms        271 ms
--     A filter that matches most rows (same generator, then 90% of rows made unattributed and
--     80% Figma; owner, 366 days by day):
--       no filter                              1,851 ms      8,958 ms
--       unattributed (about 90% of rows)       1,817 ms      8,933 ms
--       Figma (about 80% of rows)              1,847 ms      8,508 ms
--     Before the matching rows were read only once (the lookup below fetched them again, under
--     RLS) the two filtered calls took 3,423 / 14,542 ms and 3,194 / 13,746 ms in the same runs.
--     The project rows of the first table predate that change, which only removes work (owner,
--     a project, all time: 2,553 -> 1,403 ms in a same-run comparison on a throttled machine).
--     An owner's year is dominated by the RLS check of every teammate row (about 26 us a row:
--     0.8 s of 2.4 s at 30k rows, EXPLAIN ANALYZE), then by sorts and window functions over
--     the rows in range. work_mem is not set: 16MB instead of 4MB saved 3-13% at 125k rows,
--     and a function-level setting would apply to every sort of every concurrent call.
--     Indexes: none added. time_entries_workspace_started, time_entries_user_started and
--     time_entries_project serve every access path (EXPLAIN: index scans for the range read,
--     the user hint, the project seeds and the per-island neighbour lookups). What remains is
--     the per-row RLS check on teammates' rows, which no index removes.
--     Custom plans: the two queries that read time_entries run through EXECUTE with constant
--     SQL text and USING parameters, so each call is planned with its own values (user hint,
--     pruned input branch). A cached generic plan, which PL/pgSQL may switch to after five
--     calls, can do neither. `set plan_cache_mode = force_custom_plan` on the function would
--     also do it, but it applies to everything the call runs: on Postgres 18 the RLS helper
--     private.has_workspace_role, a SQL function called for every teammate row, was then
--     re-planned on each call (owner RLS scan of 29k rows: 568 ms -> 3,286 ms).
-- Tests: tests/integration/supabase/analytics.test.ts (plus privileges and anon).

-- ---------------------------------------------------------------------------------------------
-- analytics_time_summary
--
-- One row per figure, ordered: total (exactly one, even without data), period, member, project,
-- task, application; then bucket_start, user_id, project_id, unattributed, task_id,
-- application_id (code-point order), all ascending with nulls last. Rows other than the total
-- appear only where active_ms + idle_ms > 0. entry_count counts distinct entries contributing,
-- so an entry crossing midnight counts once in each day.
-- ---------------------------------------------------------------------------------------------

create function public.analytics_time_summary(
  p_workspace_id uuid,
  p_to date,
  p_time_zone text,
  p_from date default null,
  p_bucket text default 'day',
  p_user_ids uuid[] default null,
  p_project_id uuid default null,
  p_unattributed boolean default false,
  p_application_id text default null
)
returns table (
  dimension text,
  bucket_start date,
  user_id uuid,
  application_id text,
  application_name text,
  project_id uuid,
  task_id uuid,
  unattributed boolean,
  active_ms bigint,
  idle_ms bigint,
  entry_count integer,
  overlap_ms bigint,
  teammates_visible boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_teammates boolean;
  v_users uuid[];
  v_filtered boolean;
  v_first timestamptz;
  v_from date;
  v_start timestamptz;
  v_end timestamptz;
begin
  if v_uid is null then
    raise exception 'sign in to see analytics' using errcode = '28000';
  end if;
  if p_workspace_id is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;

  if p_to is null then
    raise exception 'choose the last day of the report' using errcode = '22023';
  end if;
  if p_time_zone is null then
    raise exception 'choose a time zone for the report' using errcode = '22023';
  end if;
  if p_bucket is null or p_bucket not in ('day', 'week', 'month') then
    raise exception 'group the report by day, week or month' using errcode = '22023';
  end if;
  if p_unattributed is null then
    raise exception 'say whether to show only unattributed time' using errcode = '22023';
  end if;
  -- IANA names only. POSIX strings (UTC+3, which Postgres reads with the sign inverted) and
  -- fixed abbreviations (CET, EST: no daylight saving time) would disagree with the browser.
  if p_time_zone !~ '^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+)+)$' then
    raise exception 'unknown time zone' using errcode = '22023';
  end if;
  begin
    perform now() at time zone p_time_zone;
  exception when others then
    raise exception 'unknown time zone' using errcode = '22023';
  end;
  if p_from is not null and p_to < p_from then
    raise exception 'the report ends before it starts' using errcode = '22023';
  end if;
  if p_from < date '2020-01-01' or p_to < date '2020-01-01' then
    raise exception 'reports cover days from 1 January 2020' using errcode = '22023';
  end if;
  if p_to >= date '2100-01-01' then
    raise exception 'reports cover days before 1 January 2100' using errcode = '22023';
  end if;
  if cardinality(p_user_ids) > 500 then
    raise exception 'a report covers at most 500 people' using errcode = '22023';
  end if;
  if p_project_id is not null and p_unattributed then
    raise exception 'choose a project or unattributed time, not both' using errcode = '22023';
  end if;

  v_teammates := private.has_workspace_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[])
    and exists (
      select 1 from public.workspaces w
      where w.id = p_workspace_id and w.time_entry_visibility = 'admins'
    );
  if v_teammates then
    v_users := p_user_ids;
  elsif p_user_ids is null or v_uid = any (p_user_ids) then
    v_users := array[v_uid];
  else
    v_users := '{}';
  end if;
  v_filtered := p_project_id is not null or p_unattributed or p_application_id is not null;

  -- Start of a local day d: x is Postgres' own reading of d's midnight; y is the candidate one
  -- offset earlier (the offset 24 hours before x). Take y when it is earlier and still on day d.
  -- The same expression appears below for v_start and for every day window.
  select case when b.y < a.x and (b.y at time zone p_time_zone) = a.d::timestamp then b.y else a.x end
  into v_end
  from (select p_to + 1 as d, (p_to + 1)::timestamp at time zone p_time_zone as x) a
  cross join lateral (
    select (a.d::timestamp - (((a.x - interval '24 hours') at time zone p_time_zone)
                              - ((a.x - interval '24 hours') at time zone 'UTC'))) at time zone 'UTC' as y
  ) b;

  -- No first day: from the local day of the first row in scope (after RLS, users and filters).
  v_from := p_from;
  if v_from is null then
    execute $q$
      select min(t.started_at)
      from public.time_entries t
      where t.workspace_id = $1
        and t.started_at < $2
        and ($3 is null or t.user_id = any ($3))
        and ($4 is null or t.project_id = $4)
        and (not $5 or (t.project_id is null and t.task_id is null))
        and ($6 is null or t.application_id = $6)
    $q$
    into v_first
    using p_workspace_id, v_end, v_users, p_project_id, p_unattributed, p_application_id;
    v_from := coalesce((v_first at time zone p_time_zone)::date, p_to);
  end if;
  if p_project_id is null and p_to - v_from + 1 > 366 then
    raise exception 'a report covers at most 366 days' using errcode = '22023';
  end if;
  if p_project_id is not null
     and p_to - v_from + 1 > (case p_bucket when 'day' then 366 when 'week' then 1100 else 3660 end) then
    raise exception 'a project report by % covers at most % days', p_bucket,
      (case p_bucket when 'day' then 366 when 'week' then 1100 else 3660 end)
      using errcode = '22023';
  end if;

  select case when b.y < a.x and (b.y at time zone p_time_zone) = a.d::timestamp then b.y else a.x end
  into v_start
  from (select v_from as d, v_from::timestamp at time zone p_time_zone as x) a
  cross join lateral (
    select (a.d::timestamp - (((a.x - interval '24 hours') at time zone p_time_zone)
                              - ((a.x - interval '24 hours') at time zone 'UTC'))) at time zone 'UTC' as y
  ) b;

  -- Parameters: $1 workspace, $2 range start, $3 range end, $4 users (null: all the caller may
  -- read), $5 a filter is set, $6 project, $7 unattributed only, $8 application, $9 time zone,
  -- $10 first day, $11 last day, $12 bucket, $13 teammates visible.
  return query execute $q$
  with
  -- Rows matching the filters (only when one is set): the seeds of the restricted input. They
  -- carry every column, so they go into src as they are and are read (and RLS-checked) once.
  m as materialized (
    select t.id, t.user_id, t.application_id, t.application_name, t.kind, t.project_id, t.task_id,
           date_trunc('milliseconds', t.started_at) as s0,
           date_trunc('milliseconds', t.ended_at) as e0
    from public.time_entries t
    where $5
      and t.workspace_id = $1
      and t.started_at < $3 and t.ended_at > $2
      and t.started_at >= $2 - interval '744 hours'
      and ($4 is null or t.user_id = any ($4))
      and ($6 is null or t.project_id = $6)
      and (not $7 or (t.project_id is null and t.task_id is null))
      and ($8 is null or t.application_id = $8)
  ),
  -- Per user, the union of the matching rows as disjoint islands [cs, ce).
  mh as (
    select m.user_id, m.s0, m.e0,
           max(m.e0) over (partition by m.user_id order by m.s0, m.e0
                           rows between unbounded preceding and 1 preceding) as hw
    from m
  ),
  mk as (
    select mh.user_id, mh.s0, mh.e0,
           sum(case when mh.hw is null or mh.s0 > mh.hw then 1 else 0 end)
             over (partition by mh.user_id order by mh.s0, mh.e0 rows unbounded preceding) as k
    from mh
  ),
  isl as (
    select mk.user_id, min(mk.s0) as cs, max(mk.e0) as ce from mk group by mk.user_id, mk.k
  ),
  -- A row starting in [previous island's end, this island's end) overlaps the union exactly
  -- when it ends after this island's start; rows last at most 744 hours. The segments are
  -- disjoint, so each row is read once: one index range scan of time_entries_user_started per
  -- island (the lateral subquery below is kept as a per-island lookup by `offset 0`), and only
  -- the rows that reach into an island are checked by RLS.
  -- The lookup returns only the neighbours that do not match the filters: the matching rows are
  -- m itself (each overlaps its own island). Its last condition is m's filter expression `is not
  -- true`, the exact complement of a WHERE (a null project is not the filtered project). It uses
  -- only leakproof nodes (uuid and text =, IS NULL, AND/OR/NOT, IS NOT TRUE), so the planner
  -- checks it before the RLS qual and a matching row is not RLS-checked a second time; and no
  -- index can serve it (`project_id is not null or task_id is not null` would invite a
  -- BitmapOr over the project and task indexes on every per-island lookup).
  seg as (
    select isl.user_id, isl.cs, isl.ce,
           greatest(lag(isl.ce) over (partition by isl.user_id order by isl.cs),
                    isl.cs - interval '744 hours') as lo
    from isl
  ),
  src as (
    select t.id, t.user_id, t.application_id, t.application_name, t.kind, t.project_id, t.task_id,
           date_trunc('milliseconds', t.started_at) as s0,
           date_trunc('milliseconds', t.ended_at) as e0
    from public.time_entries t
    where not $5
      and t.workspace_id = $1
      and t.started_at < $3 and t.ended_at > $2
      and t.started_at >= $2 - interval '744 hours'
      and ($4 is null or t.user_id = any ($4))
    union all
    select m.id, m.user_id, m.application_id, m.application_name, m.kind, m.project_id, m.task_id,
           m.s0, m.e0
    from m
    union all
    select n.id, n.user_id, n.application_id, n.application_name, n.kind, n.project_id, n.task_id,
           date_trunc('milliseconds', n.started_at),
           date_trunc('milliseconds', n.ended_at)
    from seg
    cross join lateral (
      select t.id, t.user_id, t.application_id, t.application_name, t.kind, t.project_id,
             t.task_id, t.started_at, t.ended_at
      from public.time_entries t
      where t.user_id = seg.user_id
        and t.started_at >= seg.lo and t.started_at < seg.ce
        and t.ended_at > seg.cs
        and t.workspace_id = $1
        and t.started_at < $3 and t.ended_at > $2
        and t.started_at >= $2 - interval '744 hours'
        and ($4 is null or t.user_id = any ($4))
        and ((($6 is null or t.project_id = $6)
              and (not $7 or (t.project_id is null and t.task_id is null))
              and ($8 is null or t.application_id = $8)) is not true)
      offset 0
    ) n
  ),
  -- Clipped to the range; rows with nothing left in it cannot own any instant.
  cl as (
    select src.id, src.user_id, src.application_id, src.application_name, src.kind,
           src.project_id, src.task_id, src.s0, src.e0,
           greatest(src.s0, $2) as s, least(src.e0, $3) as e
    from src
    where least(src.e0, $3) > greatest(src.s0, $2)
  ),
  -- High-water sweep per user and kind in unclipped (started_at, ended_at, id) order.
  hw as (
    select cl.*,
           max(cl.e) over (partition by cl.user_id, cl.kind order by cl.s0, cl.e0, cl.id
                           rows between unbounded preceding and 1 preceding) as hwm
    from cl
  ),
  pc as (
    select hw.id, hw.user_id, hw.application_id, hw.application_name, hw.kind,
           hw.project_id, hw.task_id, hw.s0,
           greatest(hw.s, coalesce(hw.hwm, hw.s)) as ps, hw.e as pe
    from hw
    where greatest(hw.s, coalesce(hw.hwm, hw.s)) < hw.e
  ),
  -- Active beats idle: cut the union of active pieces out of the idle pieces, without a join.
  -- Per user, the event points carry running counts of the active (a) and idle (i) pieces
  -- covering [t, next t) and of the idle pieces started so far (n). Idle pieces are disjoint, so
  -- the one in progress is the n-th; its fields travel with its start point and are spread over
  -- the points that follow it.
  ev as (
    select pc.user_id, pc.ps as t,
           case when pc.kind = 'active' then 1 else 0 end as da,
           case when pc.kind = 'idle' then 1 else 0 end as di,
           pc.kind = 'idle' as starts_idle,
           pc.id, pc.application_id, pc.application_name, pc.project_id, pc.task_id, pc.s0
    from pc
    union all
    select pc.user_id, pc.pe,
           case when pc.kind = 'active' then -1 else 0 end,
           case when pc.kind = 'idle' then -1 else 0 end,
           false, null, null, null, null, null, null
    from pc
  ),
  pt as (
    -- Integer steps, so the running sums below are bigint (not numeric).
    select ev.user_id, ev.t, sum(ev.da)::integer as da, sum(ev.di)::integer as di,
           (count(*) filter (where ev.starts_idle))::integer as dn,
           (array_agg(ev.id) filter (where ev.starts_idle))[1] as id,
           (array_agg(ev.application_id) filter (where ev.starts_idle))[1] as application_id,
           (array_agg(ev.application_name) filter (where ev.starts_idle))[1] as application_name,
           (array_agg(ev.project_id) filter (where ev.starts_idle))[1] as project_id,
           (array_agg(ev.task_id) filter (where ev.starts_idle))[1] as task_id,
           (array_agg(ev.s0) filter (where ev.starts_idle))[1] as s0
    from ev
    group by ev.user_id, ev.t
  ),
  st as (
    select pt.*,
           lead(pt.t) over w as tn,
           sum(pt.da) over w as a,
           sum(pt.di) over w as i,
           sum(pt.dn) over w as n
    from pt
    window w as (partition by pt.user_id order by pt.t rows between unbounded preceding and current row)
  ),
  sn as (
    select st.user_id, st.t, st.tn, st.a, st.i,
           first_value(st.id) over p as id,
           first_value(st.application_id) over p as application_id,
           first_value(st.application_name) over p as application_name,
           first_value(st.project_id) over p as project_id,
           first_value(st.task_id) over p as task_id,
           first_value(st.s0) over p as s0
    from st
    window p as (partition by st.user_id, st.n order by st.t)
  ),
  frag as (
    select sn.id, sn.user_id, sn.application_id, sn.application_name, 'idle'::text as kind,
           sn.project_id, sn.task_id, sn.s0, sn.t as ps, sn.tn as pe
    from sn
    where sn.i > 0 and sn.a = 0 and sn.tn is not null
  ),
  rec as (
    select pc.id, pc.user_id, pc.application_id, pc.application_name, pc.kind,
           pc.project_id, pc.task_id, pc.s0, pc.ps, pc.pe
    from pc
    where pc.kind = 'active'
    union all
    select frag.id, frag.user_id, frag.application_id, frag.application_name, frag.kind,
           frag.project_id, frag.task_id, frag.s0, frag.ps, frag.pe
    from frag
  ),
  -- Day windows [start of d, start of d + 1), built once (start of a day as above).
  bounds as (
    select k.d,
           case when b.y < a.x and (b.y at time zone $9) = k.d::timestamp then b.y else a.x end as sod
    from (select $10 - 1 + g.n as d from generate_series(0, $11 - $10 + 2) as g(n)) k
    cross join lateral (select k.d::timestamp at time zone $9 as x) a
    cross join lateral (
      select (k.d::timestamp - (((a.x - interval '24 hours') at time zone $9)
                                - ((a.x - interval '24 hours') at time zone 'UTC'))) at time zone 'UTC' as y
    ) b
  ),
  days as materialized (
    select w.d, w.ws, w.we
    from (select bounds.d, bounds.sod as ws, lead(bounds.sod) over (order by bounds.d) as we from bounds) w
    where w.d <= $11
  ),
  sp as (
    select rec.*, days.d, greatest(rec.ps, days.ws) as a0, least(rec.pe, days.we) as a1
    from rec
    cross join lateral generate_series(((rec.ps at time zone $9)::date - 1)::timestamp,
                                       (rec.pe at time zone $9)::date::timestamp,
                                       interval '1 day') as g(d)
    join days on days.d = g.d::date
    where days.ws < rec.pe and days.we > rec.ps
  ),
  -- Filters apply after reconciliation.
  f as (
    select sp.id, sp.user_id, sp.application_id, sp.application_name, sp.kind,
           sp.project_id, sp.task_id, sp.s0,
           (sp.project_id is null and sp.task_id is null) as ua,
           round(extract(epoch from (sp.a1 - sp.a0)) * 1000)::bigint as ms,
           case $12
             when 'day' then sp.d
             when 'week' then sp.d - (extract(isodow from sp.d)::integer - 1)
             else date_trunc('month', sp.d::timestamp)::date
           end as b
    from sp
    where ($6 is null or sp.project_id = $6)
      and (not $7 or (sp.project_id is null and sp.task_id is null))
      and ($8 is null or sp.application_id = $8)
  ),
  -- The name on the contributing entry with the highest (started_at, id).
  names as (
    select distinct on (f.application_id) f.application_id, f.application_name
    from f
    order by f.application_id, f.s0 desc, f.id desc
  ),
  agg as (
    select case when grouping(f.b) = 0 then 'period'
                when grouping(f.application_id) = 0 then 'application'
                when grouping(f.task_id) = 0 then 'task'
                when grouping(f.ua) = 0 then 'project'
                when grouping(f.user_id) = 0 then 'member'
                else 'total' end as dim,
           f.b, f.user_id as u, f.application_id as app, f.project_id as proj, f.task_id as task, f.ua,
           coalesce(sum(f.ms) filter (where f.kind = 'active'), 0)::bigint as a,
           coalesce(sum(f.ms) filter (where f.kind = 'idle'), 0)::bigint as i,
           count(distinct f.id)::integer as n
    from f
    group by grouping sets ((), (f.b), (f.user_id), (f.project_id, f.ua), (f.project_id, f.task_id),
                            (f.application_id))
  ),
  -- Clipped raw time of the rows that pass the filters (for overlap_ms).
  raw as (
    select coalesce(sum(round(extract(epoch from (cl.e - cl.s)) * 1000)), 0)::bigint as ms
    from cl
    where ($6 is null or cl.project_id = $6)
      and (not $7 or (cl.project_id is null and cl.task_id is null))
      and ($8 is null or cl.application_id = $8)
  )
  select agg.dim, agg.b, agg.u, agg.app, names.application_name, agg.proj, agg.task, agg.ua,
         agg.a, agg.i, agg.n,
         case when agg.dim = 'total' then (select raw.ms from raw) - agg.a - agg.i else 0::bigint end,
         case when agg.dim = 'total' then $13 end
  from agg
  left join names on agg.dim = 'application' and names.application_id = agg.app
  where agg.dim = 'total' or agg.a + agg.i > 0
  order by case agg.dim when 'total' then 0 when 'period' then 1 when 'member' then 2
                        when 'project' then 3 when 'task' then 4 else 5 end,
           agg.b nulls last, agg.u nulls last, agg.proj nulls last, agg.ua nulls last,
           agg.task nulls last, agg.app collate "C" nulls last
  $q$
  using p_workspace_id, v_start, v_end, v_users, v_filtered, p_project_id, p_unattributed,
        p_application_id, p_time_zone, v_from, p_to, p_bucket, v_teammates;
end;
$$;

revoke execute on function
  public.analytics_time_summary(uuid, date, text, date, text, uuid[], uuid, boolean, text)
from public, anon;
grant execute on function
  public.analytics_time_summary(uuid, date, text, date, text, uuid[], uuid, boolean, text)
to authenticated;
