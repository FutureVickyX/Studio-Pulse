# Studio Pulse — Architecture

> Status: **Phase 1 (desktop tracking MVP)**. Phases 2 (shared workspace) and 3 (productivity
> workflows) are designed for here but not built. Anything marked _Phase 2_ / _Phase 3_ is a seam,
> not a feature.

Studio Pulse is a Windows desktop companion for creative teams. It records which creative
application is in the foreground, separates active time from idle time, and shows honest totals.
Tasks, notes and team reports come later on top of the same records.

Guiding principle: _capture work quietly, keep tasks and notes effortless, share useful
information without turning the app into employee surveillance._

---

## 1. Scope of Phase 1

| In Phase 1 | Not in Phase 1 |
| --- | --- |
| Tauri 2 desktop app (Windows 10/11) | Accounts, Supabase, sync (Phase 2) |
| Real foreground-app detection (Win32) | Tasks, notes, projects, team (Phase 2) |
| Idle, lock-screen, sleep and clock-change handling | Quick capture, global shortcut (Phase 3) |
| Configurable application registry | Manual time entries, attribution (Phase 3) |
| Local SQLite persistence and crash recovery | Web dashboard (`apps/web`, Phase 2) |
| Launch at login (verified), tray, single instance | macOS / Linux (not claimed) |
| Daily and range dashboards from stored records | |
| Pause / resume / pause-for-duration | |
| Local export and deletion of tracking history | |

Phase-2 surfaces in the UI (Tasks, Notes, Projects, Team, workspace settings) are shown as
disabled navigation entries labelled “Phase 2”. No page shows fabricated data.

---

## 2. Repository layout

```
studio-pulse/
├── apps/
│   ├── desktop/                 Tauri 2 + React + TypeScript (Phase 1)
│   │   ├── src/                 React UI (main window + compact indicator window)
│   │   ├── src-tauri/           Rust: tracker, Win32 probes, SQLite, tray, startup
│   │   │   ├── tauri.conf.json  (see note below)
│   │   │   ├── capabilities/    Tauri ACL — per-window command allowlist
│   │   │   ├── migrations/      local SQLite schema (embedded at compile time)
│   │   │   ├── src/
│   │   │   ├── tests/           Rust integration tests
│   │   │   └── examples/probe.rs  CLI probe for manual Windows verification
│   │   └── package.json
│   └── web/                     Phase 2 placeholder (README only)
├── packages/
│   ├── shared-types/            TS mirror of every Rust⇄UI payload + default app registry JSON
│   ├── validation/              zod schemas for settings, app definitions, command inputs
│   ├── time-engine/             TS reporting maths: ranges, time zones, day-splitting, aggregation
│   ├── database/                Phase 2 placeholder (Supabase client + generated types)
│   └── ui/                      design tokens + React primitives + SVG charts
├── supabase/                    Phase 2 placeholder (migrations, functions, seed.sql)
├── tests/
│   ├── unit/                    vitest suites for the TS packages
│   ├── integration/             vitest suites that cross package boundaries
│   └── fixtures/tracking/       JSON scenario traces replayed by the Rust engine tests
└── docs/                        architecture, installation, privacy, testing
```

**Deviation from the requested tree:** `tauri.conf.json` lives in `apps/desktop/src-tauri/`, not
`apps/desktop/`. Tauri 2's CLI and `tauri-build` locate the Rust crate by finding the directory
that contains `tauri.conf.json`. Putting it one level up makes the CLI look for `Cargo.toml` in
`apps/desktop/` and the build fails. Canonical placement is the only layout that builds reliably.

Tooling: npm workspaces (Node ≥ 22), TypeScript strict mode, Vite, vitest, Cargo. Workspace
packages are consumed **as TypeScript source** (`"exports": "./src/index.ts"`). There is no
package build step: Vite and vitest transpile them, and `tsc --noEmit` type-checks each project.

---

## 3. Process model

