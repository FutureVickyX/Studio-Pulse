/** Phase 3C regressions for migration 14 (automation hardening), from the integration review. */
import { describe, expect, it } from 'vitest';
import { buildWorld as baseWorld, createTask, fails, ok, only, useDatabase } from './fixtures';
import type { SupabaseTestDb } from './harness';

const db = useDatabase();
async function buildWorld(database: SupabaseTestDb) {
  const w = await baseWorld(database);
  for (const user of [w.alice, w.bob, w.carol, w.dave, w.gina]) {
    ok(await database.affected(user, `insert into public.notification_preferences(workspace_id,config) values($1,'{"quietStart":0,"quietEnd":0}')`, [w.wsA]));
  }
  return w;
}
type Job = { id: string; claim_token: string; kind: string; recipient_id: string; task_id: string | null };
async function claim(): Promise<Job[]> {
  return only(ok(await db().query<{ jobs: Job[] }>('service', 'select public.claim_automation_jobs(20) as jobs'))).jobs;
}
async function stored(user: { id: string }, workspace: string) {
  return only(await db().admin<{ config: Record<string, unknown>; types: Record<string, string> }>(
    `select config, (select jsonb_object_agg(key, jsonb_typeof(value)||':'||value::text) from jsonb_each(config)) as types
       from public.notification_preferences where workspace_id=$1 and user_id=$2`, [workspace, user.id]));
}
/** `config` is raw JSON text: JavaScript would serialise 9.0 as 9, hiding the case under test. */
async function setConfigBypassingValidation(workspace: string, user: { id: string }, config: string) {
  // Simulates a row stored before migration 14 (or by an operator), which the planner must survive.
  await db().admin('alter table public.notification_preferences disable trigger notification_preferences_validate');
  try {
    await db().admin('update public.notification_preferences set config=$3::jsonb where workspace_id=$1 and user_id=$2', [workspace, user.id, config]);
  } finally {
    await db().admin('alter table public.notification_preferences enable trigger notification_preferences_validate');
  }
}

describe('canonical preferences', () => {
  it('stores an integral decimal such as 9.0 as the integer 9', async () => {
    const w = await buildWorld(db());
    ok(await db().affected(w.carol, `update public.notification_preferences set config='{"reminderHour":9.0,"quietStart":22.0,"quietEnd":7,"dueSoonDays":2.00}'::jsonb where workspace_id=$1`, [w.wsA]));
    const row = await stored(w.carol, w.wsA);
    expect(row.types.reminderHour).toBe('number:9');
    expect(row.types.quietStart).toBe('number:22');
    expect(row.types.dueSoonDays).toBe('number:2');
    // A genuinely fractional value is still rejected.
    fails(await db().affected(w.carol, `update public.notification_preferences set config='{"reminderHour":9.5}'::jsonb where workspace_id=$1`, [w.wsA]), '22023');
  });

  it('stores the tz-database spelling of a case-only variant and still rejects unknown zones', async () => {
    const w = await buildWorld(db());
    ok(await db().affected(w.carol, `update public.notification_preferences set config='{"timezone":"europe/london"}'::jsonb where workspace_id=$1`, [w.wsA]));
    expect((await stored(w.carol, w.wsA)).config.timezone).toBe('Europe/London');
    ok(await db().affected(w.carol, `update public.notification_preferences set config='{"timezone":"Africa/Lagos"}'::jsonb where workspace_id=$1`, [w.wsA]));
    expect((await stored(w.carol, w.wsA)).config.timezone).toBe('Africa/Lagos');
    for (const zone of ['not/azone', 'PST', 'Europe/London"']) {
      fails(await db().affected(w.carol, 'update public.notification_preferences set config=jsonb_build_object($2::text,$3::text) where workspace_id=$1', [w.wsA, 'timezone', zone]), '22023');
    }
  });

  it('reads a non-canonical stored value as an integer', async () => {
    const w = await buildWorld(db());
    await setConfigBypassingValidation(w.wsA, w.carol, '{"reminderHour":9.0,"quietStart":0,"quietEnd":0}');
    expect((await stored(w.carol, w.wsA)).types.reminderHour).toBe('number:9.0');
    const cfg = only(await db().admin<{ hour: string; type: string }>(
      "select private.automation_config($1,$2)->>'reminderHour' as hour, jsonb_typeof(private.automation_config($1,$2)->'reminderHour') as type", [w.wsA, w.carol.id]));
    expect(cfg).toEqual({ hour: '9', type: 'number' });
  });
});

