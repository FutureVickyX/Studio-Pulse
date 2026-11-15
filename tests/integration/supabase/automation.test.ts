import { describe, expect, it } from 'vitest';
import { buildWorld as baseWorld, createProject, createTask, fails, ok, only, useDatabase } from './fixtures';
import type { SupabaseTestDb } from './harness';

const db = useDatabase();
async function buildWorld(database: SupabaseTestDb) {
  const w = await baseWorld(database);
  for (const user of [w.alice,w.bob,w.carol,w.dave,w.gina]) {
    ok(await database.affected(user, `insert into public.notification_preferences(workspace_id,config) values($1,'{"quietStart":0,"quietEnd":0}')`, [w.wsA]));
  }
  return w;
}
type Job = { id: string; claim_token: string; kind: string; recipient_id: string; task_id: string | null; payload: Record<string, unknown> };
async function claim(): Promise<Job[]> {
  return only(ok(await db().query<{ jobs: Job[] }>('service', 'select public.claim_automation_jobs(20) as jobs'))).jobs;
}
async function finish(job: Job) {
  return only(ok(await db().query<{ outcome: string }>('service', 'select public.finish_automation_job($1,$2,null) as outcome', [job.id, job.claim_token]))).outcome;
}

describe('trusted task event outbox', () => {
  it('delivers an assignment once to its assignee, not other workspace members', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.alice, w.wsA);
    ok(await db().affected(w.alice, 'update public.tasks set assignee_id=$2 where id=$1', [task, w.carol.id]));
    const jobs = (await claim()).filter(j => j.task_id === task);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.recipient_id).toBe(w.carol.id);
    expect(await finish(job)).toBe('completed');
    expect(await finish(job)).toBe('completed');
    expect(ok(await db().query(w.carol, 'select id, task_id, kind from public.notifications where task_id=$1', [task]))).toHaveLength(1);
    expect(ok(await db().query(w.alice, 'select id from public.notifications where task_id=$1', [task]))).toHaveLength(0);
    expect(ok(await db().query(w.bob, 'select id from public.notifications where task_id=$1', [task]))).toHaveLength(0);
  });

  it('invalidates earlier assignments, even if reassigned back before delivery', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.alice, w.wsA);
    for (const person of [w.carol, w.bob, w.carol]) {
      ok(await db().affected(w.alice, 'update public.tasks set assignee_id=$2 where id=$1', [task, person.id]));
    }
    const jobs = (await claim()).filter(j => j.task_id === task);
    expect(jobs).toHaveLength(3);
    const outcomes = [];
    for (const job of jobs) outcomes.push(await finish(job));
    expect(outcomes.sort()).toEqual(['completed', 'skipped', 'skipped']);
  });

  it('does not permit users or anonymous clients to forge notices or run the worker', async () => {
    const w = await buildWorld(db());
    for (const who of [w.alice, w.carol, 'anon'] as const) {
      fails(await db().query(who, 'select public.claim_automation_jobs(20)'), '42501');
      fails(await db().query(who, 'select public.plan_automation_jobs(20)'), '42501');
      fails(await db().affected(who, "insert into public.notifications (workspace_id,recipient_id,kind,title) values ($1,$2,'assigned','Fake')", [w.wsA,w.carol.id]), '42501');
    }
    fails(await db().query(w.carol, 'select * from private.automation_jobs'), '42501');
    fails(await db().affected(w.carol, "insert into public.workspace_automation_settings(workspace_id,enabled) values($1,false)", [w.wsA]), '42501');
  });

  it('allows only read-state updates on the recipient’s own notification', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.alice, w.wsA);
    ok(await db().affected(w.alice, 'update public.tasks set assignee_id=$2 where id=$1', [task,w.carol.id]));
    const job=(await claim()).find(j=>j.task_id===task)!;
    await finish(job);
    expect(ok(await db().affected(w.carol,'update public.notifications set read_at=now() where task_id=$1',[task]))).toBe(1);
    expect(ok(await db().affected(w.alice,'update public.notifications set read_at=now() where task_id=$1',[task]))).toBe(0);
    fails(await db().affected(w.carol,"update public.notifications set title='Fake' where task_id=$1",[task]),'42501');
    ok(await db().query(w.alice,'select public.remove_member($1,$2)',[w.wsA,w.carol.id]));
    expect(ok(await db().query(w.carol,'select id from public.notifications where task_id=$1',[task]))).toHaveLength(0);
  });
});

