# Studio Pulse — Analytics (Phase 3A)

Phase 3A adds reports on synced desktop time to the team workspace (`apps/web`): the
**Analytics** page (`#/analytics`), the **Insights** section on a project's page, and a footnote on
the Time page. Totals are added up on the server by one read-only function,
`public.analytics_time_summary` (migration 10, `20261112090000_analytics.sql`). The web app never
downloads a tracking history to add it up. The same rules are implemented in TypeScript
(`summarizeReport` in `@studio-pulse/time-engine`), and a test compares the two row for row.

Nothing here changes what is recorded, synced or who may read it. The function is
`SECURITY INVOKER`: Row Level Security on `time_entries` decides whose time counts, exactly as for a
plain `select`. No table, policy, index or grant on data changed.

## 1. Measurements

These definitions are used in the UI, the exports (`MEASUREMENTS` in `apps/web/src/lib/analytics.ts`)
and this document.

| Term | Definition |
| --- | --- |
| **Active time** | An enabled application was in the foreground with input within the idle threshold (`kind = 'active'`). |
| **Idle time** | A tracked application was in the foreground with no input past the threshold (`kind = 'idle'`). |
| **In foreground** | Active + idle. |
| **Sessions** | Distinct `time_entries` rows contributing to a figure (`entry_count` in the function, `sessions` in exports). A session crossing midnight counts once in each day, so per-period counts do not add up to the total. |
| **Unattributed** | No project and no task. |
| **No project (task time)** | Time on a task that has no project. |
| **Not billable** | No figure is billable time, and there are no manual time entries. The page and the exports say so. |
| **Estimates** | A task's own `estimated_minutes`, shown only next to that task's time as "Estimate (task)". Projects have no budgets. |
| **Task progress** | Counts from the tasks table as they are now: "Current status — not limited by dates or application". |

There are no productivity scores, rankings or judgements. Member lists are alphabetical (former
members last), and no per-person trend is shown for teammates.

## 2. Reconciliation

Desktop entries can overlap: two devices running at once, or an idle entry under an active one.
Each instant is counted once.

**Rule.** Within one user, each instant belongs to the **first entry in
`(started_at, ended_at, id)` order** among that user's **active** entries covering it. If no
active entry covers it, it belongs to the first such entry among the user's **idle** entries.

- Ordering uses the **unclipped** times, truncated to milliseconds. Clipping to the report range
  happens afterwards, so attribution never depends on the range.
- Different users are never reconciled against each other.
- Reconciled foreground time is therefore the union of each user's entries within the range.

**Algorithm** (one valid implementation; the rule above is what both sides must match):

1. **Active pieces.** A high-water sweep over the user's active entries in
   `(started_at, ended_at, id)` order: each entry keeps `[max(start, hw), end)`, where `hw` is the
   latest end of the earlier active entries. Empty pieces are dropped, then pieces are clipped to
   the range.
2. **Idle candidates.** The same sweep over the idle entries.
3. **Active beats idle.** The union of active pieces is subtracted from the idle candidates. One
   idle entry can become several pieces.
4. **Filters** (project, unattributed, application) apply **after** reconciliation, so a filtered
   figure is always a part of the unfiltered one.
5. **`overlap_ms`** (total row only) = the clipped raw durations of the entries that pass the
   filters, minus their reconciled time. It is never negative. The footnote shows it as
   "(… overlapped)".

**Difference from `resolveOverlaps`.** The desktop reports keep using
`resolveOverlaps` (`packages/time-engine/src/intervals.ts`), unchanged. It works per device, breaks
ties by `(start, id)` and treats active and idle alike. Analytics uses the separate
`reconcileIntervals`, which works per user across devices, orders by `(start, end, id)` and lets
active time beat idle time. The two can give different totals for the same entries.

## 3. Days, buckets and time zones

- **Reporting zone.** Every report names an IANA zone (`Europe/London`) or `UTC`. POSIX strings
  such as `UTC+3` (which Postgres reads with the sign inverted) and fixed abbreviations such as
  `CET` (no daylight saving time) are refused. The zone is the browser's unless one is saved in
  Report settings. It is sent with each request and not stored on the server.
