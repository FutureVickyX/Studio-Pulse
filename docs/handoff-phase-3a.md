# Studio Pulse — Phase 3A handoff (analytics)

For whoever continues from here (Codex or a person). What Phase 3A built, what was decided, what
was checked, and what is still open. The rules themselves are in [analytics.md](analytics.md).

> **Status after Phase 3B (15–16 November 2026).** This report describes the branch as committed
> (`7897fdd`) and is kept as written. Several of its statements are now out of date:
> - Migration 10 **is applied** to `studio-pulse-dev`, recorded under its file version, and the
>   hosted catalog confirms `analytics_time_summary` is `SECURITY INVOKER` (§4 still says "No").
> - The advisors were reviewed after Phase 3B ([handoff-phase-3b.md](handoff-phase-3b.md)).
> - Analytics was used signed in, in Chrome at 1280 px and 390 px, against the hosted project, and
>   hosted daily/weekly summaries matched the authenticated RPC (in UTC). §7's "not run" items
>   about a live check are superseded by those runs.
> - The automation hook in §9 is built: Phase 3B's Edge worker calls `summarizeReport` on the
>   recipient's own rows ([automation.md](automation.md)).
> - The `feat/phase-3a-analytics` branch is the base of `feat/phase-3b-automation`; the Phase 3C
>   integration review is in [handoff-phase-3c.md](handoff-phase-3c.md).

## 1. Branch and commit

| | |
| --- | --- |
| Branch | `feat/phase-3a-analytics` (not pushed) |
| Based on | `db068eb` (style: align workspace and desktop with the Figma direction) |
| Commit | The single commit on the branch that adds this file (`git log -1 -- docs/handoff-phase-3a.md`) |

## 2. Files changed by area

**Database**
- `supabase/migrations/20261112090000_analytics.sql` (new, migration 10): `public.analytics_time_summary`.
- `packages/database/src/types.ts`, `packages/database/src/schema.ts`: the function's arguments and
  returned columns.

**Time engine** (`packages/time-engine/src`)
- `reconcile.ts` (new): `reconcileIntervals`, `summarizeReport`, `bucketKeyFor`, `monthStart`.
- `types.ts`: `ReportInterval`, `ReconciledPiece`, `ReconcileResult`, `ReportBucket`,
  `ReportDimension`, `ReportRow`, `SummarizeReportOptions`.
- `days.ts`: `startOfLocalDay` and day keys rewritten to be host-independent; `daysBetween` added.
- `index.ts`: the new exports.

**Shared UI** (`packages/ui`)
- `src/charts.tsx`, `src/charts.css`: `AreaChart`.
- `src/scales.ts`, `src/seriesColors.ts` (new, moved from the desktop unchanged), with subpath
  exports `@studio-pulse/ui/scales` and `@studio-pulse/ui/seriesColors` in `package.json`.
- `src/icons.tsx`: `IconChart`. `src/index.ts`: the new exports.

**Desktop** (`apps/desktop/src`)
- `lib/chartScales.ts`, `lib/colors.ts`: now re-export the moved ui modules by relative path.
- `views/settings/ApplicationsSettings.tsx`: "Show it in this device's reports" (copy only).

**Web** (`apps/web`)
- `src/lib/analytics.ts` (new): the pure rules (scope, ranges, buckets, requests, view models,
  task progress, exports, preferences, copy).
- `src/lib/api.ts`: `analyticsSummary`, `reportReadAt`, `reportArgs`, `toReportRow`,
  `listMySessions` (with the project, application and unattributed filters),
  `listAllMySessions`, `listMySessionsForExport`.
- `src/lib/errors.ts`: `toReportProblem`, `isTimeZoneProblem`, `57014` in `toProblem`.
- `src/lib/download.ts` (new): file download from generated text.
- `src/lib/router.ts`, `src/app/Shell.tsx`: the `analytics` section (`#/analytics`) and its nav entry.
- `src/app/workspace.tsx`: a task change also invalidates `ws:<id>:time:` (task moves move time).
- `src/views/AnalyticsView.tsx` (new) and `src/views/analytics/*` (new): the page and its cards.
- `src/views/ProjectDetailView.tsx`: the Insights section replaces the "Tracked time" card.
- `src/views/TimeView.tsx`: one footnote on start-day grouping.
- `src/styles/web.css`: tables, toolbar, tiles, task-status grid, settings dialog, Insights.
- `package.json`: depends on `@studio-pulse/shared-types` and `@studio-pulse/validation`.