describe('leases, bounded retries and interruption recovery', () => {
  it('authorizes only a registered scheduler key through the service-only verifier',async()=>{
    const key='a'.repeat(64);
    await db().admin("insert into private.automation_worker_keys(key_hash) values(sha256(convert_to($1,'UTF8')))",[key]);
    expect(only(ok(await db().query<{valid:boolean}>('service','select public.authorize_automation_worker($1) as valid',[key]))).valid).toBe(true);
    expect(only(ok(await db().query<{valid:boolean}>('service','select public.authorize_automation_worker($1) as valid',['b'.repeat(64)]))).valid).toBe(false);
    fails(await db().query('anon','select public.authorize_automation_worker($1)',[key]),'42501');
  });
  it('does not claim the same job twice, and rejects an obsolete claim token', async () => {
    const w=await buildWorld(db());
    const task=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id});
    const first=(await claim()).find(j=>j.task_id===task)!;
    expect((await claim()).find(j=>j.id===first.id)).toBeUndefined();
    await db().admin("update private.automation_jobs set lease_until=now()-interval '1 second' where id=$1",[first.id]);
    const second=(await claim()).find(j=>j.id===first.id)!;
    expect(second.claim_token).not.toBe(first.claim_token);
    fails(await db().query('service','select public.finish_automation_job($1,$2,null)',[first.id,first.claim_token]),'40001');
    expect(await finish(second)).toBe('completed');
    const attempts=await db().admin('select outcome from private.automation_attempts where job_id=$1 order by attempt',[first.id]);
    expect(attempts).toEqual([{outcome:'interrupted'},{outcome:'completed'}]);
  });

  it('retries with increasing delays and stops after five failed attempts', async () => {
    const w=await buildWorld(db());
    const task=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id});
    for(let attempt=1;attempt<=5;attempt++){
      const job=(await claim()).find(j=>j.task_id===task)!;
      expect(job).toBeDefined();
      ok(await db().query('service','select public.fail_automation_job($1,$2,$3)',[job.id,job.claim_token,'network']));
      const row=only(await db().admin<{attempts:number;state:string;seconds:number}>("select attempts,state,extract(epoch from run_after-now())::integer as seconds from private.automation_jobs where id=$1",[job.id]));
      expect(row.attempts).toBe(attempt);
      expect(row.state).toBe(attempt===5?'failed':'retry');
      expect(row.seconds).toBeGreaterThanOrEqual(60*2**(attempt-1)-2);
      expect((await claim()).find(j=>j.id===job.id)).toBeUndefined();
      if(attempt<5)await db().admin("update private.automation_jobs set run_after=now()-interval '1 second' where id=$1",[job.id]);
    }
  });

  it('rolls back an interrupted claim transaction, leaving the job pending', async () => {
    const w=await buildWorld(db());
    const task=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id});
    await expect(db().asService(async s=>{await s.query('select public.claim_automation_jobs(20)');throw new Error('simulated disconnect');})).rejects.toThrow('simulated disconnect');
    expect((await claim()).find(j=>j.task_id===task)).toBeDefined();
  });

  it('rejects unbounded batches and untrusted error strings', async () => {
    for(const count of [null,0,101])fails(await db().query('service','select public.claim_automation_jobs($1)',[count]),'22023');
    fails(await db().query('service','select public.fail_automation_job(null,null,$1)',['private record or secret']),'22023');
  });
});