describe('planner isolation', () => {
  it('one unusable schedule is deferred an hour while every other member is still planned', async () => {
    const w = await buildWorld(db());
    const carolTask = await createTask(db(), w.alice, w.wsA, { assigneeId: w.carol.id });
    const daveTask = await createTask(db(), w.alice, w.wsA, { assigneeId: w.dave.id });
    await db().admin("update public.tasks set due_date='2030-06-01' where id=any($1::uuid[])", [[carolTask, daveTask]]);
    // Before the fix any member could stall planning for every workspace; an invalid stored zone makes
    // `at time zone` raise inside the loop, as 9.0 made `::integer` raise.
    await setConfigBypassingValidation(w.wsA, w.carol, '{"timezone":"Not/AZone","quietStart":0,"quietEnd":0}');
    await db().admin("update private.automation_schedules set next_scan_at='2030-06-01' where workspace_id=$1", [w.wsA]);
    const scanned = only(await db().admin<{ n: number }>("select private.plan_automation('2030-06-01T12:00:00Z',500) as n")).n;
    expect(scanned).toBeGreaterThanOrEqual(2);
    expect(await db().admin("select kind from private.automation_jobs where task_id=$1 and kind='due_today'", [daveTask])).toHaveLength(1);
    expect(await db().admin('select id from private.automation_jobs where task_id=$1 and kind=$2', [carolTask, 'due_today'])).toHaveLength(0);
    const schedule = only(await db().admin<{ next: Date }>('select next_scan_at as next from private.automation_schedules where workspace_id=$1 and user_id=$2', [w.wsA, w.carol.id]));
    expect(new Date(schedule.next).toISOString()).toBe('2030-06-01T13:00:00.000Z');
  });
});

describe('reminder hour inside quiet hours', () => {
  it('plans the day’s reminders when quiet hours end instead of deferring them into tomorrow', async () => {
    const w = await buildWorld(db());
    ok(await db().affected(w.carol, `update public.notification_preferences set config='{"timezone":"UTC","quietStart":22,"quietEnd":7,"reminderHour":23}'::jsonb where workspace_id=$1`, [w.wsA]));
    const task = await createTask(db(), w.alice, w.wsA, { assigneeId: w.carol.id });
    await db().admin("update public.tasks set due_date='2030-06-01' where id=$1", [task]);
    await db().admin("update private.automation_schedules set next_scan_at='2030-06-01' where workspace_id=$1", [w.wsA]);
    await db().admin("select private.plan_automation('2030-06-01T06:30:00Z',500)");
    expect(await db().admin("select id from private.automation_jobs where task_id=$1 and kind='due_today'", [task])).toHaveLength(0);
    await db().admin("update private.automation_schedules set next_scan_at='2030-06-01' where workspace_id=$1", [w.wsA]);
    await db().admin("select private.plan_automation('2030-06-01T07:30:00Z',500)");
    const job = only(await db().admin<{ day: string; at: Date }>("select payload->>'localDate' as day, run_after as at from private.automation_jobs where task_id=$1 and kind='due_today'", [task]));
    expect(job.day).toBe('2030-06-01');
    expect(new Date(job.at).toISOString()).toBe('2030-06-01T07:30:00.000Z');
  });
});