- **Start of a local day** is the first instant whose wall-clock date in the zone is that day or
  later. A skipped midnight moves forward (America/Santiago). A repeated midnight uses the earlier
  instant (America/Havana 2026-11-01, Atlantic/Azores 2026-10-25, Asia/Amman and Asia/Gaza
  2021-10-29). The SQL writes this inline. `startOfLocalDay` computes it with
  `Intl.DateTimeFormat` only, so the result never depends on the host's time zone.
- **Range.** Local days `from..to`, inclusive: `[startOfDay(from), startOfDay(to + 1))`. A day
  with a clock change is shorter or longer by the size of the change: usually 23 or 25 hours,
  23.5 or 24.5 at Australia/Lord_Howe, which moves its clocks by 30 minutes.
- **Day windows.** Reconciled pieces are split at each local midnight. The windows partition time,
  so nothing is lost or counted twice.
- **Buckets.** `day` is the local date, `week` the ISO week's Monday, `month` the 1st. Weeks and
  months are roll-ups of days. The first and last buckets can be partial; the chart marks them
  ("Partial week", "Partial month").
- **Auto bucket** (web): day up to 31 days, week up to 120, month beyond. Day buckets are offered
  up to 92 days.
- **`p_from` null** means from the local day of the first entry in scope (after RLS, the user list
  and the filters). With no such entry the range is just `p_to`. Project Insights uses this for
  "All time".

## 4. Permissions and `teammates_visible`

The function reads `time_entries` as the caller, so the `time_entries_select` policy applies:

| Caller | Workspace visibility `private` (default) | Visibility `admins` |
| --- | --- | --- |
| Member | Own time | Own time |
| Owner or admin | Own time | Everyone's time, former members' too |

- **`teammates_visible`** on the total row is true when the caller is an owner or admin and the
  owner chose `admins`. The web app predicts it from the cached workspace
  (`predictTeammatesVisible`) and trusts the total row once a report arrives. That verdict holds
  only for the cached (role, visibility) pair it was given in (`standingVerdict`,
  `teammatesVisibleNow`): once either changes it is dropped, and a later return to the same pair
  is predicted and asked afresh. A report read before the page opened, before the pair last
  changed or before the last Refresh is read again before its verdict is believed. The privacy
  note follows the verdict (`privacyNote(workspace, teammatesVisible)`), so it never says
  "Includes the time of everyone" over a panel that shows no time.
- When teammates are not visible, the user list is narrowed to the caller: `p_user_ids` null or
  containing the caller gives the caller's own time; a list without the caller gives a zero
  total. This is a planner hint; RLS enforces the same thing.
- The caller must be an active member of the workspace. Otherwise the function raises `P0002`
  "workspace not found", also for a removed member and for a workspace that does not exist.
  Without a signed-in user it raises `28000`. `anon` cannot execute it.
- The page mirrors these rules (Workspace view shows a "time is private" panel and task cards only
  when teammates are not visible) but never relies on them.
- No window titles, file names or note contents are read. Exports never contain another member's
  sessions. No filter value or member id goes in the URL.

## 5. The RPC: `public.analytics_time_summary`

```sql
analytics_time_summary(
  p_workspace_id uuid,
  p_to date,                        -- last local day, inclusive
  p_time_zone text,                 -- IANA name or UTC
  p_from date default null,         -- first local day; null: first entry in scope
  p_bucket text default 'day',      -- 'day' | 'week' | 'month'
  p_user_ids uuid[] default null,   -- null: everyone the caller can read
  p_project_id uuid default null,
  p_unattributed boolean default false,  -- only time with no project and no task
  p_application_id text default null
) returns table (
  dimension text,             -- 'total' | 'period' | 'member' | 'project' | 'task' | 'application'
  bucket_start date,          -- period rows
  user_id uuid,               -- member rows
  application_id text,        -- application rows
  application_name text,      -- application rows: name on the contributing entry with the latest (started_at, id)
  project_id uuid,            -- project and task rows; null = no project
  task_id uuid,               -- task rows; null = no task
  unattributed boolean,       -- project rows: true for the no-project, no-task row
  active_ms bigint,
  idle_ms bigint,
  entry_count integer,        -- distinct entries contributing
  overlap_ms bigint,          -- total row only; 0 elsewhere
  teammates_visible boolean   -- total row only; null elsewhere
)
language plpgsql stable security invoker set search_path = ''
```

