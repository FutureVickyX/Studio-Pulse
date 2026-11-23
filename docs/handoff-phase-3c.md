# Phase 3C: integration review, fixes and Phase 3 readiness

Branch `feat/phase-3c-integration`, based on `e792e54` (the head of PR #1, Phase 3B, which already
contains Phase 3A `7897fdd`). Date: 22 November 2026.

This document covers:

- the independent review of Phase 3A (analytics, Claude Code) and Phase 3B (automation, Codex) together;
- the isolated fixes made on this branch;
- the larger items handed to Codex;
- the Phase 3 readiness report.

## 1. Method

The whole repository was reviewed along eight dimensions:

- authorization and privileges (`db-authz`);
- job reliability and the scheduler state machine (`jobs-reliability`);
- trigger and regression interplay with Phases 1–2B (`triggers-regression`);
- the Edge worker and digest builder (`worker-digest`);
- the web UI (`web-ui`);
- analytics integrity against the time records (`analytics-integrity`);
- migrations and deployment (`migrations-deploy`);
- privacy and reporting honesty (`privacy-reporting`).

Each finding then went to two independent verifiers. One tried to refute it. The other reproduced it
against the code, mostly with PGlite probes using the real migrations.

**Result:** 33 findings, all 33 confirmed by reproduction, none rejected, plus one informational note:
1 critical, 5 high, 7 medium and 20 low.

## 2. Findings and status

"Fixed" means fixed on this branch with a regression test, unless the row says otherwise. "Hn" is a
Codex handoff item in §4.

| ID | Severity | Finding | Status |
|---|---|---|---|
| db-authz#0 | critical | Any member could stop planning for every tenant by saving a preference that PostgreSQL stores as a non-integer number (`9.0`) | **Fixed** (migration 14: canonical storage, defensive read, per-membership planner isolation; worker still claims when planning fails) |
| jobs-reliability#0 | high | Same root cause as db-authz#0, from the reliability side | **Fixed** |
| worker-digest#0 | high | A planner exception made the worker skip claiming, so one bad row stopped all delivery | **Fixed** (worker claims anyway, returns 503 `planning_failed` with counts) |
| web-ui#0 | high | Workspace rules could be saved only once; later saves failed with 42501 | **Fixed** (only the four switches are sent) |
| migrations-deploy#0 | high | Same defect as web-ui#0, from the grants side | **Fixed** |
| jobs-reliability#1 | medium | A reminder hour inside overnight quiet hours silently dropped that day's due-soon, due-today and overdue reminders | **Fixed** (planned for the end of quiet hours) |
| jobs-reliability#2 | medium | The documented requeue of a failed job aborted later claim batches for every tenant | **Fixed** (claim tolerates an existing attempt row and skips exhausted jobs; docs give the exact requeue statement) |
| web-ui#1 | medium | "Read summary" rendered the digest at the bottom of the page, with no focus or scroll | **Fixed** (modal `Dialog`) |
| web-ui#2 | medium | Each Realtime row event refetched the whole feed, so "Mark all read" caused a burst of requests | **Fixed** (250 ms coalescing) |
| analytics-integrity#0 | medium | Digest day boundaries come from the Edge runtime's ICU time zone data, Analytics from PostgreSQL's; they can differ | **Docs qualified**, real fix is **H1** |
| analytics-integrity#1 | medium | "Completed in period" dropped tasks completed in the period and later archived or reassigned | **Relabelled** ("Your tasks completed in period (still done)"), real fix is **H2** |
| privacy-reporting#0 | medium | Notices keep task titles and project names after rename or delete; nobody but an operator can remove them; jobs, attempts and cron history grow without limit | **Documented** (privacy.md, automation.md), real fix is **H3** |
| jobs-reliability#3 | low | A time-zone change skipped the pending occurrence and could re-plan it at the wrong local time | **Fixed** (pending calendar jobs from the old zone are retired) |
| jobs-reliability#4 | low | Lock-order deadlock between membership RPCs and delivery/planning | **H5** |
| jobs-reliability#5 | low | Worker reported a delivery that committed under a serialization retry as failed | **Fixed** (40001 is re-settled and counted correctly; one counts-only log line per run) |
| triggers-regression#0 | low | Worker RPCs lock member and schedule rows before the workspace row, the reverse of the membership RPCs | **H5** |
| triggers-regression#1 | low | 3B removed the live workspace suite's cleanup | **Fixed** (checked owner delete, sign-out in `finally`) |
| worker-digest#1 | low | Digest size was unbounded, so valid content could exceed the 100,000-byte delivery limit | **Fixed** (top 20 applications plus "Other applications (N)" rollup, 80-code-point text clipping, size safety net) |
| web-ui#3 | low | The keyset cursor truncated `created_at` to milliseconds and could skip notices | **Fixed** (cursor sent verbatim, format-checked) |
| web-ui#4 | low | After "Load older", each new notice hid one notice at the page boundary | **Fixed** |
| web-ui#5 | low | A shared action silently dropped the automatic mark-read | **Fixed** (per-row saving state, errors surfaced) |
| web-ui#6 | low | The client accepted a lower-case time zone that the server rejected | **Fixed** (both canonicalise case) |
| web-ui#7 | low | No unread indicator at phone widths | **Fixed** (bell with unread badge in the top bar) |
| web-ui#8 | low | The outcomes table skipped Phase 3A's accessible `DataTable` | **Fixed** (plus field-level validation errors in the settings form) |
| web-ui#9 | low | docs/workspace.md page list omitted Notifications and Automation | **Fixed** |
| analytics-integrity#2 | low | The worker's offset-paged time-entry read could skip an entry when rows were deleted mid-read | **Fixed** (keyset paging by id) |
| migrations-deploy#1 | low | handoff-phase-3a.md still said migration 10 was not applied | **Fixed** (dated status note) |
| migrations-deploy#2 | low | Shared docs described the pre-3B repository | **Fixed** (README, architecture, supabase docs) |
| migrations-deploy#3 | low | handoff-phase-3b.md recorded a Rust count (355/11) that did not match the unchanged tree | **Fixed** (rerun: 365 passed, 12 ignored; row corrected) |
| migrations-deploy#4 | low | `build:automation` relied on an undeclared `rolldown` | **Fixed** (declared `~1.2.13`; see §5.4 about the lock file) |
| privacy-reporting#1 | low | The administrator outcome report revealed members' opt-outs, quiet hours and summary hours | **Fixed** in migration 14; residual is **H4** |
| privacy-reporting#2 | low | Digest figures were labelled misleadingly | **Fixed** (labels say what is measured) |
| db-authz#1 | low | The private-table privilege test only checked SELECT | **Fixed** (every table and column privilege for anon, authenticated and PUBLIC, and no policies in `private`) |
| worker-digest (info) | info | Up to ten weekly digests share one invocation's CPU budget | **H6** |