describe('time-zone change', () => {
  it('retires the pending occurrence from the old zone so the new zone’s occurrence is planned, not swallowed', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.alice, w.wsA, { assigneeId: w.carol.id });
    await db().admin("update public.tasks set due_date='2030-06-01' where id=$1", [task]);
    await db().admin("update private.automation_schedules set next_scan_at='2030-06-01' where workspace_id=$1", [w.wsA]);
    await db().admin("select private.plan_automation('2030-06-01T12:00:00Z',500)");
    const original = only(await db().admin<{ id: string; key: string }>("select id, occurrence_key as key from private.automation_jobs where task_id=$1 and kind='due_today'", [task]));
    // Still waiting for delivery when the member moves to a zone with the same local date.
    await db().admin("update private.automation_jobs set run_after=now()+interval '1 hour' where id=$1", [original.id]);
    ok(await db().affected(w.carol, `update public.notification_preferences set config=config||'{"timezone":"Europe/London"}' where workspace_id=$1`, [w.wsA]));
    const retired = only(await db().admin<{ state: string; key: string }>('select state, occurrence_key as key from private.automation_jobs where id=$1', [original.id]));
    expect(retired.state).toBe('skipped');
    expect(retired.key).not.toBe(original.key);
    await db().admin("update private.automation_schedules set next_scan_at='2030-06-01' where workspace_id=$1", [w.wsA]);
    await db().admin("select private.plan_automation('2030-06-01T12:00:00Z',500)");
    const replanned = only(await db().admin<{ zone: string; key: string }>("select payload->>'timezone' as zone, occurrence_key as key from private.automation_jobs where task_id=$1 and kind='due_today' and state='pending'", [task]));
    expect(replanned).toEqual({ zone: 'Europe/London', key: original.key });
  });

  it('leaves jobs alone when a save keeps the same zone', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.alice, w.wsA, { assigneeId: w.carol.id });
    await db().admin("update public.tasks set due_date='2030-06-01' where id=$1", [task]);
    await db().admin("update private.automation_schedules set next_scan_at='2030-06-01' where workspace_id=$1", [w.wsA]);
    await db().admin("select private.plan_automation('2030-06-01T12:00:00Z',500)");
    ok(await db().affected(w.carol, `update public.notification_preferences set config=config||'{"reminderHour":10}' where workspace_id=$1`, [w.wsA]));
    expect(await db().admin("select state from private.automation_jobs where task_id=$1 and kind='due_today'", [task])).toEqual([{ state: 'pending' }]);
  });
});

describe('requeue after terminal failure', () => {
  async function terminalJob(w: Awaited<ReturnType<typeof buildWorld>>) {
    const task = await createTask(db(), w.alice, w.wsA);
    ok(await db().affected(w.alice, 'update public.tasks set assignee_id=$2 where id=$1', [task, w.carol.id]));
    const job = only(await db().admin<{ id: string }>("select id from private.automation_jobs where task_id=$1 and kind='assigned'", [task]));
    await db().admin("update private.automation_jobs set state='failed',attempts=5,failed_at=now(),last_error='delivery_failed' where id=$1", [job.id]);
    await db().admin("insert into private.automation_attempts(job_id,attempt,ended_at,outcome,error_code) select $1,n,now(),'failed','delivery_failed' from generate_series(1,5) n", [job.id]);
    return { task, job: job.id };
  }

  it('a state-only requeue is ignored instead of aborting every claim batch', async () => {
    const w = await buildWorld(db());
    const bad = await terminalJob(w);
    await db().admin("update private.automation_jobs set state='retry',run_after=now()-interval '1 minute' where id=$1", [bad.job]);
    const other = await createTask(db(), w.alice, w.wsA);
    ok(await db().affected(w.alice, 'update public.tasks set assignee_id=$2 where id=$1', [other, w.dave.id]));
    const jobs = await claim();
    expect(jobs.some((j) => j.task_id === other)).toBe(true);
    expect(jobs.some((j) => j.id === bad.job)).toBe(false);
  });

  it('the documented requeue statement delivers the job again and keeps the attempt log consistent', async () => {
    const w = await buildWorld(db());
    const bad = await terminalJob(w);
    // docs/automation.md, "Requeue a failed job".
    await db().admin("update private.automation_jobs set state='retry',attempts=0,failed_at=null,last_error=null,run_after=now(),claim_token=null,lease_until=null where id=$1 and state='failed'", [bad.job]);
    const job = (await claim()).find((j) => j.id === bad.job)!;
    expect(job).toBeDefined();
    const outcome = only(ok(await db().query<{ outcome: string }>('service', 'select public.finish_automation_job($1,$2,null) as outcome', [job.id, job.claim_token]))).outcome;
    expect(outcome).toBe('completed');
    const attempts = await db().admin<{ attempt: number; outcome: string }>('select attempt,outcome from private.automation_attempts where job_id=$1 order by attempt', [bad.job]);
    expect(attempts[0]).toEqual({ attempt: 1, outcome: 'completed' });
    expect(attempts).toHaveLength(5);
  });
});