Execute is granted to `authenticated` only. The TypeScript types are in
`packages/database/src/types.ts` (`Functions.analytics_time_summary`), and `schema.ts` describes the
same signature for the schema test.

**Rows and order.** Exactly one `total` row (also with no data), then `period`, `member`, `project`,
`task` and `application` rows; within each, by `bucket_start`, `user_id`, `project_id`,
`unattributed`, `task_id`, `application_id` (code-point order), ascending with nulls last. Rows
other than the total appear only where `active_ms + idle_ms > 0`. Project rows are grouped by
project and the unattributed flag, so `project_id` null appears as "Unattributed" and as
"No project (task time)". Task rows are grouped by project and task.

**Refusals.** Each is a plain sentence; the web app shows it as written.

| Code | When |
| --- | --- |
| `28000` | No signed-in user ("sign in to see analytics") |
| `P0002` | Not an active member, or no such workspace ("workspace not found") |
| `22023` | `p_to`, `p_time_zone`, `p_bucket` or `p_unattributed` is null; an unknown bucket; `p_to < p_from`; a day before 2020-01-01 (`p_from` or `p_to`) or from 2100-01-01; more than 500 user ids; both `p_project_id` and `p_unattributed`; a span over 366 days, or with a project over 366 (day), 1,100 (week) or 3,660 (month) days |
| `22023` "unknown time zone" | A zone that fails the name pattern or that Postgres does not know. The client relies on the words "time zone" |
| `57014` | Statement timeout. The web app asks for a shorter range or a filter |
| `PGRST202` | The function does not exist: migration 10 is not applied. The web app says so |

Span limits are checked after a null `p_from` is resolved.

## 6. Reusable functions

### `@studio-pulse/time-engine`

| Export | What it does |
| --- | --- |
| `reconcileIntervals(intervals, { startMs, endMs })` | The §2 rule over `ReportInterval`s; returns `{ pieces: ReconciledPiece[], rawMs }`. Pieces of one user never overlap; ordered by user id, then start. Interval ids must be unique. |
| `summarizeReport(intervals, options)` | The RPC's twin: the same `ReportRow`s, in the same order, for the same input rows. Options mirror the arguments (`fromDay`, `toDay`, `timeZone`, `bucket`, `userIds`, `projectId`, `unattributed`, `applicationId`, `teammatesVisible`). Throws a `RangeError` with a plain sentence where the RPC answers `22023`. It does not authorize: pass only the intervals the viewer may read. |
| `bucketKeyFor(day, bucket)` | The first day of the bucket containing `day`. |
| `monthStart(day)` | The 1st of the month containing `day`. |
| `startOfLocalDay(day, timeZone)` | UTC ms of the start of a local day (§3). Host-independent. |
| `addDays`, `daysBetween`, `enumerateDays`, `isoWeekStart` | Calendar arithmetic on `YYYY-MM-DD` keys, done in UTC. |
| `localDayKey(ms, timeZone)` | The local day containing an instant, by the same boundaries. |

Types: `ReportInterval`, `ReconciledPiece`, `ReconcileResult`, `ReportBucket`, `ReportDimension`,
`ReportRow` (the camelCase twin of an RPC row), `SummarizeReportOptions`. Strings are ordered by
code point, like Postgres' `collate "C"`, never by locale.

### `@studio-pulse/ui`

