# Studio Pulse

**Capture work quietly. Keep tasks and notes effortless. Share useful information with the team
without turning the app into employee surveillance.**

Studio Pulse is a lightweight Windows companion for creative teams working in graphic design,
brand identity, motion, video and 3D. It records which creative application is in the
foreground, separates **active** time from **idle** time, and shows honest daily and weekly totals.
Nothing is uploaded unless you sign in to a workspace, nothing is hidden, and nothing beyond the
application name and timing is collected.

> **Status: Phase 1 (desktop tracking), Phase 2A (Supabase accounts, workspaces, RLS and desktop
> sync), Phase 2B (the team workspace: projects, tasks, notes and time attribution, in
> `apps/web`) and Phase 3A (analytics in the workspace: an Analytics page and project
> Insights).** The desktop app runs on Windows 10/11; the workspace runs in any modern browser.
> Quick capture, manual time entries and billable time are not built yet. macOS and Linux
> desktops are not supported.

## What Phase 1 does

- **Automatic tracking of creative apps.** Real foreground detection through Win32
  (`GetForegroundWindow` → process image) with an editable registry of 21 built-in apps: Figma,
  Photoshop, Illustrator, After Effects, Premiere Pro, Media Encoder, InDesign, Audition,
  Lightroom, Substance 3D Painter, Affinity Designer, CorelDRAW, Inkscape, DaVinci Resolve,
  Blender, Cinema 4D, Houdini, Krita, GIMP, Framer and VS Code. You can add any other `.exe`.
- **Active vs idle.** Idle after a configurable timeout (default 5 minutes), applied
  retroactively, so a 60-minute Photoshop session with 20 minutes away reports 60 m foreground,
  40 m active and 20 m idle.
- **Reliable accounting.** Sleep, lock screen, clock changes, crashes and restarts are handled.
  The same instant is never counted twice. Intervals are persisted locally in SQLite and survive
  restarts.
- **Launch at Windows sign-in.** Off by default, verified against the registry, and never shown as
  on unless Windows actually has it. It can start quietly in the tray.
- **Tray and compact indicator.** Current app, session timer, pause (15 min / 1 h / until resumed),
  resume, and open the workspace.
- **Dashboard.** Today, Yesterday, Last 7 / 30 days, or a custom range. Time by application and
  category, daily and weekly trends, and a day timeline, all computed from the stored intervals.
- **Privacy controls.** Onboarding consent before anything is recorded, every stored field
  listed, JSON/CSV export, and history deletion. See [docs/privacy.md](docs/privacy.md).

## What Phase 2B adds: the team workspace

A static web app (`apps/web`) on the same Supabase project, with every read and write checked by
Row Level Security:

- **Projects** with planning / active / on hold / completed / archived states, a lead, start and
  due dates, their tasks, notes and tracked time. Archive and restore; a project with work
  attached can't be deleted, so history is never detached.
- **Tasks** in My tasks, All tasks and per-project views, with filters, assignment to active
  members only, status, priority, due dates, checklists and comments.
- **Notes**, personal or shared and optionally tied to a project, with autosave, conflict
  detection and local drafts that survive a lost connection or a closed tab.
- **Time attribution.** Your synced desktop sessions can be attributed to a project and
  optionally a task. Measured values are never changed, nothing is inferred from application
  names, and foreground and active time are not billable time.
- **Live updates** between teammates through Supabase Realtime, subject to RLS.

The workspace is online-only; the desktop tracker still works fully offline. The desktop's Tasks,
Notes and Projects entries open the workspace when the build links to one. See
[docs/workspace.md](docs/workspace.md).

## What Phase 3A adds: analytics

- **Analytics page.** *My work* and *Workspace* views of synced time for a range: active,
  foreground, idle and unattributed totals, activity by day, week or month, time by application,
  project and task, task progress and deadlines, and recent sessions. Days follow a reporting time
  zone you choose. Summary and session exports in CSV and JSON.
- **Project Insights** on each project page: the project's time and task progress over all time
  or the last 90 or 30 days.