## 3. Changes on this branch

### Database: migration 14, `20261119090000_automation_hardening.sql`

The migration only uses `create or replace function` plus two data-repair updates. There are no table,
policy or grant changes, and revokes are re-issued.

- **Canonical preferences.**
  - `private.validate_automation_preferences` stores integer settings as JSON integers.
  - It resolves time zones case-insensitively to their tz-database spelling.
  - `private.automation_config` reads defensively, truncating any stored number to an integer.
  - A one-off repair rewrites existing non-canonical rows.
- **Planner isolation.** `private.plan_automation` plans each membership in its own exception block. A
  failure logs a warning with the SQLSTATE only, pushes that schedule back one hour and continues.
- **Reminder hour inside quiet hours.** The effective reminder hour becomes the end of quiet hours.
- **Time-zone change.** Pending or retrying calendar jobs from the old zone are marked skipped, with a
  `:superseded:<id>` occurrence key, so the new zone's occurrence can be planned.
- **Requeue-safe claiming.** `public.claim_automation_jobs` ignores jobs with 5 attempts and upserts the
  attempt row.
- **Private outcomes.** `public.automation_outcomes`:
  - shows preference skips as `completed`;
  - shows quiet-hours deferrals (`retry` with no error) as `pending`;
  - returns no `run_after` or `completed_at`;
  - truncates `created_at` to the day.

### Worker and digest (`server/automation`)

- Planning failures no longer prevent claiming. The run returns 503 `planning_failed` with counts.
- A 40001 conflict on `fail_automation_job` re-settles through `finish_automation_job`.
- One counts-only JSON log line per run: no ids, titles or user data.
- Keyset paging (`id > last`, 1,000 rows) replaces offset paging.
- Digests are bounded under the delivery limit, and the application rollup keeps the totals consistent.

### Web (`apps/web`)

- Workspace rule saves send only the four switches.
- Exact notification cursor.
- Time-zone canonicalisation.
- Coalesced Realtime refresh.
- Notifications page:
  - per-row mark-read with surfaced errors;
  - correct "Load older" merging;
  - the digest opens in a dialog with honest labels.
- Top-bar bell with an unread badge.
- Automation page:
  - outcomes use the shared `DataTable`, with readable state and kind labels;
  - creation shows as a date only;
  - "Scheduled" is shown in place of private times;
  - field-level validation errors.

### Build, tests and docs

- `rolldown` is declared.
- The worker bundle banner no longer depends on rolldown's `banner` option.
- `check:secrets` has a narrow, tested allowlist entry for the worker bundle. Its two hits are
  supabase-js's key-format check and the runtime *name* `SUPABASE_SERVICE_ROLE_KEY`; no values.
- `build:automation -- --connector` builds a readable worker for the Supabase connector. Only this
  repository's code is bundled. supabase-js and zod, including any subpath, are pinned as `npm:`
  imports through rolldown's `paths`, which covers named, side-effect, re-export and dynamic imports.
  The output is checked in memory and written once. The build fails on any unpinned import or on more
  than one output file. The default build is unchanged, byte for byte.
- Live automation test: the burst polls for up to 150 s (was 110 s), with a 170 s test timeout. Setup
  re-saves the workspace settings after creating the first task, so a planning pass that ran in between
  can't delay `due_today` by 15 minutes (§5.2).