| Export | What it does |
| --- | --- |
| `AreaChart` | One series as a line with a light wash, for time over buckets. Props: `data` (`AreaDatum[]`: `key`, `label`, `value`, `tooltip`), `yTicks`, `formatTick`, `height`, `color` (default the neutral total colour), `width`, `aria-label` (required), `stale` (dims the marks while refreshing). Crosshair tooltip; arrow keys, Home, End and Escape step through points, and the focused value is announced. Without data it keeps the empty frame and takes no focus. |
| `@studio-pulse/ui/scales` | `timelineWindow`, `timelineTicks`, `durationTicks`, `formatAxisDuration`. Moved from the desktop unchanged. |
| `@studio-pulse/ui/seriesColors` | `assignApplicationColors`, `colorFor`, `SERIES_COLORS`, `SERIES_SLOT_COUNT` (8), `OTHER_COLOR`, `TOTAL_COLOR`. Colour follows the application, never its rank; past eight applications the smallest fold into "Other". Moved from the desktop unchanged. |

The desktop's `chartScales.ts` and `colors.ts` re-export these by relative path. Code that is
unit-tested from `tests/unit/**` must not import the `@studio-pulse/ui` package entry (it loads
`.tsx` files, which the root `tsc -p tsconfig.json` cannot type-check without JSX); use the subpath
exports or a relative path.

### `apps/web/src/lib/api.ts`

| Export | What it does |
| --- | --- |
| `analyticsSummary(client, params)` | Calls the RPC with `AnalyticsSummaryParams` (camelCase) and returns `ReportRow[]`. Reads every row in pages with `.range()` until a short page. Errors go through `toReportProblem`. Records when the rows were read. |
| `reportReadAt(rows)` | When `analyticsSummary` returned these rows (epoch ms), or null for rows it did not return. Kept beside the rows, so "Updated HH:MM" is right whichever page (Analytics or Project Insights) filled the shared cache key. |
| `reportArgs(params)`, `toReportRow(record)` | The argument mapping (unset optional arguments are left out, so the database defaults apply) and the row mapping. |
| `listMySessions(client, query)` | One page of the caller's **own** sessions overlapping `[startIso, endIso)`, newest first (`started_at` desc, `id` desc), keyset paging through `before`. Sessions are whole, not clipped. A lower bound of `start − 744 h` keeps each page an index range scan. `projectId`, `applicationId` and `unattributedOnly` (no project and no task) narrow it as the report's filters do; a project together with `unattributedOnly` matches nothing, as in the report. Page size 1 to 1,000. |
| `listAllMySessions(client, query, max)` | Every page up to `max`; `truncated` says there were more. |
| `listMySessionsForExport(client, query)` | Every session in the range, or a refusal past 50,000 (`MY_SESSIONS_EXPORT_MAX`). |

### `apps/web/src/lib/errors.ts`

- `toReportProblem(error)`: `57014` gives "This report took too long. Choose a shorter range or add
  a filter."; `PGRST202` gives "Analytics needs the latest database update. Ask the workspace owner
  to apply migration 10."; everything else goes through `toProblem`, which now also maps `57014`.
- `isTimeZoneProblem(problem)`: code `22023` and the words "time zone". The Analytics page then
  reports in UTC for the visit and drops the saved zone; Project Insights counts in UTC and says so.

### `apps/web/src/lib/analytics.ts`

Pure functions with no I/O, no clock and no ambient time zone: callers pass `now` or `today` and
the reporting zone. Tested in `tests/unit/web/analytics.test.ts`.