describe('calendar scheduling and current permissions', () => {
  it('schedules waiting reviews and opted-in inactivity, and invalidates activity reminders after comments',async()=>{
    const w=await buildWorld(db());
    const project=await createProject(db(),w.alice,w.wsA);
    ok(await db().affected(w.alice,'update public.projects set lead_id=$2 where id=$1',[project,w.bob.id]));
    const review=await createTask(db(),w.alice,w.wsA,{projectId:project,status:'in_review'});
    const stale=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id});
    ok(await db().affected(w.carol,"update public.notification_preferences set config=config||'{\"inactive\":true}' where workspace_id=$1",[w.wsA]));
    await db().admin("update private.task_automation_state set review_started_at='2030-05-20',last_activity_at='2030-05-25' where task_id=any($1::uuid[])",[[review,stale]]);
    await db().admin("select private.plan_automation('2030-06-01T12:00:00Z',500)");
    expect(await db().admin("select recipient_id from private.automation_jobs where task_id=$1 and kind='awaiting_review'",[review])).toEqual([{recipient_id:w.bob.id}]);
    await db().admin("update private.automation_jobs set run_after=now() where task_id=$1 and kind='inactive'",[stale]);
    const job=(await claim()).find(j=>j.task_id===stale&&j.kind==='inactive')!;
    expect(job).toBeDefined();
    ok(await db().affected(w.carol,"insert into public.task_comments(workspace_id,task_id,body) values($1,$2,'An update')",[w.wsA,stale]));
    expect(await finish(job)).toBe('skipped');
  });
  it('keeps digests opt-in and deduplicates daily/weekly schedule occurrences', async () => {
    const w=await buildWorld(db());
    await db().admin("select private.plan_automation('2030-06-01T12:00:00Z',500)");
    expect(await db().admin("select id from private.automation_jobs where workspace_id=$1 and kind in ('daily','weekly')",[w.wsA])).toHaveLength(0);
    ok(await db().affected(w.carol,"update public.notification_preferences set config=config||'{\"daily\":true,\"weekly\":true,\"dailyHour\":0,\"weeklyHour\":0,\"weeklyDay\":6}' where workspace_id=$1",[w.wsA]));
    for(let i=0;i<2;i++){
      await db().admin("update private.automation_schedules set next_scan_at='2030-06-01' where workspace_id=$1",[w.wsA]);
      await db().admin("select private.plan_automation('2030-06-01T12:00:00Z',500)");
    }
    const jobs=await db().admin("select kind,payload->>'localDate' as day from private.automation_jobs where workspace_id=$1 and kind in ('daily','weekly') order by kind",[w.wsA]);
    expect(jobs).toEqual([{kind:'daily',day:'2030-06-01'},{kind:'weekly',day:'2030-06-01'}]);
  });

  it('does not deliver after preferences are disabled or membership is removed', async () => {
    const w=await buildWorld(db());
    const a=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id});
    const b=await createTask(db(),w.alice,w.wsA,{assigneeId:w.dave.id});
    const jobs=await claim();
    ok(await db().affected(w.carol,"update public.notification_preferences set config=config||'{\"assignment\":false}' where workspace_id=$1",[w.wsA]));
    ok(await db().query(w.alice,'select public.remove_member($1,$2)',[w.wsA,w.dave.id]));
    expect(await finish(jobs.find(j=>j.task_id===a)!)).toBe('skipped');
    expect(await finish(jobs.find(j=>j.task_id===b)!)).toBe('skipped');
  });

  it('enforces workspace controls even when personal reminders are enabled', async () => {
    const w=await buildWorld(db());
    fails(await db().affected(w.gina,'insert into public.workspace_automation_settings(workspace_id,enabled) values($1,false)',[w.wsA]),'42501');
    ok(await db().affected(w.alice,'insert into public.workspace_automation_settings(workspace_id,enabled) values($1,false)',[w.wsA]));
    const task=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id});
    const job=(await claim()).find(j=>j.task_id===task)!;
    expect(await finish(job)).toBe('skipped');
  });

  it('defers event delivery during quiet hours without exhausting its retry allowance', async () => {
    const w=await buildWorld(db());
    const task=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id});
    const job=(await claim()).find(j=>j.task_id===task)!;
    const hour=only(await db().admin<{hour:number}>('select extract(hour from now() at time zone \'UTC\')::integer as hour')).hour;
    ok(await db().affected(w.carol,"update public.notification_preferences set config=config||jsonb_build_object('quietStart',$2::integer,'quietEnd',$3::integer) where workspace_id=$1",[w.wsA,hour,(hour+2)%24]));
    expect(await finish(job)).toBe('deferred');
    const state=only(await db().admin<{attempts:number;future:boolean}>('select attempts,run_after>now() as future from private.automation_jobs where id=$1',[job.id]));
    expect(state).toEqual({attempts:0,future:true});
  });

  it('generates one due-soon occurrence per day and no reminders for done or archived tasks', async () => {
    const w=await buildWorld(db());
    const task=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id});
    ok(await db().affected(w.alice,"update public.tasks set due_date='2030-06-02' where id=$1",[task]));
    const done=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id,status:'done'});
    const archived=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id,status:'archived'});
    await db().admin("update public.tasks set due_date='2030-06-02' where id=any($1::uuid[])",[[done,archived]]);
    for(let i=0;i<2;i++){
      await db().admin("update private.automation_schedules set next_scan_at='2030-06-01' where workspace_id=$1",[w.wsA]);
      await db().admin("select private.plan_automation('2030-06-01T12:00:00Z',500)");
    }
    const rows=await db().admin("select task_id,kind from private.automation_jobs where workspace_id=$1 and kind in ('due_soon','due_today','overdue')",[w.wsA]);
    expect(rows).toEqual([{task_id:task,kind:'due_soon'}]);
  });

  it('invalidates a queued reminder when a task is rescheduled or completed', async () => {
    const w=await buildWorld(db());
    const task=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id});
    ok(await db().affected(w.alice,"update public.tasks set due_date='2030-06-02' where id=$1",[task]));
    await db().admin("select private.plan_automation('2030-06-01T12:00:00Z',500)");
    await db().admin("update private.automation_jobs set run_after=now() where task_id=$1 and kind='due_soon'",[task]);
    const reminder=(await claim()).find(j=>j.task_id===task&&j.kind==='due_soon')!;
    ok(await db().affected(w.alice,"update public.tasks set due_date='2030-07-01',status='done' where id=$1",[task]));
    expect(await finish(reminder)).toBe('skipped');
  });

  it('uses local calendar dates and quiet-hour boundaries across DST', async () => {
    const cfg={timezone:'America/New_York',quietStart:22,quietEnd:7};
    const row=only(await db().admin<{at:Date}>('select private.automation_delivery_at($1,$2::jsonb) as at',['2026-03-08T04:00:00Z',JSON.stringify(cfg)]));
    expect(new Date(row.at).toISOString()).toBe('2026-03-08T11:00:00.000Z');
    const w=await buildWorld(db());
    ok(await db().affected(w.carol,"update public.notification_preferences set config=config||'{\"timezone\":\"Pacific/Auckland\",\"reminderHour\":0}' where workspace_id=$1",[w.wsA]));
    const task=await createTask(db(),w.alice,w.wsA,{assigneeId:w.carol.id});
    ok(await db().affected(w.alice,"update public.tasks set due_date='2030-06-02' where id=$1",[task]));
    await db().admin("select private.plan_automation('2030-06-01T13:00:00Z',500)");
    const rows=await db().admin("select kind from private.automation_jobs where task_id=$1 and kind in ('due_today','due_soon')",[task]);
    expect(rows).toEqual([{kind:'due_today'}]);
  });

  it('notifies the project lead on review, and only the creator on opted-in completion', async () => {
    const w=await buildWorld(db());
    const project=await createProject(db(),w.alice,w.wsA);
    ok(await db().affected(w.alice,'update public.projects set lead_id=$2 where id=$1',[project,w.bob.id]));
    const task=await createTask(db(),w.carol,w.wsA,{projectId:project});
    ok(await db().affected(w.carol,"update public.tasks set status='in_review' where id=$1",[task]));
    const job=(await claim()).find(j=>j.task_id===task&&j.kind==='review')!;
    expect(job.recipient_id).toBe(w.bob.id);
    expect(await finish(job)).toBe('completed');
    ok(await db().affected(w.carol,"update public.notification_preferences set config=config||'{\"completion\":true}' where workspace_id=$1",[w.wsA]));
    ok(await db().affected(w.bob,"update public.tasks set status='done' where id=$1",[task]));
    const completed=(await claim()).find(j=>j.task_id===task&&j.kind==='completed')!;
    expect(completed.recipient_id).toBe(w.carol.id);
    expect(await finish(completed)).toBe('completed');
  });

  it('rejects invalid preferences and cross-workspace settings writes', async () => {
    const w=await buildWorld(db());
    for(const config of [{quietStart:24},{weeklyDay:0},{timezone:'PST'},{daily:'true'},{unexpected:true}]){
      fails(await db().affected(w.carol,'update public.notification_preferences set config=$2::jsonb where workspace_id=$1',[w.wsA,JSON.stringify(config)]),'22023');
    }
    fails(await db().affected(w.carol,'insert into public.notification_preferences(workspace_id) values($1)',[w.wsB]),'42501');
    fails(await db().query(w.carol,'select public.automation_outcomes($1)',[w.wsA]),'42501');
    const outcomes=only(ok(await db().query<{items:unknown[]}>(w.alice,'select public.automation_outcomes($1) as items',[w.wsA]))).items;
    expect(Array.isArray(outcomes)).toBe(true);
  });
});
