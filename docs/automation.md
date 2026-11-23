# Workflow automation (Phase 3B)

## What runs

The workspace has **Notifications** and **Automation settings**. Delivery is in-app only. No
email provider, desktop notification permission, Windows service or running browser is required.
The scheduler must be deployed separately; saving preferences does not activate hosting.

| Rule | Recipient | Default |
| --- | --- | --- |
| Task assigned/reassigned | New assignee, unless they made the assignment | On |
| Task enters review | Existing project lead, unless they made the transition | On |
| Task completed | Task creator, unless they completed it | Off |
| Due soon / today / overdue | Current assignee | On |
| Waiting review | Current project lead | On, after two calendar days |
| Inactive task | Current assignee | Off, after seven days; at most weekly |
| Daily / weekly summary | Individual member | Both off |

There is no reviewer role or mention parser added. Comments update task activity; they do not
notify the whole team. Self-assignment is intentionally quiet. Archiving work stops ordinary
reminders without deleting history. Assignment and review events from before installation are
not replayed.

Personal preferences are per workspace: rule toggles, IANA time zone, reminder hour, due-soon
days (1–14), overdue interval (1–30 days), review/inactivity thresholds (1–30 days), digest hour
and weekly day, and quiet hours. Initial time zone is explicitly UTC; select your own zone.
Quiet hours default to 22:00–07:00; equal endpoints disable them. A reminder hour that falls inside
quiet hours takes effect when quiet hours end (for example 23:00 with quiet hours 22:00–07:00
plans that day's reminders at 07:00). Workspace owners/admins can
disable all automation, events, reminders or digests. They cannot edit another person's preferences.

## Data and authorization

Apply the existing migrations in order, including Phase 3A's
`20261112090000_analytics.sql`, then:

1. `20261112120000_automation_foundation.sql`: preferences, workspace rules, recipient-owned
   notifications; private jobs, attempt logs, schedule cursors, task generations and worker-key
   hashes; event triggers and service-only worker operations.
2. `20261112120100_automation_scheduling.sql`: bounded calendar planner, comment activity,
   settings invalidation, and notifications in the existing Realtime publication.
3. `20261112120200_automation_scheduler_extensions.sql`: optional hosting extensions and queue
   access restrictions. Portable test databases without these extensions skip them; no job is
   activated until the explicit installer runs.
4. `20261119090000_automation_hardening.sql` (Phase 3C): canonical preference storage (integer
   settings as integers, tz-database zone spelling, read defensively), per-membership isolation in
   the planner, reminders inside quiet hours, retirement of pending calendar jobs after a time-zone
   change, requeue-safe claiming, and a privacy-preserving outcome report. Functions only.

RLS requires both the addressed user and active workspace membership to read notifications.
Authenticated clients can update only `read_at`. They cannot insert or delete system notices,
change a recipient, read jobs/keys, or execute worker operations. Preferences are owner-only.
Workspace rule writes and the safe outcome report require owner/admin authorization. The latter
includes job type, state, attempts, creation day, failure time and error code, with no recipient,
title or private payload. Preference skips read as completed, quiet-hours deferrals as pending, and
no next-eligible or completion time is returned, so it does not reveal members' opt-outs or quiet hours (migration 14).
Private tables have RLS and no client privileges. Existing task, note and reporting policies are
unchanged. Personal notes are never read by automation.

The Edge runtime's built-in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` stay server-side.
The worker requires an independent 256-bit invocation credential. Only its SHA-256 hash is
stored in `private.automation_worker_keys`; the raw credential lives in Vault. The Edge handler
verifies it through a **service-role-only** RPC before planning or claiming work. Ordinary user
JWTs and publishable keys cannot invoke jobs. `verify_jwt = false` is necessary because the
handler performs this narrower authentication itself; it does not mean anonymous job access.

No extra client environment variable is needed. Keep the existing Vite public configuration.
Never put a service credential or scheduler credential in a `VITE_` variable, distributed app,
source file, URL query string, log, screenshot or chat.

## Deployment

Use the dedicated `studio-pulse-dev` project (`rbvuqdyktfiaxcunioyv`) for verification. Do not
apply these operations to unrelated projects. Migration deployment uses the existing
[Supabase setup](supabase.md). Check the installed CLI's `--help` before running commands.

```powershell
npm ci
npm run typecheck
npm run build:automation
npm run check:secrets -- supabase/functions/automation-worker
supabase functions deploy --help
supabase functions deploy automation-worker --project-ref rbvuqdyktfiaxcunioyv --no-verify-jwt
```

The build emits `supabase/functions/automation-worker/index.ts` from `server/automation` and
the existing Phase 3A modules. It bundles dependencies, embeds no configuration values, and
fails on unresolved imports. The generated file is ignored and must be built before deploying.
`supabase/config.toml` also records the handler's authentication mode.

Without the CLI, deploy through the Supabase connector, which takes the source inline. Build the
connector variant instead:

```powershell
npm run build:automation -- --connector
npm run check:secrets -- supabase/functions/automation-worker
```

It writes the same ignored file, unminified, with only this repository's code (about 58 KB instead of
about 330 KB). `@supabase/supabase-js` and `zod`, including any subpath, stay as `npm:` imports pinned
to the exact installed versions, which the Edge runtime resolves at deploy time. The build fails if the
output imports anything else. Deploy it as `automation-worker` with entrypoint `index.ts` and `verify_jwt: false`. Then read
the function back and compare it byte for byte with the local file, and check the next cron response
(below). Rebuild without `--connector` before a CLI deploy.