| Area | Exports |
| --- | --- |
| Scope | `resolveScope` (My work: `[me]`; Workspace: everyone or one person when teammates are visible, else no time call), `predictTeammatesVisible`, `standingVerdict`, `teammatesVisibleNow` (§4), `privacyNote`, `whoseTime`, `scopedLabel` |
| Ranges | `resolveAnalyticsRange` (Today, Yesterday, Last 7 days, Last 30 days, Custom up to 366 days, 2020–2099), `formatDayRange`, `showsPreviousReference`, `previousReferenceText` |
| Buckets | `autoBucket`, `allowedBuckets`, `resolveBucket` |
| Requests and cache keys | `summaryParams`, `withoutApplicationFilter`, `previousPeriodParams`, `sessionQueryFilters` (the page's filters as a session query), `analyticsSummaryKey` (`ws:<id>:time:analytics:summary:<json>`), `mySessionsKey` (`ws:<id>:time:analytics:sessions:<json>`), `stableJson` |
| View models | `splitReport`, `reportTotals`, `periodSeries`, `activityChartData`, `createReportLabels`, `applicationItems`, `projectItems`, `taskItems`, `memberItems` (alphabetical) |
| Filters and colours | `timeOfOptions`, `applicationOptions`, `projectFilterOptions`, `encodeProjectFilter`, `decodeProjectFilter`, `applicationColors` |
| Tasks | `reportingToday`, `selectTasks`, `summarizeTaskProgress`, `upcomingDeadlines`, `projectProgressRows`, `assignedProjects` |
| Exports | `toCsv`, `csvCell`, `summaryRecords`, `buildSummaryCsv`, `buildSummaryJson`, `sessionRecords`, `buildSessionsCsv`, `buildSessionsJson`, `formatLocalIso`, `workspaceSlug`, `exportFileName`, `exportReady` (no export until the report, or the task progress where no time is shown, is in, the project and task lists have loaded and no former member's name is still pending) |
| Preferences | `preferencesKey`, `validatePreferences`, `parsePreferences`, `serializePreferences`, `readPreferences`, `writePreferences`, `browserStorage`, `saveView`, `deleteView`, `applySavedView`, `validateSavedViewName`, `isReportTimeZone`, `timeZoneOptions` |
| Copy | `MEASUREMENTS`, `RECONCILIATION`, `analyticsFootnote`, `overlapClause` |

Cache keys sit under `ws:<id>:time:`, so Refresh, a task move (`refreshTable('tasks')`), sign-out
and a workspace switch all clear them. The previous-period reference is a neutral line under the
Active tile ("Previous 7 days (…): 31h 10m"), never a delta, and is not shown for a teammate.

`apps/web/src/lib/download.ts` saves a generated file through a Blob, an object URL and a temporary
`<a download>`, revoked after one second. The file is built in the tab; nothing is sent anywhere.

## 7. Exports

Available from the Analytics page's Export menu. The Summary is offered in both views; My sessions
only in My work.

**Format rules (both CSVs).** UTF-8 with a byte order mark, RFC 4180 quoting, CRLF after every
line. Text starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'` so a
spreadsheet does not run it as a formula; numbers are written as is. Durations are seconds with
three decimals.

**Summary CSV** columns (`SUMMARY_COLUMNS`):

```
section, period_start, member_id, member, application_id, application, project_id, project,
task_id, task, task_status, task_count, active_seconds, idle_seconds, foreground_seconds,
sessions, time_zone
```

Sections, in order: `total`, `period`, `member` (alphabetical, former members last; never by
time), `project`, `task`, `application`, then `task_status` rows (`inbox`, `todo`, `in_progress`,
`in_review`, `done`, `overdue`, `due_next_7_days`). In Workspace view without visible teammates the
file has `task_status` rows only.

**Summary JSON**: `{ meta, rows }`. `meta` has `formatVersion: 1`, `report` (`my-summary` or
`workspace-summary`), `workspace`, `view`, `timeOf`, `range` (`from`, `to`, `timeZone`),
`filters`, `bucket`, `generatedAt`, `teammatesVisible`, `measurements`, `notBillable: true`,
`manualTime: "not available"` and `reconciliation`. `rows` are the CSV records under the CSV's
column names.

**My sessions CSV** columns (`SESSION_COLUMNS`):

```
id, started_at_utc, ended_at_utc, local_start, local_end, time_zone, application_id,
application, kind, active_seconds, idle_seconds, project_id, project, task_id, task
```

Only the signed-in user's own sessions overlapping the range and matching the page's filters,
whole (not clipped) and not reconciled, so they can add up to more than the Summary. The export
holds the same sessions as the Recent sessions card: the Project filter (a project, or
Unattributed), the Application filter and, while no project filter is set, the card's "Only
unattributed" toggle, all applied as the report applies them (`sessionQueryFilters`). Local times
are ISO 8601 with the zone's offset. At most 50,000 sessions; past that the export is refused with
a sentence asking for a shorter range. **My sessions JSON**: `meta` has `formatVersion: 1`,
`report: "my-sessions"`, `workspace`, `range`, `filters` (`project`, `applicationId`,
`applicationName`, `unattributedOnly`), `generatedAt`, a sentence on what the sessions are,
`measurements`, `notBillable` and `manualTime`; `rows` use the CSV's column names.

**File names:** `studio-pulse_<workspace-slug>_<report>_<from>_to_<to>.<csv|json>`.

**Compatibility.** Columns are append-only: a new column goes at the end, and existing columns keep
their name and meaning. The JSON files carry `formatVersion`; a change existing readers would
misread needs a new version.

## 8. Preferences

Saved per person and workspace in this browser's `localStorage`, under
`studio-pulse:analytics:<userId>:<workspaceId>`. They are separate from tracking data, are not
synced, and stay in the browser after sign-out.

| Field | Default |
| --- | --- |
| `view` (`mine` or `workspace`) | `mine` |
| `range` (preset, or custom first and last day) | Last 7 days |
| `bucket` (`auto`, `day`, `week`, `month`) | `auto` |
| `timeZone` (null follows the browser) | null |
| `projectFilter` (all, unattributed, or a project id) | all |
| `applicationId` | null |
| `projectInsightsRange` (`all`, `last90`, `last30`) | `all` |
| `presets` (saved views) | none |

- Stored text is validated field by field: an invalid field falls back to its default and the rest
  is kept. Unknown fields are dropped, so no person id is ever kept.
- The "Time of" person is never saved, neither in preferences nor in saved views, nor in the URL.
- Saved views: at most 20, names 1 to 60 characters; saving under an existing name (ignoring case)
  replaces that view.
- The Analytics page writes 500 ms after the last change and on leaving the page. Project Insights
  writes its range on change. Both re-read storage first, so neither overwrites the other's fields.
- Where storage is refused (private modes, blocked storage) the defaults apply and choices last
  for the page only.

## 9. Performance

Measured on 12 November 2026 in PGlite 0.5.10 (PostgreSQL 18.6 as WASM, one connection, Windows
host), through the real function as the caller, best of 2–3 warm calls, Europe/Berlin, default
`work_mem` (4MB). The data set has 10 people (owner, admin, 8 members) with a year of entries,
visibility `admins`, 10 applications and 5 projects. A hosted Postgres runs natively and will be
faster; the relative costs should hold.

| Call | ~30k rows | ~125k rows |
| --- | ---: | ---: |
| member, today | 10 ms | 14 ms |
| member, last 30 days, by day | 18 ms | 38 ms |
| member, 366 days, by day | 92 ms | 298 ms |
| member, a project, all time, by month | 25 ms | 69 ms |
| owner, today | 13 ms | 38 ms |
| owner, last 30 days, by day | 109 ms | 407 ms |
| owner, 366 days, by day | 1,209 ms | 5,412 ms |
| owner, 366 days, by month | 1,196 ms | 5,373 ms |
| owner, a project, all time, by month | 410 ms | 1,593 ms |
| owner, last 30 days, one application | 44 ms | 158 ms |
| owner, last 30 days, unattributed | 39 ms | 140 ms |
| owner, last 30 days, one teammate | 23 ms | 51 ms |
| owner under `private` (own rows only), 366 days | 74 ms | 271 ms |

The filtered rows above (a project, one application, unattributed) were measured before the
matching rows were read only once (next table); that change only removes work.

A filter that matches most rows, measured later on the same generator with 90% of rows made
unattributed and 80% Figma (owner, 366 days, by day, `admins`):

| Call | ~30k rows | ~125k rows |
| --- | ---: | ---: |
| no filter | 1,851 ms | 8,958 ms |
| unattributed (about 90% of rows) | 1,817 ms | 8,933 ms |
| Figma (about 80% of rows) | 1,847 ms | 8,508 ms |

Before the change the two filtered calls took 3,423 / 14,542 ms and 3,194 / 13,746 ms in the same
runs: the per-island lookup fetched the matching rows a second time, under RLS.

- **Per-row RLS cost.** An owner's long range is dominated by the policy check on every teammate
  row (`private.has_workspace_role`), about 26 µs a row: 0.8 s of 2.4 s for a year at 30k rows
  (EXPLAIN ANALYZE). The rest is the sweep (~0.19 s), the active-beats-idle windows (~0.61 s), the
  day split (~0.25 s) and grouping (~0.35 s). No index removes the RLS check.
- **Span caps.** At most 366 days (with a project, 1,100 days by week or 3,660 by month) and 500
  people. The page defaults to Last 7 days, and a timeout (`57014`) asks for a shorter range or a
  filter.
- **Filter-restricted input.** With a project, unattributed or application filter, only rows of
  the same user that overlap a matching row are reconciled. The figures are exactly those of the
  full computation (an entry's share depends only on the entries covering its instants). The
  matching rows are read, and checked by RLS, once; they go into the reconciliation as they are
  and form per-user overlap islands. One lateral index lookup per island on
  `time_entries_user_started` then fetches only the neighbours that do **not** match: its last
  condition is the filter expression wrapped in `… is not true`, the exact complement of a WHERE,
  nulls included (a row with no project does not match a project filter). Every node in it is
  leakproof, so the planner checks it before the RLS qual. A selective filter so reads a small
  part of the range under RLS; a filter that matches most rows costs about the same as no filter,
  not more. The shorter complement `project_id is not null or task_id is not null` for
  unattributed was tried and rejected: the planner served it with a BitmapOr over the project and
  task indexes on every island lookup, and the unattributed call got slower.
- **`plan_cache_mode` is not set.** The two queries that read `time_entries` run through
  `EXECUTE … USING` with fixed SQL text, so each call is planned with its own values (the user hint
  works, and the unused input branch is pruned). Setting `force_custom_plan` on the function made
  Postgres 18 re-plan the RLS helper for every row: a plain owner scan of 29k rows went from 568 ms
  to 3,286 ms. Function config is `search_path` only.
- **Active beats idle** uses window functions over per-user event points, with no join. The first
  draft joined idle pieces to active pieces by sequence number; its join filter grew
  quadratically, and an owner's year took 13.3 s at 30k rows (together with `force_custom_plan`).
- **Indexes: none added.** `time_entries_workspace_started` serves the range read,
  `time_entries_user_started` the user hint and the neighbour lookups, `time_entries_project` the
  project seeds. An index on `(workspace_id, user_id, started_at)` or a covering index was
  considered and rejected: neither avoids the RLS call.
- **`work_mem` is not set.** 16MB instead of 4MB saved 3–13% at 125k rows; a function-level setting
  would apply to every sort of every concurrent call on a small instance.

## 10. Known limitations

- **Today lags.** The desktop syncs a session only after it ends, so the open session is missing
  and today's figures grow as sessions close and sync. The page says "Sessions appear after they
  end and sync".
- **Device settings are not on the server.** The desktop's "Show it in this device's reports"
  setting and application categories stay on the device. An application hidden there still
  appears in web Analytics (yours, and owners' and admins' under `admins` visibility).
- **Time zones are not stored**, and the time zone data can differ between the browser and the
  server. Known examples: America/Edmonton from 2026-11-02 and Africa/Casablanca from 2026-09-21
  differ between PostgreSQL 18.6 and Node's ICU. A zone the server does not know is refused
  ("unknown time zone"); the Analytics page then reports in UTC for the visit and says so.
- **No billable or manual time.** Every figure is recorded application time.
- **Reports are per workspace.** There is no report across workspaces.
- **Preferences are per browser.** They do not follow the person to another browser or device.
- **Multi-page reads are not a snapshot.** A report with more rows than one page is read in pages,
  and each page runs the function again. Sessions that sync between pages can make the pages
  disagree slightly.
- **The Time page groups by start day.** It lists sessions under the day they started, while
  Analytics splits them at midnight and counts overlap once, so day totals can differ. The Time
  page says so.
- **Realtime does not cover time.** `time_entries` is not in the realtime publication; reports
  refresh on Refresh, when the tab becomes visible again or the browser comes back online, and
  after a task changes (a task move moves its time).