**Tests**
- `tests/integration/supabase/analytics.test.ts` (new): the function's behaviour, permissions,
  refusals and properties.
- `tests/integration/supabase/analytics-oracle.test.ts` (new): the function against
  `summarizeReport`, row for row.
- `tests/integration/supabase/privileges.test.ts`, `anon.test.ts`: the new function.
- `tests/unit/time-engine/reconcile.test.ts`, `host-tz.test.ts` (new).
- `tests/unit/web/analytics.test.ts`, `analytics-api.test.ts`, `analytics-views.test.ts`,
  `area-chart.test.ts`, `download.test.ts` (new); `router-errors-api.test.ts` (extended).
- `tsconfig.json`: `"jsx": "react-jsx"` so the root type check covers the chart test.

**Docs**
- `docs/analytics.md` (new), this file (new), `docs/supabase.md` (migration 10).
- `docs/privacy.md`, `docs/testing.md`, `docs/workspace.md`, `README.md`: updates required by the
  spec (§9). Status: done (what reports show and to whom, the new tests and how to run them, the
  Analytics page and Insights, the README feature list).

**Test timeouts**
- `tests/unit/time-engine/reconcile.test.ts` (seeded `summarizeReport` cases) and the existing
  `tests/unit/time-engine/reconciliation.test.ts` (seeded `summarize` cases) set a 30 s timeout on
  their one heavy test, as `tests/unit/database` already does. Alone they take about 2.5 s and 2 s;
  in the full parallel run they took 7.3 s and 5.6 s and hit Vitest's 5 s default. No assertion
  changed.

## 3. Decisions taken

**Database**
- One read-only RPC, `SECURITY INVOKER`, aggregates on the server. No table, view, policy, index or
  grant on data changed; nothing is widened. RLS decides whose time counts.
- Reconciliation per user: active beats idle; among one kind, the first entry in
  `(started_at, ended_at, id)` order wins. Filters apply afterwards. `overlap_ms` on the total row.
  The desktop's `resolveOverlaps` is unchanged; the difference is documented in analytics.md §2.
- No `plan_cache_mode` on the function. The queries on `time_entries` run through
  `EXECUTE … USING` with fixed SQL text. Measured reason: `force_custom_plan` made Postgres 18
  re-plan the RLS helper for every row. Function config is `search_path` only.
- Active-beats-idle uses window functions over per-user event points (no `seq = n` join).
- With a filter, input is restricted to rows overlapping a matching row. The matching rows are
  read (and RLS-checked) once and go straight into the reconciliation; one lateral lookup per
  overlap island on `time_entries_user_started` adds only their non-matching neighbours, through
  the filter's exact complement (`(…) is not true`, leakproof, so it is checked before RLS). A
  filter that matches most rows so costs about the same as no filter (analytics.md §9).
- No index added and no `work_mem` set (measurements in analytics.md §9).
- `p_to` before 2020-01-01 is refused too (`22023`); `summarizeReport` does the same.
- Deleting a task or project with tracked time is refused (`23503`, "archive it instead"), so a
  "deleted task" only arises when a whole workspace is deleted.

**Engine**
- `startOfLocalDay` and day keys use `Intl.DateTimeFormat` only; `src` no longer imports
  `@date-fns/tz`. Behaviour changes only for repeated midnights: for example Asia/Amman and
  Asia/Gaza 2021-10-29 now start at 21:00Z.
- Unit-tested code never imports the `@studio-pulse/ui` package entry; it uses the subpaths or a
  relative path (the entry loads `.tsx`, which breaks the root `tsc`).

**Web**
- Two views: My work (your own time and assigned tasks) and Workspace (everyone you can see, or one
  person under "Time of"). Without visible teammates, Workspace view makes no time call and shows a
  "time is private" panel plus task cards.