- Live workspace test: the Realtime test subscribes with `postgres_changes_options: { wait: true }`
  (supabase-js 2.118), so `SUBSCRIBED` means the postgres_changes subscription exists. The 1.5 s
  pause before the writes is gone; the 1.5 s wait afterwards, for a stray private event, stays. The
  test fails at once on `CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED` (transport errors count as
  `CHANNEL_ERROR` too), removes its channel even on failure, and has a 90 s timeout (§5.2, Realtime
  note).
- New tests:
  - `tests/integration/supabase/automation-hardening.test.ts`: 11 tests, all of which fail without
    migration 14 (checked by moving the migration out).
  - `tests/unit/web/automation-fixes.test.ts`: 9 tests.
  - additions to `automation-views.test.ts` and `secret-scan.test.ts`;
  - the widened `privileges.test.ts`, which was checked to fail on a stray column grant.
- Docs updated:
  - README.md and docs/architecture.md;
  - docs/supabase.md, docs/automation.md, docs/privacy.md and docs/workspace.md;
  - supabase/README.md;
  - tests/live/README.md;
  - handoff-phase-3a.md (status note) and handoff-phase-3b.md (Rust count).

## 4. Codex handoff

Each database change needs a **new forward migration** (H7 is client-only). Applied migrations must
not be edited. Keep the existing rules:

- RLS is never weakened;
- no privileged key in a client;
- `search_path = ''` on every function;
- `tests/integration/supabase/privileges.test.ts` stays exhaustive. Update its expectation lists for any
  new function, grant or policy.

### H1: digest day boundaries from PostgreSQL (analytics-integrity#0, medium)

- **Problem.** `buildDigest` and the worker compute local-day starts with the time-engine's ICU-based
  `startOfLocalDay` inside the Edge runtime. `analytics_time_summary` uses PostgreSQL's tz database. Where
  the two disagree, a digest's totals differ from Analytics for the same days. Known examples are
  America/Edmonton from 2026-11-02 and Africa/Casablanca from 2026-09-21; see docs/analytics.md.
- **Affected files.**
  - New migration:
    - factor the DST-gap-safe day-start expression of `analytics_time_summary`
      (`20261112090000_analytics.sql`, around lines 188–194 and 223–229) into
      `private.local_day_start(d date, tz text) returns timestamptz`, and use it in the RPC too;
    - add a service-role-only `public.automation_day_starts(p_time_zone text, p_from date, p_to date)
      returns jsonb`.
  - `server/automation/worker.ts`: use those instants for the `time_entries` window.
  - `server/automation/digest.ts`: use the same instants for `completedInPeriod` and pass them in.
  - `packages/time-engine/src/reconcile.ts` (`summarizeReport`) and `intervals.ts`: accept optional
    precomputed `dayStarts` in place of `startOfLocalDay`.
- **Expected behaviour.** A digest's period, per-day and total figures equal `analytics_time_summary`
  for the same user, zone and days, whatever the Edge ICU version.
- **Verification.**
  - A PGlite equality test in a diverging zone, for example Edmonton with an entry on 2026-11-10 between
    06:00 and 07:00Z.
  - Time-engine unit tests with and without `dayStarts`.
  - The full suite under `TZ=America/Los_Angeles`.
  - The hosted live automation test, repeated in a non-UTC zone.
  - Then restore the unqualified "matches Analytics" claim in docs/automation.md.

### H2: durable completion record (analytics-integrity#1, medium)

- **Problem.** `tasks_track_completion` clears `completed_at` when a task leaves `done`, archiving
  included. The worker also reads only tasks currently assigned to the recipient. So "completed in
  period" can only mean "still done and still yours". It is relabelled now.
- **Affected files.**
  - New migration with an append-only `private.task_completions(task_id, workspace_id, completed_by,
    completed_at)`, written by the tasks completion trigger. It must cascade on task delete. The
    alternative is a `completed_by` column preserved through archive.
  - `server/automation/worker.ts` and `digest.ts`: count completions by the recipient in `[from, to)`.
    Either bump `formatVersion` to 2 or add a new field.
  - `apps/web/src/views/NotificationsView.tsx`: label.
  - docs/automation.md and docs/privacy.md.
- **Decisions needed.**
  - Who gets the credit: the completer or the assignee at completion.
  - How reopen-then-redo counts. Recommendation: distinct tasks.
- **Verification.**
  - PGlite tests: complete then archive is counted; complete then reassign follows the chosen rule;
    deleting the task removes the record.
  - Digest unit test.
  - Privileges test: the table is in `private` with no client privileges.

### H3: notice retention, rename/delete propagation and pruning (privacy-reporting#0, medium)

- **Problem.**
  - Delivered notices keep task titles, project names and digest content after the underlying work is
    renamed or deleted.
  - Recipients cannot delete notices.
  - `private.automation_jobs`, `automation_attempts` and `cron.job_run_details` grow without limit.
    Hosted had 6,710 cron rows on 20 November, growing about 1,440 a day.
