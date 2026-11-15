# Phase 3B implementation and verification

Date: 15 November 2026. Branch: `feat/phase-3b-automation`, isolated worktree
`studio-pulse-automation`, based on Claude's Phase 3A commit `7897fdd`.

## Delivery status

The implementation is built and verified on **studio-pulse-dev**. Supabase's deployment
confirmation completed: migrations 10–13 are applied, Edge worker version 1 is active, and the
named minutely cron job has successful runs, HTTP 200 responses and confirmed deliveries.
Phase 3A's missing analytics migration is applied; its `SECURITY INVOKER` property was verified
in the hosted catalog. The other Supabase project was not modified. This is verification of
the development deployment, not a claim that a separate production environment was deployed.
**At final verification, the project became unreachable:** both Auth health and REST requests
timed out, as did the database connector. Current hosted availability and test-data cleanup
therefore remain unconfirmed despite the earlier successful scheduled deliveries.

## Changes and reused systems

| Area | Files |
| --- | --- |
| Database models and validation | `packages/database/src/automation.ts`, `types.ts`, `schema.ts`, `index.ts` |
| Ordered migrations | `supabase/migrations/20261112120000_automation_foundation.sql`, `20261112120100_automation_scheduling.sql`, `20261112120200_automation_scheduler_extensions.sql` |
| Server worker and personal reports | `server/automation/entry.ts`, `worker.ts`, `digest.ts` |
| Deployment | `scripts/build-automation-worker.mjs`, `supabase/config.toml`, `supabase/automation/install-scheduler.sql`, `verify-scheduler.sql`, root `package.json`, `.gitignore` |
| Client data/refresh | `apps/web/src/lib/automation.ts`, `apps/web/src/app/automation.ts` |
| Interface | `apps/web/src/views/NotificationsView.tsx`, `AutomationView.tsx`, `app/App.tsx`, `app/Shell.tsx`, `lib/router.ts`, `styles/web.css`, shared `icons.tsx` |
| Tests | `tests/integration/supabase/automation.test.ts`, `anon.test.ts`, `privileges.test.ts`, `harness.ts`; `tests/unit/web/automation.test.ts`, `automation-views.test.ts`; `tests/live/automation.live.test.ts`, `workspace.live.test.ts`, live README |
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
| Real signed-in Chrome at both widths | Notifications, summary reading, personal preferences and Analytics loaded authorized server records; no horizontal overflow or runtime exceptions |
| Hosted automation tests | **5 passed across two runs**: four scheduled/privacy/reporting/security checks, plus one focused concurrent-worker check (the other four were intentionally filtered in that second run) |
| Concurrent trusted worker HTTP requests | Both returned 200, completing 10 and 6 jobs with zero failures; twelve burst tasks each received one unique assignment notice |
| Scheduler with no desktop/browser trigger | Repeated cron runs succeeded; HTTP returned 200; assignment, due-today, daily and weekly notifications were confirmed in the database |
| Hosted digest equality | Both daily/weekly foreground, active and idle totals matched the authenticated Phase 3A RPC, including a two-device overlap and unassigned time |
| Latest optional-extension migration | Applied on hosted PostgreSQL; the local automation suite reran **19/19 passed** |
| Older seven-test workspace live regression suite | **Not passed**: setup was blocked by hosted Auth 504 `request_timeout` / context-deadline errors; no assertions ran. Sequential fixture sign-in did not resolve it. Existing local workspace regressions passed in the full suite |
| Adversarial test mutation | Removing recipient isolation caused the privacy test to fail; original policy restored |
| Hosted Phase 3A migration | Applied; catalog confirms invoker execution |

The first broad run occurred while the worker authentication contract was being updated and
reported six stale-test/catalog expectations; these were fixed and the subsequent full run
passed. No assertion was removed or test skipped to obtain that result. There is no configured
JavaScript lint command in this repository; strict type checks and the existing Rust lint gate
were run. Timing measurements are not used to claim a performance improvement or regression.

Hosted advisors were reviewed. Five private-table “RLS enabled, no policy” informational findings
are intentional default denial, verified by privilege tests. Nine signed-in definer RPC warnings
include the existing membership operations and the explicitly admin-authorized outcome report;
none of the worker RPCs is granted to ordinary users. See the
[definer-function advisory](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
The remaining Auth setting is
[leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection),
which must be enabled in the dashboard where the plan supports it. Performance advisors reported
only unused-index information on this almost-empty development database; no index was removed.

## Hosted setup and remaining manual checks

The development project has migrations recorded under their repository versions, the deployed
worker, Vault URL/limited credential/hash, and the active `studio-pulse-automation` schedule.
No additional client key or manually supplied Edge secret was required. Signed-in checks used
three disposable confirmed accounts and server-backed records. The scoped account/workspace
cleanup request timed out; its commit cannot be confirmed and must not be assumed either way.
The local credential file was removed and the isolated test browser closed. The ignored local
`.claude/phase3b-cleanup.mjs` retains only the exact disposable IDs and the idempotent cleanup SQL,
without credentials. Rerun it through the development-project database connector once healthy,
then verify zero remaining test accounts/workspaces/notifications. Keep the scheduler installed.

The older workspace live suite should be rerun when Auth and database access are healthy. Its later setup timeouts do
not invalidate the earlier five passing automation checks or signed-in browser checks, but the
broader live regression acceptance remains incomplete. No retries or suppressed assertions were
added to make that suite appear green.

For another environment, follow [automation.md](automation.md): apply migrations, build/deploy
the worker, set the public URL in Vault, run the installer and require cron success, HTTP 200 and
an actual recipient notification before calling it active. Existing web hosting remains a separate
deployment; no hosting provider or paid delivery channel was introduced.

The real Windows startup/reboot, sleep and target-app manual checklist was not rerun; native
foreground/idle checks and all local regression tests passed, and those implementations are unchanged.

## Limits and next step

Delivery is in-app only; daily/weekly summaries and completion notices are opt-in. Web read-state
and settings mutations require a connection; received notifications remain in memory, not in a
new persistent offline store. Scheduled times follow local calendar hours with bounded scanning
and may be delayed by load or hosting interruption. Digests cover complete prior local periods,
do not backfill missed days and do not rewrite themselves for late offline uploads. Upcoming work
is capped at 20 items, project progress at 100; overlarge time inputs fail rather than silently
truncate. Retention and deliberate failed-job replay remain trusted operator actions.

The next step is recovery of development-project availability, confirmation of scoped test cleanup
and rerunning the older live suite. Then review/merge the feature branch and deploy the updated
static web bundle to the chosen workspace host. Later consider optional consented external delivery and
retention tooling, keeping application time distinct from billable work.
Full setup and manual workflow steps are in [automation.md](automation.md).