```
┌──────────────────────────── studio-pulse.exe (one instance) ────────────────────────────┐
│                                                                                        │
│  tracker thread (Rust, 1 Hz)            Tauri main thread               WebView2 UI      │
│  ┌──────────────────────────┐          ┌──────────────────────┐       ┌──────────────┐   │
│  │ platform probe (Win32)   │  status  │ tray + menu          │ event │ main window  │   │
│  │  foreground pid → exe    ├─────────►│ windows (main,       ├──────►│ indicator    │   │
│  │  last input → idle ms    │          │   indicator)         │       │  window      │   │
│  │  WTS session → locked?   │          │ commands (allowlist) │◄──────┤ invoke()     │   │
│  │ registry match → app id  │          └──────────┬───────────┘       └──────────────┘   │
│  │ engine.step(sample)      │                     │ reads / admin writes                 │
│  │ store.upsert(intervals)  ├──────────┐          ▼                                      │
│  └──────────────────────────┘          └──► SQLite (WAL) %APPDATA%\com.studiopulse.desktop│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**The tracker runs in Rust, not in the webview.** Hidden WebView2 windows are throttled, and the
app must keep tracking with no window open. The webview only displays data and sends commands.
It cannot reach the OS, the file system or SQL directly.

- The tracker thread owns the `Engine` and the `SystemProbe`. It receives commands (pause,
  resume, reconfigure, registry changed, flush, shutdown) over a channel and samples on a 1 s
  `recv_timeout` tick.
- `Store` wraps one `rusqlite::Connection` behind a `Mutex`. Writes are short transactions.
- `LiveState` (`RwLock`) holds the latest `TrackerStatus` and a snapshot of the open interval.
  Commands read it, so the UI sees the in-progress interval without waiting for a checkpoint.
- Single instance: `tauri-plugin-single-instance`. A second launch focuses the existing main
  window and exits.

---

## 4. Time accounting

### 4.1 Vocabulary

- **Sample**: one observation: UTC wall time, monotonic time, foreground tracked app (or
  none), milliseconds since last input, and session state (active / locked / screen saver /
  disconnected).
- **Interval** (`TrackingEvent`): a contiguous stretch `[startedAt, endedAt)` during which one
  tracked application was in the foreground in one **kind**: `active` or `idle`.
  `activeSeconds = duration` for active intervals and `idleSeconds = duration` for idle ones.
  `durationSeconds = activeSeconds + idleSeconds` always.
- **Foreground time** = Σ duration. **Active time** = Σ activeSeconds. **Idle time** = Σ idleSeconds.

Example: Photoshop is in the foreground for 60 minutes and the designer is away for 20 of them.
That produces active intervals totalling 40 minutes and idle intervals totalling 20. Reports show
foreground 60 m, active 40 m and idle 20 m.

### 4.2 Invariants (enforced by the engine, the schema and the tests)

1. **At most one open interval per device.** A partial unique index enforces it in SQLite.
2. **Intervals on a device never overlap.** A new interval never starts before the high-water
   mark (the latest `endedAt` recorded on this device). If the clock moves backwards, tracking
   holds in state `clockBehind` until the wall clock passes the high-water mark again.
3. **Only observed, contiguous time is credited.** Time between two consecutive samples is
   credited only when the gap is plausible:
   `0 ≤ wallΔ ≤ maxGap` and `monoΔ ≤ maxGap` and `|wallΔ − monoΔ| ≤ clockTolerance`.
   Otherwise the open interval closes at the **previous** sample's wall time. The gap (sleep,
   hibernate, a hung process, a clock change) is never credited.
4. **Closed intervals are immutable** for the tracker. The upsert's `ON CONFLICT … WHERE state =
   'open'` makes replays and duplicate writes no-ops.
5. **Stable IDs.** Every interval gets a UUIDv7 when it opens. The ID never changes and is the
   idempotency key for later sync.
6. **Crash safety under-counts and never over-counts.** The open interval is checkpointed every
   `checkpointSeconds`, and its persisted `endedAt` is always a time that was actually observed.

### 4.3 Engine algorithm (`src-tauri/src/tracker/engine.rs`, pure, no I/O)

Defaults: poll 1 s; `idleThreshold` 5 min; `minInterval` 2 s; `maxGap` 15 s; `clockTolerance` 5 s.

For every sample:

1. **Paused** → remember nothing, credit nothing.
2. **Continuity check** against the previous sample (rule 4.2.3). On a discontinuity, close
   the open interval at the previous sample's wall time (reason `timeGap` or `clockChange`). Then
   treat this sample as a fresh start.
3. **Extend** the open interval to `sample.wallMs` (sample-and-hold: the time since the previous
   tick belongs to the state observed at that tick).
4. **Desired state**:
   - session not `active` (locked, screen saver, disconnected) → `away`
   - foreground is not a tracked app → `untracked`
   - idle detection on and `idleMs ≥ idleThreshold` → `tracked(app, idle)`
   - otherwise → `tracked(app, active)`
5. **Transition** from the open interval O:

| From → To | Action |
| --- | --- |
| none → tracked(app, k) | open new interval at `sample.wallMs` (respecting high-water) |
| O(app, k) → tracked(app, k) | nothing (already extended) |
| O(app, active) → tracked(app, idle) | `idleStart = wall − idleMs`. If `idleStart ≤ O.start`, relabel O as idle. Otherwise close O at `idleStart` (`becameIdle`) and open an idle interval `[idleStart, wall)`. **Idle time is never counted as active.** |
| O(app, idle) → tracked(app, active) | `resume = clamp(wall − idleMs, O.start, wall)`. Close O at `resume` (`inputResumed`), open an active interval `[resume, wall)` |
| O(appA) → tracked(appB, k) | close O at `wall` (`appSwitch`), open B at `wall` |
| O → untracked | close O at `wall` (`untracked`) |
| O → away | close O at `wall` (`sessionAway`) |

6. A closed interval shorter than `minInterval` is **discarded**: it is never persisted, or it is
   deleted if it was only ever written as `open`. This filters alt-tab flicker.
7. `pause()`, `finish(shutdown)` and settings changes that affect classification close O at the
   last sample's wall time.

Retroactive idle relabelling only reaches back within the current open interval. If an app steals
focus while the user is already away, up to one idle threshold can be credited to the previous
interval as active. See [§16 Known limitations](#16-known-limitations).

### 4.4 Persistence cadence ("aggregation window")

- Closed intervals are written immediately in one transaction.
- The open interval is upserted every `checkpointSeconds` (default 15 s, range 5–300). It is also
  written immediately after a structural change (relabel, or a newly opened idle interval), but
  only once it has lasted at least `minInterval`.
- So a two-hour Photoshop session is **one row** updated about every 15 s, not 7,200 rows.

### 4.5 Restart, crash, sleep, shutdown

| Situation | Behaviour |
| --- | --- |
| Graceful quit / Windows shutdown | `finish(shutdown)` closes the open interval at the last observed sample. |
| Crash / power loss | On next start `recover_open_intervals` closes every `open` row at its last checkpoint (`recovered`). Loss ≤ one checkpoint window. |
| Sleep / hibernate | The resume sample fails the continuity check, so the interval ends at the last pre-sleep sample. |
| Lock screen / screen saver / RDP disconnect | Session state ≠ active → `away`, interval closes, nothing recorded until unlock. |
| Clock jumps forward | Continuity check fails, so the jump isn't credited. |
| Clock jumps backward | Continuity check fails; then the high-water rule holds tracking until the clock catches up. |
| App disabled mid-session | The next sample is `untracked`, so the interval closes. |
| Tracked app "Not Responding" | Windows shows a ghost window owned by `dwm.exe`. The probe maps it back to the hung app's window (`HungWindowFromGhostWindow`), so the freeze stays credited to that app. |
| Tracking paused or disabled | The interval closes at the last sample; nothing is recorded until resume. |
| Restart while paused | The pause is stored (`meta.tracker_pause`). "Pause until I resume" stays paused after a restart; a timed pause still ends at its original time. |
| Storage temporarily failing (disk full, file locked) | Writes are buffered, one per interval, and retried every tick. Upserts are idempotent, and a discarded interval is purged from the buffer. |

---

## 5. Application registry

Defaults live in `packages/shared-types/data/default-applications.json`, the single source shared
by Rust (`include_str!`) and TypeScript. On first run they are seeded into the local
`applications` table. Later releases add new built-ins without touching user edits. Once the
user has completed onboarding, a newly added built-in is inserted **disabled**, so an upgrade never
starts tracking an application the user did not choose.

```jsonc
{ "id": "adobe-photoshop", "displayName": "Adobe Photoshop", "category": "photo",
  "enabledByDefault": true,
  "matchers": [ { "exe": "Photoshop.exe" } ] }