In the project's trusted SQL editor, set only the public project URL in Vault (once):

```sql
select vault.create_secret(
  'https://rbvuqdyktfiaxcunioyv.supabase.co',
  'studio_pulse_automation_url'
);
```

Run [install-scheduler.sql](../supabase/automation/install-scheduler.sql) as the database operator.
After migration 13 makes `pg_cron`/`pg_net` available, it generates the limited key inside the database, stores it in Vault,
registers its hash and installs the named job `studio-pulse-automation`, once per minute.
Rerunning replaces the same job rather than adding a second schedule. It requires no extra Edge
secret or paid delivery service. Revoke old hashes when deliberately rotating the Vault key;
changing the key and rerunning the installer alone keeps old hashes valid until removed.

Supabase documents [Cron](https://supabase.com/docs/guides/cron) and
[scheduled Edge calls with Vault](https://supabase.com/docs/guides/functions/schedule-functions).
`pg_net` temporarily queues decrypted HTTP headers. This installation queues only the limited
invocation credential and denies `anon`/`authenticated` access to request/response tables.
Trusted database operators can still inspect Vault and that queue; treat database login access
as privileged. The service-role key never enters the cron command or HTTP queue.

## Verify hosting, then enable summaries

Run [verify-scheduler.sql](../supabase/automation/verify-scheduler.sql). Confirm all of:

1. The named cron job is active and has a successful scheduled run.
2. Its HTTP response is 200 with `"failed":0` in the counts. Cron success alone only proves the
   HTTP request was queued. A 503 with `planning_failed` means planning failed but already-queued
   jobs were still delivered; check the Postgres log for the SQLSTATE and the job states query.
3. An authorized test member receives exactly one notice when another member assigns a task.
4. A repeat worker run leaves the same notification ID and no duplicate record.
5. Another member and a nonmember cannot read the recipient's notice through the Data API.
6. Enable a test member's daily and weekly digests, set the schedule to an eligible local hour,
   and verify their stored totals against Analytics for the same complete calendar period.
7. Close all desktop/browser clients and observe a later scheduled delivery.

Delete throwaway test workspaces and users afterwards. Do not delete real team work.

To stop scheduling without changing recorded data:

```sql
select cron.unschedule('studio-pulse-automation');
```

Workspace switches also prevent delivery, but do not uninstall the scheduler. A failed
deployment should leave the client working with a useful migration/setup error.

## Reliability and time semantics

Task changes enqueue in the task transaction. Stable occurrence keys deduplicate events and
calendar reminders. The notification ID equals the job ID. A remotely committed delivery with
a lost response is therefore safe to retry. Claims use `FOR UPDATE SKIP LOCKED`, a unique claim
token and a five-minute lease. Expired claims are recovered in bounded batches; stale workers
cannot deliver. A delivery, its final state and attempt outcome commit together.

Five failed execution attempts are allowed, with exponential delays starting at 60 seconds.
After the fifth, the job is terminal `failed`; there is no unbounded retry loop. Safe failure
codes are stored instead of exception messages. Quiet-hour postponement does not consume a
failure attempt. Authorized SQL tooling can inspect attempt logs and deliberately requeue a
failed job after fixing its cause; the client offers no privileged replay endpoint. The supported
requeue statement (run as the database operator; the attempt log is kept and attempt numbers
restart from 1):

```sql
update private.automation_jobs
   set state='retry', attempts=0, failed_at=null, last_error=null, run_after=now(),
       claim_token=null, lease_until=null
 where id = '<job id>' and state = 'failed';
```

A row set back to `retry` without resetting `attempts` is ignored by claiming rather than
blocking other jobs.

The planner isolates each membership: if one member's schedule cannot be planned, that schedule is
retried an hour later (the Postgres log records only the SQLSTATE) and every other member is
still planned. If the planning call itself fails, the worker still claims and delivers queued
jobs, then answers 503 `planning_failed` with its counts. Each run writes one log line with
counts only. A delivery that committed but lost its response is counted as delivered.

Every delivery rechecks membership, preferences, workspace switches, current task/project
state and relevant task generation. Reassignment, rescheduling, completion, archive or removed
membership invalidate stale work. Changing your time zone retires your pending calendar jobs from
the old zone, and the next planner pass plans them again in the new zone. Date-only due dates use the recipient's local calendar,
including DST. Overdue intervals are calendar days since the first overdue day. The planner
scans at most 100 memberships per invocation and 1,000 tasks per member with continuation
cursors. Normal rescans are 15 minutes apart; large task sets continue on the next minute.
The worker claims at most ten jobs per call. Delivery time is approximate under backlog.

Daily digests cover the **previous complete local day**; weekly digests cover the previous seven
complete local days. Current task progress is labelled as a generation-time snapshot. "Your tasks
completed in period (still done)" counts tasks assigned to you that were completed in the period
and are still done when the summary is generated: a task archived, reopened or reassigned before
then is not counted. "Your tasks by project" counts only your assigned tasks, not the project's.
"Unattributed active time" is time with no project and no task, as in Analytics. The
server reads only the claimed recipient's tasks and time in that workspace and uses Phase 3A's
`summarizeReport` and task/project builders. Active wins overlapping idle; interval precedence,
calendar clipping and totals match Analytics for the same day boundaries. The worker computes day
boundaries with the Edge runtime's time zone data while Analytics uses Postgres's, so in a zone
whose rules the two disagree on (see [analytics.md](analytics.md)) a summary's day edges, and so
its figures, can differ from Analytics. The hosted equality check ran in UTC. Foreground, active and idle are labelled separately.
There are no billable/manual measurements invented. Overdue/upcoming tasks are capped at 20 and
project progress at 100; time input is never silently truncated (over 100,000 rows fails visibly).
Late offline uploads are reflected in subsequent reports, not retroactively rewritten digests.
The existing authenticated reporting RPC remains `SECURITY INVOKER`.

## Offline and operational limits

Windows tracking, startup, local SQLite and time synchronization are unchanged. Received
notifications remain visible in the current signed-in page's memory alongside a network error.
New loads, preference changes and read actions require connectivity; read changes are confirmed
by the server and are not queued or falsely marked saved. No persistent notification cache is
added. Reconnect, tab focus, Realtime and a 60-second refresh reconcile server state. Account and
workspace changes remount the view and clear the existing query cache on sign-out.

There is no general automation builder, mention parsing, external delivery, missed-day backfill,
employee ranking or productivity score. Paused/unavailable Supabase hosting cannot execute jobs;
leases recover interrupted processing after the service returns. Completed job/notification
retention is currently operator-managed; retain occurrence tombstones when pruning so replay
cannot recreate an already-delivered occurrence. Nothing prunes automatically: notifications,
`private.automation_jobs`/`automation_attempts` and pg_cron's `cron.job_run_details` (about
1,440 rows a day for the minutely job) all grow until an operator removes old rows. Delivered
notices keep the task title and project name from delivery time, even after a rename or delete,
and recipients cannot delete individual notices yet.

## Local checks

```powershell
npm run typecheck
npx vitest run --maxWorkers=2
npm run build:automation
npm run check:secrets -- supabase/functions/automation-worker
npm run build:web
npm run check:secrets:web
```

The SQL integration suite applies every migration with authenticated users, separate workspaces,
and a separate service role. It covers privacy, privileges, events, stale transitions, retries,
lease recovery, quiet hours, local dates, digest deduplication and rule controls. Worker tests
verify authorization and safe errors. Digest tests compare canonical Phase 3A totals. PGlite
serializes database access: it verifies claim semantics but does not prove genuine concurrent
PostgreSQL execution. Use independent hosted requests for that acceptance check. Actual results
and outstanding checks belong in [the completion report](handoff-phase-3b.md).