- **Added up on the server, under RLS.** One read-only function (migration 10) runs as the
  signed-in user, so members see only their own time and owners and admins see teammates' time
  only when the workspace owner allows it. Overlapping time from several devices is counted once.
  No scores, rankings or judgements; people are listed alphabetically. See
  [docs/workspace.md §8](docs/workspace.md#8-analytics-phase-3a) and
  [docs/privacy.md](docs/privacy.md#analytics-in-the-team-workspace).

## Quick start (development)

Prerequisites: Windows 10/11, Node.js ≥ 22, Rust (stable, MSVC), Visual Studio Build Tools with
the C++ workload and a Windows SDK, and WebView2 (preinstalled on Windows 11). Details are in
[docs/installation.md](docs/installation.md).

```bash
npm install
npm run dev          # Tauri dev build with hot-reloading UI
npm test             # TypeScript (vitest) + Rust (cargo test)
npm run build        # release build + NSIS installer
npm run dev:web      # team workspace on http://127.0.0.1:5180 (needs apps/web/.env.local)
npm run build:web    # static workspace build in apps/web/dist
```

## Verification status (Phase 1)

Automated, all passing on Windows 11 (build 26200):

| Suite | Tests |
| --- | --- |
| TypeScript: time-engine, validation, desktop UI logic, cross-package reconciliation (vitest) | 480 |
| Rust: engine, registry, settings, store, platform, startup, window logic (`cargo test --lib`) | 124 |
| Engine scenario fixtures (30) + 2,000 randomized streams (`engine_fixtures`) | 3 |
| Tracker service with fake probe/clock, incl. simulated storage failures (`service_integration`) | 17 |
| Store integration: migrations, idempotency, recovery, secure deletion (`store_integration`) | 34 |
| Startup registration against a scratch registry key (`startup_registry`) | 11 |
| Live Win32 probes, incl. a frozen "Not Responding" window (`windows_live`, `--ignored`) | 8 + 1 |

Verified end-to-end with the real app on this machine:

- Real foreground detection of Figma Desktop and Adobe After Effects during actual use. The tracker
  matched the raw foreground within one 1 Hz poll.
- A 3-hour system sleep was detected as a time gap and not credited.
- Launch at login was written, read back and removed in the real `Run` and `StartupApproved` keys. An
  `--autostart` launch started tray-only or showed the compact indicator, as configured.
- "Pause until I resume" stayed paused across a real quit and relaunch.
- The webviews were refused tray, menu, image and event-emit APIs, and the indicator was refused
  settings changes.

Phase 2A and 2B were verified against a real Supabase project (`studio-pulse-dev`): their nine
migrations applied, all 35 RLS/RPC checks passing as real users through the publishable key, the
workspace's data layer passing its live suite as three real users, and both Rust live tests (the
HTTP contract and the full desktop sync pipeline) passing. See
[docs/supabase.md §3](docs/supabase.md#3-verify-against-the-real-project).

Phase 3A adds a tenth migration (`20261112090000_analytics.sql`), tested on a Supabase-shaped
Postgres (PGlite) and against an independent TypeScript implementation
([docs/testing.md](docs/testing.md#phase-3a-analytics)). Apply it with `npm run supabase:migrate`
before using Analytics; without it the page says the database needs migration 10.

Still to do on a real install (see [docs/testing.md](docs/testing.md#3-manual-windows-verification-checklist)):
run the installer, sign out/in or reboot with launch at login enabled, and check Blender detection.

## Repository layout

| Path | What |
| --- | --- |
| `apps/desktop` | Tauri 2 app: React UI (`src/`) and Rust core (`src-tauri/`) |
| `apps/web` | Team workspace (Phases 2B and 3A): React + Vite static app on Supabase — see [docs/workspace.md](docs/workspace.md) |
| `packages/shared-types` | Rust⇄UI contract types + built-in application registry JSON |
| `packages/validation` | zod schemas for settings, applications and inputs |
| `packages/time-engine` | Reporting maths: ranges, time zones, day splitting, aggregation, and the analytics reconciliation (`reconcileIntervals`, `summarizeReport`) |
| `packages/ui` | Design tokens, React primitives, SVG charts |
| `packages/database` | Typed Supabase client factory, `Database` types matching the migrations, publishable-key-only config validation |
| `supabase/` | Ten ordered Postgres migrations with RLS and RPCs (Phases 2A, 2B and 3A) — see [docs/supabase.md](docs/supabase.md) |
| `tests/` | TS unit and integration tests, live tests against a real project (`tests/live`), and shared tracking scenario fixtures |
| `docs/` | [Architecture](docs/architecture.md), [installation](docs/installation.md), [privacy](docs/privacy.md), [Supabase](docs/supabase.md), [workspace](docs/workspace.md), [testing](docs/testing.md) |

## Documentation

- [docs/architecture.md](docs/architecture.md) covers the process model, accounting rules,
  registry, storage, the command allowlist, startup and the Phase-2 seams.
- [docs/installation.md](docs/installation.md) covers building, installing and launch-at-login.
- [docs/supabase.md](docs/supabase.md) covers the Supabase project, migrations, RLS, sync and the
  analytics function.
- [docs/workspace.md](docs/workspace.md) covers the team workspace: setup, deployment, security,
  conflicts, offline behaviour, time attribution and analytics.
- [docs/privacy.md](docs/privacy.md) lists exactly what is and isn't recorded.
- [docs/testing.md](docs/testing.md) covers automated tests and the manual Windows checklist.
- [docs/ui-restyle.md](docs/ui-restyle.md) records the Figma restyle, review fixes and Windows/browser verification.
- [Known limitations](docs/architecture.md#16-known-limitations) lists accuracy bounds and
  deliberate trade-offs.
