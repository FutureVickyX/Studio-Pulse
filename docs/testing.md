# Studio Pulse — Testing

Three layers. **Automated** tests run anywhere Node and Rust run, with a few that need Windows.
**Live Windows** tests talk to the real desktop and must run in an interactive Windows session.
The **manual checklist** covers what only a person at a real Windows install can verify
(sign-in launch, sleep, reboots, real creative apps).

## 1. Automated tests

```bash
npm test                 # everything below
npm run test:ts          # vitest: tests/unit + tests/integration
npm run test:rust        # cargo test: engine, registry, store, startup, service
```

| Area | Location | Needs Windows? |
| --- | --- | --- |
| Foreground interval transitions, app switching, idle transitions, sleep/resume gaps, lock screen, clock changes, pause, min-interval filtering, duplicate prevention, invariant fuzzing | `apps/desktop/src-tauri/src/tracker/engine.rs` (unit), `apps/desktop/src-tauri/tests/engine_fixtures.rs` replaying `tests/fixtures/tracking/*.json` | No |
| Application registry: defaults valid, matching precedence, wildcards, path disambiguation, disabled apps | `apps/desktop/src-tauri/src/registry/` (unit); `tests/unit/validation` (TS side of the same rules) | No |
| Local database: migrations, idempotent upserts, one open interval per device, crash recovery, export, deletion that leaves no recoverable bytes in the file or WAL, consent for built-ins added by upgrades, persisted pause, privacy field list = schema | `apps/desktop/src-tauri/tests/store_integration.rs` | No |
| Tracker service with fake probe and clock: restart without duplicates, pause and timed pause (including across restarts), sleep, onboarding consent, disabling, offline outbox (pending rows), storage failures (simulated with SQLite triggers) never resurrecting a discarded interval or losing buffered writes | `apps/desktop/src-tauri/tests/service_integration.rs` | No |
| Startup registration (against a scratch registry key, never the real Run key) | `apps/desktop/src-tauri/tests/startup_registry.rs` | **Yes** |
| Time aggregation, time zones and DST, ranges, overlap resolution, formatting | `tests/unit/time-engine` | No |
| Settings and application-definition validation | `tests/unit/validation` | No |
| Cross-package report reconciliation | `tests/integration` | No |
| Desktop UI pure logic: keyboard shortcuts, routes, status text, chart scales | `tests/unit/desktop` | No |

Phase 2A (Supabase accounts, workspaces, RLS and sync):