- **Affected files and changes** (new migration plus UI):
  - `notifications_task_id_fkey` becomes `on delete cascade`, matching `private.automation_jobs.task_id`.
  - Recipient delete:
    `create policy notifications_delete on public.notifications for delete to authenticated using
    (recipient_id = (select auth.uid()))` and `grant delete on public.notifications to authenticated`.
    Deleting the notice leaves the job `completed` with its occurrence key, so nothing is redelivered.
  - A `BEFORE DELETE` trigger on `public.projects` removes `payload->'projectName'` from non-digest
    notices. It must run before the FK set-null clears `project_id`.
  - A daily pg_cron prune:
    - read notices older than an agreed window;
    - attempt rows for finished jobs;
    - job payloads, while **keeping** the job rows (or a tombstone of `occurrence_key`) so occurrences
      are never redelivered;
    - `cron.job_run_details` older than about 14 days.
  - Optionally, show the live task title when the task is still readable.
  - `NotificationsView.tsx`: a per-notice "Delete" action that updates the list locally. Realtime is
    INSERT/UPDATE only.
- **Expected behaviour.**
  - Deleting a task removes its notices.
  - A recipient can delete only their own notices.
  - Old operational rows are pruned on a schedule, and occurrence de-duplication still holds.
- **Verification.**
  - PGlite tests: cascade; owner-only delete (another member gets 0 rows); no redelivery after delete;
    project-delete strips the name; the prune keeps tombstones.
  - Privileges test: the notifications DELETE grant and policy.
  - Docs: privacy.md, automation.md and supabase.md.

### H4: aggregate outcome report (privacy-reporting#1 residual, low)

- **Problem.** After migration 14, outcome rows no longer expose times or skips, but some inference is
  still possible:
  - an administrator can still match rows to events they caused;
  - the existence of daily, weekly, inactive and reminder rows shows that someone opted in.
- **Change.** Redefine `public.automation_outcomes` to return counts per kind and state over a window,
  plus failure entries limited to kind, failure day and error code. Update
  `apps/web/src/lib/automation.ts` (`AutomationOutcome`), `AutomationView.tsx`, the outcome tests in
  `automation-hardening.test.ts` and `automation-views.test.ts`, and the docs.
- **Decision needed.** Whether administrators need per-job rows for operations. Operators can always use
  SQL.

### H5: lock-order deadlock between membership RPCs and the worker (jobs-reliability#4, triggers-regression#0, low)

- **Problem.**
  - `remove_member` and `set_member_role` lock the workspace `FOR UPDATE`, then the member row.
  - `finish_automation_job` locks the member row `FOR SHARE`, then its notification insert needs
    `FOR KEY SHARE` on the workspace.
  - The planner holds schedule rows `FOR UPDATE` while its job inserts need `FOR KEY SHARE` on the
    workspace, and `remove_member`'s trigger deletes that schedule row.
  - PostgreSQL resolves the cycle by aborting one side with 40P01, usually the membership change.
- **Affected files.** A new migration with `create or replace` of:
  - `public.set_member_role` (`20261017090400_advisor_hardening.sql`, lock around line 147) and
    `public.remove_member` (around line 186): workspace lock `for update` becomes `for no key update`.
    This still serialises membership changes but no longer conflicts with FK `KEY SHARE`.
  - `public.promote_successor_owner` (`20261017090500_owner_succession.sql`, around line 36): the same
    change.
  - `public.finish_automation_job` (latest definition in `20261112120000_automation_foundation.sql`):
    after the claim checks and before the member `FOR SHARE`, add
    `perform 1 from public.workspaces where id = j.workspace_id for key share;`. Treat "not found" as
    skipped.
  - `private.automation_membership_schedule`: stop deleting the schedule row when a member leaves.
    `plan_automation` already filters `status = 'active'`, and the FK cascade removes it on a hard
    delete. The alternative is a `for update skip locked` delete.
  - Review `accept_invitation` against `remove_member` once the lock modes change. The verifier flagged
    a possible separate cycle through the invitation row, which was not verified.
- **Expected behaviour.** Concurrent `remove_member` or `set_member_role` and worker finish or planning
  never produce 40P01.
- **Verification.** PGlite has one connection and cannot run this. Use a real PostgreSQL with two
  connections, for example the Supabase CLI local stack or a disposable branch:
  1. Session A: `begin`, then lock the member row `FOR SHARE` the way finish does.
  2. Session B: `remove_member`.
  3. Session A: insert a notification.
  4. Expect no deadlock, and the finish to skip after B commits.
  5. Repeat for the planner path.
  6. The existing member and owner-succession suites must stay green.

### H6: Edge CPU budget for weekly digests (info)

- **Problem.** One invocation claims up to 10 jobs and builds every digest in sequence. Weekly digests
  for a team in one zone land in the same minute. Measured locally at about 20 µs per entry (14,000
  entries ≈ 281 ms); the hosted Edge CPU limit was not measured.
- **Change.** Measure first. Add `durationMs` to the existing counts-only `automation_run` log line. If
  needed, claim digest kinds in smaller batches, for example 2 per call.
- **Verification.** A disposable hosted workspace with synthetic heavy entries, timed at the weekly
  hour, then deleted.

### H7: web Realtime channels report `SUBSCRIBED` before they are live (hosted workspace suite, low)

No migration; this is a web-client change.