describe('administrator outcomes keep member preferences private', () => {
  it('a preference skip reads as completed, with day-level creation and no delivery timing', async () => {
    const w = await buildWorld(db());
    ok(await db().affected(w.carol, `update public.notification_preferences set config='{"assignment":false,"quietStart":0,"quietEnd":0}'::jsonb where workspace_id=$1`, [w.wsA]));
    const task = await createTask(db(), w.alice, w.wsA);
    ok(await db().affected(w.alice, 'update public.tasks set assignee_id=$2 where id=$1', [task, w.carol.id]));
    const job = (await claim()).find((j) => j.task_id === task)!;
    expect(only(ok(await db().query<{ outcome: string }>('service', 'select public.finish_automation_job($1,$2,null) as outcome', [job.id, job.claim_token]))).outcome).toBe('skipped');
    const items = only(ok(await db().query<{ items: Array<Record<string, unknown>> }>(w.alice, 'select public.automation_outcomes($1) as items', [w.wsA]))).items;
    const row = items.find((item) => item.id === job.id)!;
    expect(row.state).toBe('completed');
    expect(row.run_after).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(String(row.created_at)).toMatch(/T00:00:00/);
    expect(items.some((item) => item.state === 'skipped')).toBe(false);
  });

  it('a quiet-hours deferral reads as pending, not as a retry', async () => {
    const w = await buildWorld(db());
    const task = await createTask(db(), w.alice, w.wsA);
    ok(await db().affected(w.alice, 'update public.tasks set assignee_id=$2 where id=$1', [task, w.carol.id]));
    const job = (await claim()).find((j) => j.task_id === task)!;
    // Quiet hours that cover the current UTC hour, set after the claim so delivery is deferred.
    const hour = new Date().getUTCHours();
    ok(await db().affected(w.carol, `update public.notification_preferences set config=jsonb_build_object('timezone','UTC','quietStart',$2::int,'quietEnd',$3::int) where workspace_id=$1`, [w.wsA, hour, (hour + 3) % 24]));
    expect(only(ok(await db().query<{ outcome: string }>('service', 'select public.finish_automation_job($1,$2,null) as outcome', [job.id, job.claim_token]))).outcome).toBe('deferred');
    const [raw] = await db().admin<{ state: string; last_error: string | null }>('select state, last_error from private.automation_jobs where id=$1', [job.id]);
    expect(raw).toEqual({ state: 'retry', last_error: null });
    const items = only(ok(await db().query<{ items: Array<Record<string, unknown>> }>(w.alice, 'select public.automation_outcomes($1) as items', [w.wsA]))).items;
    const row = items.find((item) => item.id === job.id)!;
    expect(row).toMatchObject({ state: 'pending', attempts: 0, run_after: null, last_error: null });
  });
});