| What | Where | Needs network |
| --- | --- | --- |
| RLS and RPCs on a Supabase-shaped Postgres (PGlite): isolation, roles and no self-escalation, invitations, private notes and time entries, removed members, idempotent `sync_time_entries`, exact grants, policies evaluating `auth.uid()` once, foreign-key indexes | `tests/integration/supabase` | No |
| Typed client and schema cross-check against the migrations, migration runner, verification payloads, secret scanner | `tests/unit/database` | No |
| Account manager: sign-in/up/out, restore online and offline, rotating refresh tokens, memberships reloaded after an offline start, sign-out that fails safely | `apps/desktop/src-tauri/tests/cloud_account.rs` | No |
| Sync engine: batches, per-entry results, lost responses, backoff with jitter, no overlapping passes, claim before upload | `apps/desktop/src-tauri/tests/cloud_sync.rs` | No |
| Local outbox and the in-place v1 → v2 upgrade | `apps/desktop/src-tauri/tests/store_sync_ledger.rs` | No |
| HTTP client against a local fake server | `apps/desktop/src-tauri/tests/cloud_http.rs` | No |
| The real project: every RLS/RPC check as real users (`verify.mjs`), the HTTP contract and the full desktop pipeline (`supabase_live`, ignored by default) | `scripts/supabase/verify.mjs`, `apps/desktop/src-tauri/tests/supabase_live.rs` | **Yes** (see [docs/supabase.md §3](supabase.md#3-verify-against-the-real-project)) |

Phase 2B (team workspace):

| What | Where | Needs network |
| --- | --- | --- |
| Project statuses, leads, dates and versions; task versions and deletion guards; checklists; comments; shared-note editing with owner-only fields; time attribution (own entries only, task decides project, archived take no new time, totals count once); former leads and assignees; time following a moved task; workspace deletion still cascading | `tests/integration/supabase/collaboration.test.ts` and the updated `projects`, `tasks`, `notes`, `time-entries`, `privileges` and `anon` suites | No |
| Workspace pure logic: filters, sorting, due dates, validation, time totals, routes, error mapping, idempotent creates (including a user retry with the same draft id) | `tests/unit/web` | No |
| Note autosave: debounce, saves on top of the confirmed version, conflicts (nothing is overwritten until you choose), use theirs, retries with a growing delay, no retry after the session ended, deleted or unshared notes, flush on unmount (also during a save), teammates' versions and a save's own realtime echo, local drafts | `tests/unit/web/autosave.test.ts` | No |
| Desktop links to the workspace: sections, Ctrl+2/3/4, URL validation | `tests/unit/desktop` (routes, keyboard), `src-tauri/src/workspace_link.rs` (unit) | No |
| The workspace's data layer against the real project as three real users, incl. realtime privacy | `tests/live/workspace.live.test.ts` (opt-in, see [tests/live/README.md](../tests/live/README.md)) | **Yes** |

The signed-in UI itself (clicking through pages in a browser) is a manual check:
[workspace.md §9](workspace.md#manual-check-of-the-team-workflows).

### Phase 3A (analytics)

| What | Where | Needs network |
| --- | --- | --- |
| `analytics_time_summary` on PGlite: signed-out, `anon`, non-member and removed callers refused, who sees whose time under 'private' and 'admins' (members, owners, admins, former members), every refused argument (`22023`), the function's properties (`SECURITY INVOKER`, stable, empty `search_path`, applications ordered with `collate "C"`), and figures worked out by hand: days across midnight and DST, overlapping devices, filters after reconciling (including a filter every row matches, which must give exactly the unfiltered figures), row order | `tests/integration/supabase/analytics.test.ts` | No |
| Oracle: the SQL function against the TypeScript `summarizeReport`, row for row and in order, over seeded data around the DST changes of many zones (and Amman/Gaza 2021), every bucket, filter combination, user list and role, under several host time zones | `tests/integration/supabase/analytics-oracle.test.ts` | No |
| Reconciliation and report summaries: literal hand-worked cases, local days across DST and odd offsets, the RPC's refusals, and seeded random cases against an independent brute-force reference | `tests/unit/time-engine/reconcile.test.ts` | No |
| Day helpers and summaries give the same answer whatever the host's time zone (zones switched in-process and proven by `getTimezoneOffset`) | `tests/unit/time-engine/host-tz.test.ts` | No |
| Analytics pure logic: scope, the server's visibility verdict and the privacy note that follows it, ranges, previous period, buckets, cache keys, session-list filters, view models, colours, filter options, task progress, CSV/JSON exports (column order, quoting, BOM, CRLF, formula neutralising, local times with offsets), file names, export readiness, footnotes, preferences and saved views | `tests/unit/web/analytics.test.ts` | No |
| Data layer: `reportArgs`, paged `analyticsSummary` reads and their read time (`reportReadAt`), `listMySessions` filters (project, application, unattributed) and keyset paging, the 50,000-session export refusal, analytics cache invalidation | `tests/unit/web/analytics-api.test.ts` | No |
| Every Analytics and Insights card rendered loading, empty, failed and with data; Members alphabetical with no sort or trend; privacy notes; the private-workspace panel shows no time; the Idle tile in place of Unattributed under a project filter; filtered empty states; "All sessions shown." focusable where "Show more" was; no "better", "worse", "rank", "score" or "productiv" in the markup; table captions and scoped headers; chart labels | `tests/unit/web/analytics-views.test.ts` | No |
| `AreaChart` (data, empty, stale, accessible name, series colour never on text), the download helper, the `analytics` route and the report error sentences | `tests/unit/web/area-chart.test.ts`, `download.test.ts`, `router-errors-api.test.ts` | No |

```bash
npx vitest run tests/unit/web tests/unit/time-engine
npx vitest run tests/integration/supabase/analytics.test.ts tests/integration/supabase/analytics-oracle.test.ts
```

**Under another host time zone.** Git Bash on Windows strips `TZ` before it reaches Node, so
`TZ=… npx vitest` there silently runs in the machine's own zone. Use PowerShell, and check that
the zone took effect (480 for Los Angeles):

```powershell
$env:TZ='America/Los_Angeles'; node -e "console.log(new Date(2026,0,1).getTimezoneOffset())"
$env:TZ='America/Los_Angeles'; npx vitest run tests/unit/web/analytics.test.ts tests/unit/time-engine
```

The signed-in Analytics page itself (visibility, exports, saved views, narrow windows) is a manual
check: [workspace.md §9](workspace.md#manual-check-of-the-team-workflows), steps 9 and 10.

## 2. Live Windows tests (real desktop session)

```bash
npm run test:windows-live   # cargo test --test windows_live -- --ignored
npm run probe               # prints the foreground app, match, idle seconds and session state every second
npm run probe -- --list     # lists running applications with visible windows and their registry match
```

They include a ghost-window test: a test window stops responding for about 8 seconds and the probe
must keep reporting the hung app, not `dwm.exe`. These are `#[ignore]` by default because they
need an interactive, unlocked desktop. CI agents
and service sessions have no foreground window.

## 3. Manual Windows verification checklist

Run on a real Windows 10 or 11 machine with the installed build (see `docs/installation.md`).
Have the target apps installed. Use `npm run probe` side by side when something looks wrong.

| # | Check | Steps | Expected |
| --- | --- | --- | --- |
| 1 | App starts normally | Launch Studio Pulse from the Start menu | Onboarding on first run, then the workspace. A tray icon appears. |
| 2 | Launch at login works | Settings › General › Launch at Windows startup **on**. Sign out and back in (or reboot). | Studio Pulse starts in the tray (Start minimized on) and the tray tooltip shows the tracking state. Task Manager › Startup apps lists "Studio Pulse" as Enabled. |
| 3 | Launch at login can be disabled | Toggle off, then sign out and in | Studio Pulse doesn't start. The Startup apps entry is gone. `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` has no "Studio Pulse" value. |
| 4 | Detects Figma Desktop | Focus Figma for 30 s | Home shows Figma as current app. A ~30 s Figma interval appears. |
| 5 | Detects After Effects | Focus After Effects for 30 s | Same, for After Effects |
| 6 | Detects Blender | Focus Blender for 30 s | Same, for Blender |
| 7 | Switching closes the previous interval | Figma 20 s → Blender 20 s → Figma 20 s | Three intervals with boundaries at each switch, no overlap. Totals ≈ 40 s Figma and 20 s Blender. |
| 8 | Idle excluded from active | Set idle timeout to 1 min. Focus Photoshop, don't touch input for 3 min, then move the mouse. | About 1 min before the timeout fires, the active interval is truncated to the last input. An idle interval covers the inactive time and a new active interval starts at the mouse move. Active excludes the 3 min, foreground includes it. |
| 9 | Sleep creates no false work time | Focus an app, then Start › Power › Sleep. Wake after 5+ min. | The interval ends at sleep time. Nothing is credited for the sleep. A new interval starts after wake/unlock. |
| 10 | Restart doesn't duplicate sessions | Track for a minute. Reboot with the app open (or kill it in Task Manager). Start again. | The pre-restart interval is closed (`shutdown` or `recovered`), there is no duplicate, and new intervals start after the old one ends. |
| 11 | Offline events sync after reconnection | Signed in with sync configured, disconnect the network and track for a few minutes, then reconnect. | Tracking continues unaffected. Records stay `pending` (Settings › Sync shows the pending count) and upload after reconnecting, without duplicates. |
| 12 | Paused tracking records no active time | Pause "until I resume". Use Photoshop for 2 min. Resume. | No interval covers the paused span. The tray icon and status show Paused throughout. |
| 13 | Lock screen | Focus an app, press Win+L for 2 min, unlock | The interval ends at lock. Nothing is recorded while locked. |
| 14 | Single instance | Launch Studio Pulse a second time | The existing window comes to the front and no second tray icon appears |
| 15 | Minimize to tray | Close the main window | The window hides and tracking continues (tray state unchanged) |
| 16 | Workspace links | In a build with `STUDIO_PULSE_WORKSPACE_URL`, click Tasks, then press Ctrl+3 and Ctrl+4 | The default browser opens the workspace on Tasks, Notes and Projects. In a build without it, the entries say the build doesn't link to a workspace and nothing opens. |

Record results (pass/fail, Windows build, app versions) in the release notes for each build.