- **Problem.** Two web channels use Realtime, and they share one socket:
  - `watchWorkspace` in `apps/web/src/lib/realtime.ts`;
  - `useAutomationRefresh` in `apps/web/src/app/automation.ts`.

  `SUBSCRIBED` only means the channel joined. The server registers the postgres_changes subscription
  afterwards: on a cold Realtime tenant, 1.96 s later in one probe and over 2.1 s in the failed run,
  with random retries 1–3 s apart (§5.2, Realtime note). A teammate's change in that window is not
  delivered. Independently of the tenant, a page's first queries run before the channel exists:
  child effects run before `Shell`'s. So a change made between the first read and a live subscription
  is missed on a warm tenant too. That gap is short when warm.
  - `watchWorkspace` refreshes only on a later `SUBSCRIBED` (a reconnect), never the first. The page
    stays stale until the tab is hidden and shown again, the browser comes back online, the channel
    reconnects, or a later change to the same table arrives.
  - The notification feed refreshes 250 ms after `SUBSCRIBED`, which can be too early, and on its 60 s
    visible-tab timer.
- **Change (preferred).** Refresh when the subscription is confirmed, without holding the join:
  - On both channels, add `.on('system', {}, p => …)` and refresh when
    `p.extension === 'postgres_changes' && p.status === 'ok'`. The server sends "Subscribed to
    PostgreSQL" with or without `wait`; channel A in the §5.2 probe received it without.
  - Keep a refresh on the first `SUBSCRIBED` in `watchWorkspace` as well, for the warm-tenant gap.
- **Why not `wait`.** `postgres_changes_options.wait` holds each join inside the websocket's
  transport process for up to the wait timeout: 15 s by default, 20 s at most, plus about 5 s of
  back-off when it fails. Joins on one socket queue behind it. With two waiting channels on one
  socket, a failing tenant can hold the socket longer than realtime-js 2.118's 25 s join timeout and
  25 s heartbeat. Phoenix then rejoins errored channels on its own, and each rejoin waits again. If
  `wait` is used anyway:
  - put all bindings on one channel, so there is one wait per socket;
  - pass a short `postgres_changes_options.timeout`, for example 5 000 ms;
  - log `CHANNEL_ERROR` and `TIMED_OUT` but keep the channel, since Phoenix rejoins it, and refresh on
    the next `SUBSCRIBED`.
- **Verification.**
  - Unit tests for the confirmed-subscription refresh and the first-`SUBSCRIBED` refresh.
  - On hosted, a cold-tenant check with the web's real setup (both channels on one socket),
    recording both channels' confirmation times and that heartbeats keep getting replies.

## 5. Phase 3 readiness report

### 5.1 Completed features

- **Phase 3A, analytics:**
  - server-side `analytics_time_summary` with reconciliation matching the desktop time engine;
  - reports by day, week and month, project, task, application and member, with visibility rules;
  - unattributed-time reporting;
  - CSV exports;
  - project insights and task progress.
- **Phase 3B, automation:**
  - per-member notification preferences and workspace rules;
  - event notices: assignment, review, completion;
  - reminders: due soon, due today, overdue, inactive;
  - daily and weekly personal digests built with the Phase 3A reporting definitions;
  - an in-app notification feed with Realtime;
  - an administrator outcome report;
  - a pg_cron → pg_net → Edge worker pipeline that runs without the desktop app or a browser, with
    leased claims, de-duplication by occurrence key, exponential retry capped at 5 attempts, and
    quiet hours.
- **Phase 3C, integration:** the 28 fixes in §2, migration 14, the regression tests, and
  documentation brought in line with the code.

### 5.2 Tests and results

**Executed on this branch, 22 November 2026, Windows 11, Node via `node node_modules/...`. Global `npm`
is broken on this machine; see §5.4.**

| Check | Command | Result |
|---|---|---|
| TypeScript, 7 workspaces plus root | `tsc -p <project> --noEmit` for each | Passed, 0 errors |
| Full TypeScript/PGlite suite | `vitest run` | **64 files, 1,547 tests passed**, 0 skipped (before the follow-up below) |
| Same suite in a non-UTC zone | `TZ=America/Los_Angeles vitest run` | **64 files, 1,547 passed** |
| Final rerun after the outcome-masking follow-up | `tsc` (web and root), then `vitest run` | Passed; **64 files, 1,548 tests passed** (one new test); `automation-views` also passed under Los Angeles |
| Migration 14 regression tests, without the migration | same file, with the migration moved out | **11 of 11 failed**, as expected. The same-zone guard fails only in the whole-file run: the earlier isolation test leaves an unusable row that stops the unfixed planner for everyone, which is db-authz#0 itself |
| Widened privilege test against a stray grant | temporary migration granting `update(state)` on `private.automation_jobs` | Failed, as expected; the probe was removed |
| Web production build | `vite build` (apps/web) | Passed; the existing >500 kB chunk warning remains |
| Web bundle secret scan | `check-bundle-secrets.mjs apps/web/dist` | Passed: 7 files, only the allowlisted key-rejection rule |
| Worker bundle | `build-automation-worker.mjs` | Passed, 331 KB, gitignored |
| Worker bundle secret scan | `check-bundle-secrets.mjs supabase/functions/automation-worker` | Passed: only the two allowlisted references, no values |
| Desktop UI build | `vite build` (apps/desktop) | Passed |
| Rust tests | `cargo test` | **365 passed, 0 failed, 12 ignored by design** (9 interactive desktop, 1 Credential Manager, 2 live Supabase) |
| Rust lint and format | `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` | Passed |
| Hosted scheduler health (read-only SQL, 20 November) | `cron.job_run_details`, `net._http_response` | 1,440 runs in 24 h, 0 failed; 360 worker responses in 6 h, all HTTP 200; 13 migrations applied; 0 users, workspaces, jobs or notifications |

