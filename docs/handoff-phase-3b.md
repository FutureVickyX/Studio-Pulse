# Phase 3B implementation and verification

Date: 15 November 2026. Branch: `feat/phase-3b-automation`, isolated worktree
`studio-pulse-automation`, based on Claude's Phase 3A commit `7897fdd`.

## Delivery status

The implementation is built and locally verified. **Hosted automation acceptance is pending
Supabase's separate deployment confirmation.** Earlier automation migration requests expired
without applying; they were not treated as successful. No scheduler is claimed operational.
Phase 3A migration 10 **was applied** to `studio-pulse-dev` and its `SECURITY INVOKER` property
was verified in the hosted catalog. The other Supabase project was not modified.

## Changes and reused systems

| Area | Files |
| --- | --- |
| Database models and validation | `packages/database/src/automation.ts`, `types.ts`, `schema.ts`, `index.ts` |
| Ordered migrations | `supabase/migrations/20261112120000_automation_foundation.sql`, `20261112120100_automation_scheduling.sql` |
| Server worker and personal reports | `server/automation/entry.ts`, `worker.ts`, `digest.ts` |
| Deployment | `scripts/build-automation-worker.mjs`, `supabase/config.toml`, `supabase/automation/install-scheduler.sql`, `verify-scheduler.sql`, root `package.json`, `.gitignore` |
| Client data/refresh | `apps/web/src/lib/automation.ts`, `apps/web/src/app/automation.ts` |
| Interface | `apps/web/src/views/NotificationsView.tsx`, `AutomationView.tsx`, `app/App.tsx`, `app/Shell.tsx`, `lib/router.ts`, `styles/web.css`, shared `icons.tsx` |
| Tests | `tests/integration/supabase/automation.test.ts`, `anon.test.ts`, `privileges.test.ts`, `harness.ts`; `tests/unit/web/automation.test.ts`, `automation-views.test.ts` |
| Documentation | `docs/automation.md`, `phase-3b-plan.md`, this report; README, architecture, privacy, Supabase setup and testing docs |

Reused: Supabase identity and membership roles, existing RLS helpers and client factory,
workspace routing/query cache, Realtime, shared design components, Phase 3A `summarizeReport`
and its pure task/project report builders. No separate state framework, backend provider,
monitoring product or messaging service was introduced. Rust tracking, startup, SQLite and
the desktop synchronization engine were not changed by Phase 3B.

## Jobs, triggers and authorization

Task insert/update creates assignment, review and optional completion jobs with generation-based
occurrence keys. Narrow membership, comment and settings triggers maintain planner cursors and
activity. The bounded planner enqueues local-calendar due soon/today/overdue, waiting-review,
opt-in inactivity and daily/weekly summaries. All delivery is through leased, token-checked,
service-only RPCs. Delivery commits a stable notification ID and completion state together;
five failures end retries, and expired claims are recoverable.

Public RLS policies protect recipient-only notifications and preferences, and member-readable,
admin-writable workspace switches. Clients can update only a notification's read timestamp.
Private jobs/attempts/cursors/generations/key hashes have RLS and no client privileges. Safe
administrator outcome metadata is an explicitly authorized RPC. Worker authorization accepts
only a registered limited invocation key verified through a service-only RPC. Existing Phase 3A
reporting and other workspace policies were not widened.

## Executed checks

| Check | Actual result |
| --- | --- |
| Full TypeScript suite, `npx vitest run --maxWorkers=2` | **1,520 passed, 61 files** |
| Additional notification/settings rendering tests | **5 passed**; fixtures confined to tests |
| Final preference hardening + worker/view rerun | **13 passed**; a prototype-key validation regression was first reproduced, then fixed |
| Full workspace/root TypeScript checks | Passed |
| Rust regression suite | Passed: **355 tests**, **11 live tests ignored** by default |
| Rust formatting and Clippy `--all-targets -- -D warnings` | Passed |
| Real Windows foreground, native idle and interactive-session tests | **3 passed**, explicitly run despite their default ignored status |
| Web production build with public dev configuration | Passed; existing large-chunk/config-loader warnings remain |
| Windows Tauri release and NSIS installer build | Passed; output under the external build cache |
| Full desktop/web bundle secret scan | Passed: **51 files, 21.5 MB**, no secrets; only existing narrowly allowlisted key-rejection references |
| Final web bundle scan after preference hardening | Passed: **7 files**, no secrets |
| Self-contained Edge worker build/bootstrap | Passed; no unresolved imports; unconfigured bootstrap safely returned 503 |
| Worker bundle credential-pattern scan | Passed; no credential leaks |
| Production app in isolated Chrome, 1280 px and 390 px | Sign-in screen rendered, labels present, no horizontal overflow or runtime exception |
| Adversarial test mutation | Removing recipient isolation caused the privacy test to fail; original policy restored |
| Hosted Phase 3A migration | Applied; catalog confirms invoker execution |

The first broad run occurred while the worker authentication contract was being updated and
reported six stale-test/catalog expectations; these were fixed and the subsequent full run
passed. No assertion was removed or test skipped to obtain that result. There is no configured
JavaScript lint command in this repository; strict type checks and the existing Rust lint gate
were run. Timing measurements are not used to claim a performance improvement or regression.

## Remaining hosted verification and configuration

Supabase requires confirmation to apply migrations 11/12. After approval:

1. Apply both migrations in order and record their repository versions in migration history.
2. Deploy the generated Edge function, preserving its custom authentication mode.
3. Set the public project URL in Vault and run the idempotent scheduler installer. It generates
   a limited key internally; no additional Edge secret or client environment variable is needed.
4. Create dedicated throwaway users/workspaces and test authenticated direct API isolation,
   assignment/review/read state, reminders, personal daily/weekly digest totals, true concurrent
   claims and scheduled HTTP delivery with desktop/browser clients closed.
5. Verify cron execution **and** HTTP 200 **and** a confirmed notification. Then remove test
   users/data. No throwaway hosted users or workspaces were created during the local-only checks.

Signed-in hosted notification workflows, genuine concurrent PostgreSQL claims, actual digest
totals against the hosted analytics RPC and a scheduled Edge execution remain **unexecuted**.
The real Windows startup/reboot, sleep and target-app manual checklist was not rerun; native
foreground/idle checks and all regression tests passed, and those implementations are unchanged.

## Limits and next step

Delivery is in-app only; daily/weekly summaries and completion notices are opt-in. Web read-state
and settings mutations require a connection; received notifications remain in memory, not in a
new persistent offline store. Scheduled times follow local calendar hours with bounded scanning
and may be delayed by load or hosting interruption. Digests cover complete prior local periods,
do not backfill missed days and do not rewrite themselves for late offline uploads. Upcoming work
is capped at 20 items, project progress at 100; overlarge time inputs fail rather than silently
truncate. Retention and deliberate failed-job replay remain trusted operator actions.

The next step is the hosted acceptance sequence above. After that, consider optional consented
external delivery and retention tooling, keeping application time distinct from billable work.
Full setup and manual workflow steps are in [automation.md](automation.md).