```

- A **matcher** is `{ exe, pathIncludes? }`. `exe` matches the process image file name,
  case-insensitively, and may contain `*` wildcards (`gimp-*.exe`). `pathIncludes` is an
  optional case-insensitive substring of the full image path. It disambiguates generic names such
  as Affinity's `Designer.exe`.
- An application has any number of matchers, so versioned executables, launchers and beta
  channels never depend on one hard-coded name.
- **Best match wins.** A matcher with `pathIncludes` outranks one without, and an exact `exe`
  outranks a wildcard. On a tie, user-defined beats built-in, then lower `sortOrder` wins. If the
  best match is a **disabled** application, the process is untracked: it doesn't fall through to
  a weaker match.
- `ApplicationFrameHost.exe` (UWP host) is resolved to the hosted app's process before matching.
- Only the matched **application id and display name** are stored. Executable paths are used in
  memory for matching and are never persisted with tracking records.
- Users can enable or disable, rename, recategorise, include or exclude from reports, add custom
  applications (pick a running app or browse for an `.exe`), edit matchers, and reset built-ins.

Categories: `design`, `motion`, `video`, `3d`, `photo`, `audio`, `publishing`, `code`, `other`.

---

## 6. Local storage

SQLite at `%APPDATA%\com.studiopulse.desktop\studio-pulse.sqlite3`, WAL mode, `foreign_keys=ON`.
Migrations are embedded from `src-tauri/migrations/*.sql` and tracked with `PRAGMA user_version`.

| Table | Purpose |
| --- | --- |
| `meta` | `device_id` (UUID generated on first run), schema bookkeeping |
| `preferences` | `settings` JSON document (validated on read and write) |
| `applications` | registry rows: id, display_name, category, matchers_json, enabled, include_in_reports, built_in, sort_order, timestamps |
| `tracking_events` | intervals (see below) |

`tracking_events` columns: `id` (UUIDv7, PK), `device_id`, `user_id` (NULL until Phase 2 sign-in),
`application_id`, `application_name` (snapshot), `kind` (`active`/`idle`), `started_at_ms`,
`ended_at_ms`, `active_ms`, `idle_ms`, `state` (`open`/`closed`), `end_reason`, `project_id`,
`task_id`, `source` (`automatic`/`manual`), `sync_status` (`pending`/`synced`/`failed`),
`revision`, `created_at_ms`, `updated_at_ms`.

Constraints: `ended_at_ms ≥ started_at_ms`; `active_ms + idle_ms = ended_at_ms − started_at_ms`;
`kind = 'active' ⇒ idle_ms = 0`; `kind = 'idle' ⇒ active_ms = 0`;
`UNIQUE (device_id) WHERE state = 'open'`. Indexes on `started_at_ms`,
`(application_id, started_at_ms)` and `(sync_status) WHERE state = 'closed'`.

Times are stored as UTC epoch milliseconds and exposed to the UI as ISO-8601 UTC strings. The UI
renders them in the user's local time zone.

Deletion is real: every connection sets `PRAGMA secure_delete = ON`, so freed pages are zeroed. After
a history deletion, `PRAGMA wal_checkpoint(TRUNCATE)` empties the write-ahead log, which still held
the pre-delete page images. A test scans the database and WAL bytes for a deleted marker.

---

## 7. Native command surface (allowlist)

The webview can call **only** these commands. `build.rs` declares them in the Tauri app manifest,
and `capabilities/*.json` grants them per window. The indicator window gets a smaller set. No shell
plugin, no fs plugin, no HTTP plugin. No command accepts a file path, SQL or a process to run from
the UI. Export and executable picking open native dialogs **from Rust**.

From Tauri's own core API the webviews get only `core:event:allow-listen` and
`core:event:allow-unlisten`, plus `core:window:allow-start-dragging` for the indicator's drag
region. `core:default` is deliberately not granted: it would let a script hide or relabel the tray
icon, emit fake tracker events, or read image files by path.

| Command | Args (JS) | Returns | main | indicator |
| --- | --- | --- | :-: | :-: |
| `get_tracker_status` | – | `TrackerStatus` | ✓ | ✓ |
| `pause_tracking` | `{ minutes: number \| null }` | `TrackerStatus` | ✓ | ✓ |
| `resume_tracking` | – | `TrackerStatus` | ✓ | ✓ |
| `list_tracking_events` | `{ range: { fromMs, toMs } }` | `TrackingEvent[]` (live open interval overlaid) | ✓ | ✓ |
| `get_settings` | – | `Settings` | ✓ | ✓ |
| `update_settings` | `{ patch: SettingsPatch }` | `Settings` | ✓ | |
| `complete_onboarding` | `{ enabledApplicationIds: string[] }` | `Settings` | ✓ | |
| `get_startup_status` | – | `StartupStatus` | ✓ | |
| `set_launch_at_login` | `{ enabled: boolean }` | `StartupStatus` | ✓ | |
| `list_applications` | – | `ApplicationDefinition[]` | ✓ | ✓ |
| `save_application` | `{ input: ApplicationInput }` | `ApplicationDefinition` | ✓ | |
| `delete_application` | `{ id: string }` | `void` | ✓ | |
| `reset_applications` | `{ removeCustom: boolean }` | `ApplicationDefinition[]` | ✓ | |
| `list_running_applications` | – | `RunningApplication[]` | ✓ | |
| `pick_executable` | – | `RunningApplication \| null` | ✓ | |
| `get_data_summary` | – | `DataSummary` | ✓ | |
| `export_tracking_events` | `{ format: 'json' \| 'csv' }` | `ExportResult \| null` | ✓ | |
| `delete_tracking_events` | `{ beforeMs: number \| null }` | `{ deleted: number }` | ✓ | |
| `get_app_info` | – | `AppInfo` | ✓ | ✓ |
| `show_main_window` | `{ route: string \| null }` | `void` | ✓ | ✓ |
| `hide_indicator` | – | `void` | | ✓ |
| `quit_app` | – | `void` | ✓ | ✓ |

Errors serialize as `{ code, message }` with `code ∈ validation | not_found | startup_registration |
storage | platform | internal`. Messages never contain file contents or window titles.

**Events (Rust → UI):** `tracker://status` (`TrackerStatus`, on change),
`tracker://events-changed` (`{ at }`, after each persisted write), `settings://changed`
(`Settings`), `applications://changed` (`ApplicationDefinition[]`), `app://navigate` (`string`).

All payload types are defined once in `packages/shared-types/src/index.ts` and mirrored by Rust
structs with `#[serde(rename_all = "camelCase")]`.

---

## 8. Launch at login

Implemented in Rust (`src-tauri/src/startup.rs`) on the per-user registry, so no elevation is
needed:

- `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `Studio Pulse` =
  `"<path to Studio Pulse.exe>" --autostart`
- `HKCU\…\Explorer\StartupApproved\Run`: Windows' own enabled/disabled flag (Task Manager's
  Startup apps toggle). Enabling writes the "enabled" marker. Status reports when Windows has
  disabled the entry.

Rules:

1. Off by default. Nothing is written until the user turns it on.
2. `enable` writes, then **reads back and compares**. A mismatch is an error and the UI shows the
   toggle as off with the reason.
3. `disable` deletes both values and verifies they are gone.
4. Status is always derived from the registry. Nothing is cached, and the UI never shows "on"
   from a stored preference.
5. Status flags an entry that points at a different executable (moved install, dev build).
6. On `--autostart` launches: with **Start minimized** on, only the tray icon appears. Otherwise
   the full window opens if **Launch full window on startup** is on, else the compact indicator.
   Manual launches always open the main window.

Why not `tauri-plugin-autostart`: it writes the same Run key but doesn't read it back to verify
or surface Windows' StartupApproved state. Both are explicit requirements here.

---

## 9. Windows, tray and background behaviour

- **Main window** (`main`): native frame, dark theme, created hidden and shown by Rust after the
  startup decision. With **Minimize to tray** on, close and minimize hide it and tracking
  continues. With it off, close quits.
- **Indicator window** (`indicator`): frameless, 320×200, always on top, no taskbar entry. It
  appears above the tray icon on left-click and hides when it loses focus. It shows the current
  app, session duration, status, pause/resume and "Open Studio Pulse".
- **Tray**: the icon colour reflects state (tracking / idle / paused or off). The tooltip names the
  app. The menu has a status line, Pause 15 min, Pause 1 hour, Pause until resumed / Resume,
  Open Studio Pulse, and Quit.
- Tracking is always visible: tray icon, tray tooltip, the indicator, and the sidebar status
  pill in the main window.

---

## 10. Settings (`Settings`, persisted in `preferences`)

```ts
general:  { theme: 'dark'|'light'|'system', startMinimized: true, minimizeToTray: true,
            launchFullWindowOnStartup: false }
tracking: { enabled: true, startAutomatically: true, pauseWhenIdle: true,
            idleTimeoutMinutes: 5 (1–120), notifications: true,
            checkpointSeconds: 15 (5–300), minimumIntervalSeconds: 2 (0–60) }
onboarding: { completed: false, completedAt: null }
```

- **Tracking starts only after onboarding**, where the user sees what is and isn't tracked and
  picks the applications to monitor.
- `pauseWhenIdle = false` disables idle detection. Time without input then counts as active, which
  suits reviewing renders or playback. The settings UI says this explicitly.
- Launch at login is **not** a stored setting. It is OS state (see §8).
- A user pause is not a setting either, but it is persisted (`meta.tracker_pause`) and takes
  precedence over `startAutomatically`: a restart never silently ends a pause.
- Phase-2 settings (workspace, data sharing, sync) are listed as unavailable, with the local-only
  status shown honestly.

---

## 11. Privacy boundaries

Collected: application id, application display name, start/end timestamps, durations,
active/idle split, device id, and (later) optional project or task attribution.

Never collected: screenshots, keystrokes, key or mouse counts, clipboard, file names or contents,
window titles, browser URLs or contents, messages. Idle detection reads only the timestamp of the
last input event (`GetLastInputInfo`), never what the input was.

Local-first: in Phase 1 nothing leaves the device. The Privacy settings page shows every stored
field, row counts, the database location, export (JSON/CSV) and deletion. See `docs/privacy.md`.

---

## 12. Frontend

- `apps/desktop/src/main.tsx` picks the view from the window label: `main` loads the workspace
  shell, `indicator` loads the compact indicator.
- `lib/api.ts` is the typed `invoke` wrapper over the `CommandMap` in shared-types, plus event
  subscriptions. It is the only file that imports `@tauri-apps/api`.
- Reports are computed in the UI by `@studio-pulse/time-engine` from raw intervals. Range
  resolution, local-day splitting (DST-safe), per-app, per-category and per-day totals,
  percentages and trends are all pure functions, unit-tested, and reused by the Phase-2 web
  dashboard.
- `@studio-pulse/ui` holds design tokens (CSS variables, dark first) and primitives. Fonts are
  Windows system faces (Segoe UI Variable, Cascadia Mono), so nothing is fetched at runtime.
- Navigation: Home, Tasks*, Notes*, Projects*, Time, Team*, Settings (*Phase 2, disabled).
  Keyboard: `Ctrl+1…7` switches sections, `Ctrl+,` opens Settings, `Ctrl+Shift+P` pauses or
  resumes.

---

## 13. Testing strategy

| Layer | Where | Runs on |
| --- | --- | --- |
| Engine scenarios (switching, idle, sleep, lock, clock, pause, min-interval, high-water) | `src-tauri/tests/engine_fixtures.rs` replaying `tests/fixtures/tracking/*.json`, plus unit tests in `engine.rs` | any OS |
| Registry matching, defaults validity | `src-tauri/src/registry` unit tests | any OS |
| Store: migrations, upsert idempotency, one-open-interval, recovery, export, delete | `src-tauri/tests/store_integration.rs` | any OS |
| Startup registration against a scratch registry key | `src-tauri/tests/startup_registry.rs` | **Windows** |
| Live Win32 probes (foreground of a spawned process, idle API, session state) | `src-tauri/tests/windows_live.rs` (`#[ignore]`, run explicitly) | **real Windows desktop** |
| TS packages (ranges, time zones/DST, aggregation, overlap, validation, registry JSON) | `tests/unit/**` (vitest) | any OS |
| Manual verification (Figma, After Effects, Blender, login launch, sleep, restart) | `docs/testing.md` checklist + `examples/probe.rs` | **real Windows install** |

---

## 14. Phase 2A: Supabase sync (built) and Phase 2B seams

Phase 2A is built; the full operator guide is [docs/supabase.md](supabase.md).

- **Remote schema** (`supabase/migrations`): `profiles`, `workspaces`, `workspace_members`,
  `workspace_invitations`, `projects`, `tasks`, `notes`, `time_entries`. RLS is enabled on every
  table and grants follow least privilege. Membership changes only through role-checked
  `SECURITY DEFINER` functions.
- **Sync** (`src-tauri/src/cloud`). The local `tracking_events` table is the outbox. A single
  sync thread uploads closed, pending intervals of the signed-in user through the
  `sync_time_entries` RPC, which is idempotent (keyed by the tracker's UUIDv7) and returns one
  result per entry. Rows are marked `synced` only on confirmation. Invalid rows are kept as
  `failed`. Transient failures back off (5 s to 15 min, ±20 % jitter). This deliberately differs
  from the Phase 1 seam note: only **closed** intervals sync, so remote rows are immutable and no
  revision merge is needed.
- **Identity**. Sign-in happens in Rust (Supabase Auth REST). The refresh token lives in Windows
  Credential Manager; the access token stays in memory; the webview never sees either. New
  intervals are stamped with the signed-in user id. Intervals recorded while signed out are
  uploaded only after an explicit claim. Session expiry never deletes local rows.
- **Visibility**. Time entries are private to their owner. A workspace owner can let
  owners/admins read members' entries (`time_entry_visibility = 'admins'`).
- **Phase 2B seams**. Projects, tasks and notes tables and policies exist, with note
  `version`-based conflict detection, but there is no UI yet.

---

## 15. Decision log

| # | Decision | Why |
| --- | --- | --- |
| D1 | Tracker and accounting engine in Rust, reporting maths in TS | Background reliability with no webview; TS maths reused by the Phase-2 web app |
| D2 | Poll at 1 Hz instead of `SetWinEventHook` | Simple, robust under heavy CPU load (renders), ±1 s boundary accuracy is adequate, no message-loop coupling |
| D3 | Sample-and-hold crediting + continuity check | One rule handles sleep, hangs and clock changes without OS power notifications |
| D4 | One row per interval, checkpointed | Satisfies "intervals, not per-tick writes" and crash safety |
| D5 | Own registry-based startup instead of autostart plugin | Read-back verification and StartupApproved visibility |
| D6 | Native dialogs opened from Rust | The UI never supplies file paths, so no arbitrary-path writes |
| D7 | npm workspaces, packages as TS source | No extra package manager, no package build step |
| D8 | Tracking requires onboarding consent | Transparency; no covert monitoring |
| D9 | Idle detection always on unless the user explicitly turns it off | Idle time is never silently counted as active |

---

## 16. Known limitations

These are deliberate trade-offs or platform limits, not bugs. Each is pinned by a test or fixture
where one is possible.

| Limitation | Effect | Why / mitigation |
| --- | --- | --- |
| Idle relabelling reaches back only within the open interval | If another app takes focus (a render finishing, a notification) or the screen locks **before** the idle threshold is reached, the no-input time since the last input stays credited to the previous app as **active**: at most one idle threshold (default 5 min). Fixture: `focus-stolen-from-tracked-app-while-away.json`. | Closed intervals are immutable so they can be synced idempotently. A lower idle timeout reduces the window. |
| 1 Hz sampling | Interval boundaries are accurate to about one second. Switches shorter than the minimum interval (default 2 s) are discarded as alt-tab flicker. | Simple, robust polling under heavy render load (D2). |
| Crash or power loss | Up to one checkpoint window (default 15 s) of the open interval is lost: under-counted, never over-counted. | Lower `checkpointSeconds` (minimum 5 s) for less loss. |
| Windows sign-out or shutdown while the app runs | Usually closed gracefully. If Windows ends the process first, the next start closes the interval at its last checkpoint (`recovered`). | Same bound as a crash. |
| Clock moved backwards | Recording holds (`clockBehind`) until the wall clock passes the latest recorded instant, so the same instant is never counted twice. | Large manual clock changes are rare; NTP corrections are seconds. |
| UWP apps starting or suspended | `ApplicationFrameHost.exe` without a hosted child is reported as itself and matches nothing. | None of the target creative apps are UWP. |
| Browser-based Figma | Not detected (the browser is the foreground process). | Opt-in browser detection is a later-phase item. |
| Automatic measurements | Foreground and active time are not billable time and are not attributed to projects automatically. | Attribution arrives with Phase 3, always as a user action. |