- No filter value or member id in the URL. Preferences live in `localStorage` per person and
  workspace; the "Time of" person is never saved.
- Cache keys sit under `ws:<id>:time:analytics:` (`…summary:<json>`, `…sessions:<json>`), so
  Refresh, task changes, sign-out and workspace switches clear them.
- The previous period is a neutral reference line under Active, never a delta, and never for a
  teammate.
- The last result stays on screen dimmed while a new one loads, but only within the same view and
  person, so one scope's figures never sit under another's labels.
- A zone the server refuses: the page reports in UTC for the visit and drops the saved zone.
  Choosing the browser's own zone saves null ("follow this browser").
- The one-day timeline, Recent sessions and the My sessions export follow the Project and
  Application filters as the report applies them (`sessionQueryFilters`). Recent sessions and the
  export also follow "Only unattributed", which is offered only while no project filter is set.
  The sessions JSON records the filters in `meta.filters`.
- Visibility: the server's `teammates_visible` wins over the prediction, but only for the cached
  (role, visibility) pair it was given in (`standingVerdict`, `teammatesVisibleNow`); a report
  read before the page opened, the pair changed or the last Refresh is read again first. The
  privacy note follows the same answer.
- Project Insights: All time (`p_from` null, by month), Last 90 days (today − 89, by week), Last
  30 days (today − 29, by day). The range is saved on change. The visibility note follows the
  server's `teammates_visible`. A refused zone counts days in UTC and says so in the footnote.
- Exports: CSV columns are append-only; JSON carries `formatVersion: 1`; Summary JSON rows use the
  CSV's column names in the CSV's order.
- Durations use the app's compact format ("31h 10m", "(2h 05m overlapped)"), not the spec's
  "31 h 10 min" wording.

## 4. Migration 10 and deployment