**Hosted deployment and verification, `studio-pulse-dev`, 22–23 November 2026 (times UTC):**

| Check | How | Result |
|---|---|---|
| Migration 14 | Applied through the Supabase connector with the file's exact content; version re-recorded as `20261119090000` | 14 migrations applied. The stored migration text is byte-identical to the committed file. Function fingerprints (`name(args)\|md5(source without CRs)\|security definer`) for all 49 `public`/`private` functions, freshly taken from hosted and from a fresh PGlite build, hash to the same digest (`a064b6a7…`). Without stripping CRs, 39 match byte for byte (see the line-ending note). Advisors unchanged |
| Worker v2 | `node scripts/build-automation-worker.mjs --connector`, deployed through the connector, then read back | Deployed source byte-identical to the local build (sha256 `5f485780…37bfede3`, 58 KB). The committed script reproduces it byte for byte; its default build is unchanged (`411f33aa…`, 331 KB). `check:secrets` on that build passed: one allowlisted service-role mention. `verify_jwt` false |
| First scheduled run on v2 | `cron.job_run_details`, `net._http_response`, function logs | 20:36: cron succeeded, HTTP 200 `{"completed":0,"skipped":0,"deferred":0,"failed":0}`, served by deployment version 2 (boot 85 ms; v1 took 259 ms), `automation_run` logged `planning: ok` |
| Live automation suite, run 1 | `tests/live/automation.live.test.ts`, three throwaway confirmed users provisioned by SQL (argon2id hashes made locally) | **5 of 5 passed** (157 s), scheduled runs only. The burst test passed by less than a second; see the timing note below |
| Live automation suite, run 2 | Same suite with the burst bound widened to 150 s; the operator queued two concurrent trusted invocations (the scheduler's own Vault-based call) once the burst existed | **5 of 5 passed** (33 s). The two invocations returned HTTP 200, completing 10 and 2 jobs with 0 failed |
| Scheduler health, deploy to 23 November 10:55 | Independent read-only re-check: `cron.job_run_details`, `net._http_response`, function logs | Job active (`* * * * *`). 859 of 859 runs succeeded. Function logs: 861 scheduler calls answered HTTP 200 by version 2, and 862 `automation_run` lines (860 scheduled plus the 2 operator calls), all with `failed` 0 and `planning: ok`. No error or warning lines. The only other responses were the two intended 401s for a user JWT. pg_net keeps response rows for only about 6 h, so the 360 rows still stored were checked directly (all 200, `failed` 0) and earlier ones come from the logs |
| Live automation suite, run 3 (23 November) | The final test file (150 s burst bound, setup re-save) with three new throwaway users. Scheduled runs only, no operator invocations | **5 of 5 passed** (161 s). The burst's last notice came 112.3 s after its last task. Under the old 110 s bound this run would have failed. Worker runs completed 4, 10 and 2 jobs, all HTTP 200 with `failed` 0 |
| Delivery records, all three runs | SQL over jobs and notices before each cleanup | Each run: 16 jobs, all completed on the first attempt with no error; 16 notices (13 assigned, 1 due today, 1 daily, 1 weekly), one recipient, no duplicates |
| Security advisor after the runs | `get_advisors` | Unchanged: lint 0029 for the nine intended RPCs, and lint 0008 (INFO) for the five policy-free `private` tables |
| Cleanup | SQL, after runs 2 and 3 | All three workspaces and all six throwaway users deleted. Every `public` and `private` table, plus `auth.users`, `identities`, `sessions`, `refresh_tokens` and `one_time_tokens`, is back to 0 rows; only the scheduler's key hash remains. The local credential files were deleted after each cleanup |
| Signed-in web build (23 November) | Production build of `b6311f7` (`vite build` with the hosted URL and publishable key; `check-bundle-secrets` passed, 7 files, only the allowlisted key-rejection rule), served by `vite preview` on 127.0.0.1. The user signed in as a throwaway owner of a fresh workspace that had no rules row and 55 seeded notices (all "assigned"; no digest notices and no automation jobs). The viewport width was not recorded | **Workspace rules saved twice; the user confirmed both changes persisted.** The first save found no row and inserted it (PATCH 200 matching nothing, then POST 201, 11:22:46). The second updated it (PATCH 200, 11:23:11). The stored row ended with automations and task events on and reminders and summaries off, matching the page after reloads. The session also loaded the notice list, fetched the older page once ("Load older") and marked notices read (all 55 read at the end). All 131 requests from the browser succeeded (125 × 200, 1 × 201, 1 × 204, 4 websocket upgrades) |
| Hosted workspace suite, run 1 (23 November) | `tests/live/workspace.live.test.ts` as committed in `b6311f7` (1.5 s pause after `SUBSCRIBED`, no `wait`), three new throwaway users | **6 of 7 passed.** The Realtime test received no events at all (`expected [] to include 'task:RT task'`). The run had just cold-started Realtime; see the Realtime note below. Its workspace was gone afterwards |
| Realtime diagnosis | Read-only SQL (`pg_replication_slots`, `pg_stat_activity`), Realtime and Postgres logs, the Realtime server source, and two probes with the same users and writes as the test (one warm, one on a tenant confirmed cold) | Cause found: on a cold tenant, `SUBSCRIBED` arrives before the server registers the postgres_changes subscription (Realtime note below). Test changed to use `wait` (§3) |
| Hosted workspace suite, run 2 (23 November) | The changed test, on a tenant confirmed cold first (Realtime shutdown logged, no replication slots, no Realtime connections at 11:52:45). The run's websocket started Realtime at 11:53:17 | **7 of 7 passed** (27 s; the Realtime test took 4.5 s, cold start included). Shared note and task delivered, private note not. `afterAll`'s checked owner delete (count 1) and sign-out passed, which verifies the corrected cleanup (triggers-regression#1) on hosted |
| Scheduler health after the checks | `cron.job_run_details`, `net._http_response` | 11:54: job active; the last 60 minutes had 60 runs, all succeeded, 60 responses, all HTTP 200 with `"failed":0` |
| Cleanup (23 November) | SQL | Every workspace from the checks was deleted (the browser check's by SQL, the suites' and probes' by their own owner deletes), then the three throwaway users. Across all `public` and `private` tables, `auth.users`, `identities`, `sessions`, `refresh_tokens`, `one_time_tokens`, `mfa_factors`, `flow_state` and `realtime.subscription` (26 tables), only `private.automation_worker_keys` has a row (the scheduler's key hash). The local credential files were deleted and the preview server stopped |

- **Line endings on hosted.** Ten functions applied in Phase 3B differ from the repository by raw
  `md5(prosrc)` only because they were applied with CRLF line endings and PostgreSQL keeps the CRs in
  the function source. With CRs removed they match. This is harmless and needs no action.
- **Stored migration text.** For five older migrations, the text stored on hosted differs from the
  repository files without any schema effect:
  - `20261024090000` has one comment line that was edited in the repository after it was applied;
  - four Phase 3A/3B migrations differ only by a trailing newline.

  A byte-exact migration comparison reports these five as different.
- **Burst timing.** The worker claims ten jobs a run, so without operator invocations the twelve-task
  burst needs two scheduled batches.
  - The first test (scheduled delivery) ends just after a cron minute, and tests 2–4 take about 6–7 s.
    So the burst lands about 9–10 s into a minute.
  - Its last notice then arrives one minute boundary plus a full minute later, about 110 s after the
    polling bound starts. The bound starts once all twelve tasks exist.
  - Run 1 passed with well under a second to spare: 110.24 s after the first burst task, against
    the 110 s bound. Run 3 needed 112.3 s.
  - The bound is now 150 s, with a 170 s test timeout (`tests/live/automation.live.test.ts`,
    `tests/live/README.md`).
  - Phase 3B's recorded run had queued the two invocations (handoff-phase-3b.md).
- **First-test setup race (fixed in the test, not observed).** A task insert does not reschedule
  planning. If a planning pass ran between enabling automation and creating the first task, it set
  the next scan 15 minutes ahead, and `due_today` would miss the 110 s bound. The window is one
  request in each minute. Setup now saves the workspace settings again after creating the task, which
  resets the scan.
- **Realtime on a cold tenant (workspace suite run 1).** The Realtime test failed because `SUBSCRIBED`
  came before the server's postgres_changes subscription existed.
  - Without `wait`, the Realtime server replies to the join first and registers the subscription
    afterwards. If its change-capture process is not ready yet, it tries again after a random 1–3 s,
    and can repeat (`realtime_channel.ex` on the supabase/realtime main branch; the hosted version was
    not checked). The poller drains the replication slot continuously and matches each change against
    the subscriptions that exist when it reads it. A change read before the subscription exists is
    dropped for that subscriber.
  - Realtime stops after about 10 minutes without clients ("Tenant has no connected users" in the
    Realtime log) and starts again on the next join. Run 1 started it at 11:14:32. The test writes at
    least 1.5 s after `SUBSCRIBED` (its pause), and the inserts were logged at 11:14:34.33–34.90. None
    arrived, so that run's gap was longer than about 2.1 s. The same steps on the warm tenant two
    minutes later delivered every shared write.
  - Cold-tenant probe, 11:40, after the logged shutdown at 11:35: two channels on one socket with the
    test's writes. Channel A (no `wait`) joined first, channel B (`postgres_changes_options.wait`)
    second. A's "Subscribed to PostgreSQL" message came **1.96 s** after its `SUBSCRIBED`, longer than
    the test's 1.5 s pause; B's came 1 ms after its own. Both channels received every shared note and
    task, and neither received a private note. This time A's retry came sooner than in run 1, so
    probably only the first write (the private note) fell in A's gap.
  - The change-capture slot was not the missing piece. In the probe Postgres logged its consistent
    point at 11:40:04.670, more than a second before either channel's `SUBSCRIBED`. In run 1 it was at
    11:14:32.503, well before the writes. With `wait`, `SUBSCRIBED` also means the subscription row
    exists, so later writes are captured and matched. Run 2 confirmed this on a cold tenant, writing
    straight after `SUBSCRIBED`.
  - The test now uses `wait` (§3). The same gap in the web client is H7.

**Not executed here (manual or environment-bound):**

- The rest of the signed-in browser checks. The 23 November session covered the web-ui#0 rule saves
  (insert, then update), the notice list, "Load older" and marking notices read, at an unrecorded
  width. Not covered:
  - the bell and unread badge at 390 px (web-ui#7), and any check at a known 1280 px width;
  - the digest dialog (web-ui#1): no digest notice existed;
  - the outcomes table with rows (web-ui#8): no jobs existed;
  - the field-level validation errors;
  - a new notice arriving after "Load older" (web-ui#4): none arrived.
- A cold-tenant check of the web client's Realtime channels (H7).
- Tauri release and NSIS installer build. The Rust tree and desktop code are unchanged since 3B, which
  recorded it.
- The 9 interactive-desktop Rust tests and the Windows manual checklist (docs/windows.md); the desktop
  is unchanged.
- `npm ci` against the edited `package-lock.json`, which is blocked by the broken global npm. The
  `rolldown` entry was added by hand and the installed version matches (1.2.13).
- Concurrency (H5), which needs real PostgreSQL with two connections.

### 5.3 Unresolved issues

- H1–H7 in §4. None blocks a controlled pilot. H3 should land before real users accumulate history.
- The web bundle is a single chunk of about 781 kB (224 kB gzipped). This was there before and is
  only a performance concern.
- No CI: there is no `.github/workflows`, so every check above is run by hand.
- Digest payload field `unassigned` is shown as "Unattributed active time". The field name is kept to
  avoid a `formatVersion` bump; handoff-phase-3b.md line 78 still says "unassigned".

### 5.4 Deployment requirements

In order:

1. **Merge.** Merge PR #1 (Phase 3B, which contains 3A) into `main`, then this branch. It is based on
   PR #1's head, so it merges cleanly on top.
2. **Database.** Apply `20261119090000_automation_hardening.sql` to the hosted project (`supabase db push`
   or the dashboard). It only replaces functions and repairs data, so it is safe on the current empty
   data set. Then run `supabase/automation/verify-scheduler.sql` and check advisors.
   **Done on `studio-pulse-dev`, 22 November.** Verified with the same queries: job active, run
   history, HTTP responses and job states (§5.2).
3. **Worker.**
   1. Run `npm run build:automation`.
   2. Run `npm run check:secrets -- supabase/functions/automation-worker`.
   3. Run `supabase functions deploy automation-worker --project-ref <ref> --no-verify-jwt`
      (docs/automation.md). Without the CLI, use the connector build and deploy described there.
   4. Confirm the next cron responses are HTTP 200 with `"failed":0`.

   **Done on `studio-pulse-dev`, 22 November: version 2, through the connector (§5.2).**
4. **Web.** Build with the production public configuration, then run `npm run check:secrets:web` and
   deploy `apps/web/dist`.
5. **Desktop.** No new release is required by Phase 3.
6. **Operations.**
   - Schedule the `cron.job_run_details` prune (docs/automation.md, "Retention and growth") until H3
     automates it.
   - Watch the counts-only `automation_run` log line and 503 `planning_failed` responses.
7. **This machine.** Global npm is missing `make-fetch-happen/lib/cache`, probably deleted by a cleanup
   tool. Reinstall Node/npm, then run `npm ci` to confirm the lock file.

### 5.5 Production readiness

- **Today, hosted:** migration 14 and worker v2 are live on `studio-pulse-dev` (22 November). That fixes
  the critical cross-tenant halt (db-authz#0) there. The live automation suite (22–23 November) and
  the live workspace suite (run 2, 23 November) pass against it. The rule-save failure (web-ui#0) is a
  web-client fix. A local production build of this branch saved rules correctly against hosted, but
  the fix stays undeployed until the web app is deployed (step 4, after merging). After the
  23 November cleanup the project again has no users or data, so nothing has been exposed.
- **After steps 1–4 and the remaining signed-in checks (§5.2):** ready for a **controlled pilot**
  with known users. All high and critical findings are fixed and tested, the scheduler has run
  cleanly, and the automated suites pass.
- **General production:** wait for:
  - H3 (retention and deletion: a privacy obligation once real data accumulates);
  - H5 (rare, but it fails membership administration);
  - a CI pipeline running the checks above;
  - H1 if users are in zones where ICU and PostgreSQL disagree.

### 5.6 Recommended Phase 4 scope

1. Land H1–H5 and H7 with their tests, and H6 measurement, as one hardening slice.
2. Add CI that runs typecheck, Vitest (UTC and one non-UTC zone), the web and worker builds with
   secret scans, and the Rust test and lint.
3. Add a real-PostgreSQL concurrency harness, for example the Supabase CLI local stack, for H5-type
   tests.
4. Operational alerting on worker failures and `planning_failed`, built on data already recorded.
5. Code-split the web bundle.

No new product features are recommended until 1–3 are done.