Apply `supabase/migrations/20261112090000_analytics.sql` to `studio-pulse-dev` with
`npm run supabase:migrate` (see [supabase.md §2](supabase.md#2-apply-the-migrations)). If it is
applied another way (dashboard SQL editor, Supabase MCP `apply_migration`), re-record the file's
version so the runner and `supabase db push` see it as applied:

```sql
update supabase_migrations.schema_migrations set version = '20261112090000'
where name = 'analytics';
```

Until it is applied, the Analytics page and Project Insights show "Analytics needs the latest
database update. Ask the workspace owner to apply migration 10." (`PGRST202`).

| | |
| --- | --- |
| Applied to `studio-pulse-dev` | No. The brief asks for the migration to be documented; it is left for whoever deploys the branch. |
| Version re-recorded | Not applicable yet (only needed if it is applied without `npm run supabase:migrate`). |
| Security and performance advisors after applying | Not run (nothing applied). Run both advisors after applying; the function adds no table, view, policy or grant on data, so no new RLS finding is expected. |

Deployment order: apply migration 10, then deploy the web build. A web build deployed first shows
the `PGRST202` message above on Analytics and Insights until the migration is applied; nothing else
in the app depends on it. The desktop app needs no update.

## 5. Query interfaces and types

- **RPC:** `public.analytics_time_summary(p_workspace_id, p_to, p_time_zone, p_from, p_bucket,
  p_user_ids, p_project_id, p_unattributed, p_application_id)`, returning `dimension`,
  `bucket_start`, `user_id`, `application_id`, `application_name`, `project_id`, `task_id`,
  `unattributed`, `active_ms`, `idle_ms`, `entry_count`, `overlap_ms`, `teammates_visible`. Full
  contract, row order and refusals: analytics.md §5.
- **TypeScript:** `Database['public']['Functions']['analytics_time_summary']` in
  `@studio-pulse/database`; `ReportRow`, `ReportInterval`, `SummarizeReportOptions` in
  `@studio-pulse/time-engine`.
- **Web data layer** (`apps/web/src/lib/api.ts`): `AnalyticsSummaryParams` →
  `analyticsSummary(client, params): Promise<ReportRow[]>`; `MySessionsQuery`,
  `MySessionsPageQuery` → `listMySessions`, `listAllMySessions`, `listMySessionsForExport`
  returning `MySession` (`id`, `started_at`, `ended_at`, `application_id`, `application_name`,
  `kind`, `active_ms`, `idle_ms`, `project_id`, `task_id`). Sessions are always the caller's own.

## 6. Reusable functions

Listed with signatures in analytics.md §6:
- time-engine: `reconcileIntervals`, `summarizeReport`, `bucketKeyFor`, `monthStart`,
  `startOfLocalDay`, `addDays`, `daysBetween`, `enumerateDays`, `isoWeekStart`, `localDayKey`;
- ui: `AreaChart`, `@studio-pulse/ui/scales`, `@studio-pulse/ui/seriesColors`;
- web: `lib/analytics.ts` (scope, ranges, buckets, request keys, view models, task progress,
  exports, preferences), `api.analyticsSummary`, `api.listMySessions`, `errors.toReportProblem`,
  `errors.isTimeZoneProblem`, `download.ts`.
- `apps/web/src/views/analytics/models.ts` has view-only builders (`sessionRows`, `dayTimeline`,
  `taskListItems`, `clockText`).

## 7. Test results

**Final checks (spec §10), run one at a time on 15 November 2026 on the committed tree:**

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck` | Pass (every workspace, then the root `tsc -p tsconfig.json`). |
| 2 | `npx vitest run` (unit and PGlite integration) | Pass: 59 files, 1469 tests, 0 failed (167.8 s). An earlier run had two timeouts at Vitest's 5 s default; see "Test timeouts" in §2. |
| 3 | `$env:TZ='America/Los_Angeles'; npx vitest run tests/unit/time-engine tests/unit/desktop tests/integration/supabase/analytics-oracle.test.ts` (PowerShell; Git Bash strips `TZ`) | Pass: 17 files, 528 tests, 0 failed. Host offset confirmed as 480 min first. |
| 4 | `npm run build:web`, then `npm run check:secrets:web` | Pass. Bundle `index-*.js` 759 kB (217 kB gzip), with Vite's over-500 kB chunk warning. Secret scan: no secrets in 7 files; the two allowed matches are the database package's key-rejection rule. |
| 5 | `npm run test:rust` | Pass: 365 passed, 0 failed, 12 ignored by design (9 need an interactive Windows desktop, 1 writes to Credential Manager, 2 talk to a real Supabase project). Phase 3A changes no Rust. |
| 6 | `npm run lint:rust` | Pass (clippy, all targets, `-D warnings`). |

There is no JavaScript linter in the repository; "lint" is the typecheck plus clippy.

**Evidence gathered during the build** (outside the suites above):
- The oracle test compares the function with `summarizeReport` row for row, including order, for
  every bucket, the project, unattributed and application filters, seven user lists, `p_from`
  omitted and null, owner, admin and member under both visibility settings, and UTC,
  America/New_York, America/Havana, America/Santiago, Atlantic/Azores, Asia/Kathmandu,
  Australia/Lord_Howe, Asia/Amman, Europe/London and Asia/Gaza around their DST dates (Amman and
  Gaza on their 2021 dates, since Amman no longer changes clocks). Four deliberate breaks were each
  caught by it: the sweep ordered by the
  clipped start, idle no longer yielding to active (both in SQL), the end tie-break dropped and a
  project-null row treated as unattributed (both in `reconcile.ts`).
- A brute-force probe written independently of the SQL found 0 mismatches in four runs of 600
  comparisons each on earlier versions of the function, and detected each of its three mutants
  (sweep on clipped times, idle not cut by active, neighbour fetch missing earlier-starting rows).
  After the change that reads matching rows once, the pass that made it reported two more runs
  on the final function (seeds 4242 and 2718, 600 comparisons each, 0 mismatches), two new
  mutants caught (the complement written as `is false`, the matching rows left out) and the
  existing restricted-input mutant still caught. That output is not kept in the repo.
  The timings in analytics.md §9 come from the same probe set.

**Not run:**
- The web app has not been used signed in against a real Supabase project. A signed-in browser
  check at three widths (1100 px and above, 760–1100 px, 760 px and below) needs a person to sign
  in. The Analytics cards were rendered only in unit tests (`renderToStaticMarkup`) and in a local
  preview with made-up data.
- `npm run supabase:verify` and any live check against `studio-pulse-dev`: not run, because
  migration 10 is not applied there. Everything above ran on PGlite (PostgreSQL 18.6 as WASM).
- Clean timings of the final function. The figures in analytics.md §9 come from runs on 12 and 14
  November. A re-run of the 30k-row probe on 15 November was 4–6 times slower on every call,
  because the laptop was CPU-limited at a 10% battery even on mains power. The slowdown was the
  same for every call, so it shows no regression, but its absolute times are not usable.
  Re-measure on a machine that isn't throttled, ideally on a hosted Postgres.

## 8. Known limitations

In full in analytics.md §10:
- the open session isn't synced, so today lags;
- the desktop's "this device's reports" setting and application categories are not on the server;
- time zones are not stored, and tzdata can differ between browser and server (America/Edmonton
  from 2026-11-02, Africa/Casablanca from 2026-09-21);
- no billable or manual time;
- reports are per workspace only;
- preferences are per browser;
- multi-page RPC reads are not a snapshot;
- the Time page groups by start day;
- realtime does not cover time.

Also open from the build:
- No unit test covers the Analytics container's own logic (stale-result reuse, session paging,
  time-zone fallback, re-reading a report older than the current visibility state, debounced
  preference writes) or the Project Insights container; both live in `.tsx` views. The
  visibility verdict rules themselves (`standingVerdict`, `teammatesVisibleNow`, `privacyNote`)
  are pure helpers in `lib/analytics.ts`, tested in `analytics.test.ts`.
- A failure of the unfiltered report used for the Application and "Time of" options is not shown
  on its own (it normally fails together with the main report, which is).
- Owner reports over a full year are slow at scale (about 5.4 s at 125k rows in PGlite; 9.0 s in
  the later dominant-filter runs on a variant of the data set, analytics.md §9).
- `packages/time-engine/package.json` still declares `@date-fns/tz` and `date-fns`, which `src`
  no longer imports. Only `date-fns` can simply go: nothing imports it. `@date-fns/tz` is still
  needed by `tests/integration/support/tracking-day.ts` (`TZDate`), which the root
  `package.json` does not declare, so it resolves only because time-engine declares it and npm
  hoists it. That helper also builds instants with `new TZDate(y, m - 1, d, h, min, tz)`, the
  host-dependent component constructor; it is harmless today because its fixture days (London,
  11 to 13 October 2026) are far from any clock change. To remove both packages from
  time-engine, either move `@date-fns/tz` to the root `devDependencies`, or switch the helper's
  `at()` to the engine's `startOfLocalDay` plus wall-clock minutes (host-independent).

## 9. Phase 3B readiness

- **Changing the RPC's result.** `returns table` cannot be altered in place: drop and create the
  function in a new migration (no overloads; keep one signature), then update
  `packages/database/src/schema.ts` and `types.ts`, the revoke and grant (`anon` and `public`
  revoked, `authenticated` granted), `privileges.test.ts` and `anon.test.ts`, `toReportRow`, and
  `summarizeReport` with the oracle test.
- **Exports.** CSV columns are append-only (new columns at the end). The JSON files carry
  `formatVersion`; a change existing readers would misread needs a new version.
- **Open decision: manual and billable time.** How a manual or billable entry reconciles against
  automatic time is not decided: whether it beats active time, sits beside it, or is reported
  separately. Whatever is chosen must change the rule in analytics.md §2, the SQL sweep,
  `reconcile.ts` and the oracle test together.
- **Automation hook (not built).** The pure functions (`summarizeReport`, `reconcileIntervals`,
  `lib/analytics.ts` builders) and the RPC are where an automation engine could read figures. The
  RPC needs a signed-in user (`auth.uid()`; `28000` otherwise), so an automation must act as that
  user. Running it with elevated rights would need a new function and a privacy decision; nothing
  here provides one.
