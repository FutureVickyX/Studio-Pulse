# Studio Pulse

**Capture work quietly. Keep tasks and notes effortless. Share useful information with the team
without turning the app into employee surveillance.**

Studio Pulse is a lightweight Windows companion for creative teams working in graphic design,
brand identity, motion, video and 3D. It records which creative application is in the
foreground, separates **active** time from **idle** time, and shows honest daily and weekly totals.
Nothing is uploaded, nothing is hidden, and nothing beyond the application name and timing is
collected.

> **Status: Phase 1 (desktop tracking) and Phase 2A (Supabase accounts, workspaces, RLS and
> desktop sync) on Windows 10/11.** Shared projects, tasks and notes UI is Phase 2B. Quick capture and manual time entries are Phase 3. macOS and
> Linux are not supported.

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

## Quick start (development)

Prerequisites: Windows 10/11, Node.js ≥ 22, Rust (stable, MSVC), Visual Studio Build Tools with
the C++ workload and a Windows SDK, and WebView2 (preinstalled on Windows 11). Details are in
[docs/installation.md](docs/installation.md).

```bash
npm install
npm run dev          # Tauri dev build with hot-reloading UI
npm test             # TypeScript (vitest) + Rust (cargo test)
npm run build        # release build + NSIS installer
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

Still to do on a real install (see [docs/testing.md](docs/testing.md#3-manual-windows-verification-checklist)):
run the installer, sign out/in or reboot with launch at login enabled, and check Blender detection.

## Repository layout

| Path | What |
| --- | --- |
| `apps/desktop` | Tauri 2 app: React UI (`src/`) and Rust core (`src-tauri/`) |
| `apps/web` | Phase 2 web dashboard (placeholder) |
| `packages/shared-types` | Rust⇄UI contract types + built-in application registry JSON |
| `packages/validation` | zod schemas for settings, applications and inputs |
| `packages/time-engine` | Reporting maths: ranges, time zones, day splitting, aggregation |
| `packages/ui` | Design tokens, React primitives, SVG charts |
| `packages/database` | Typed Supabase client factory, `Database` types matching the migrations, publishable-key-only config validation |
| `supabase/` | Ordered Postgres migrations with RLS and RPCs (Phase 2A) — see [docs/supabase.md](docs/supabase.md) |
| `tests/` | TS unit and integration tests, plus shared tracking scenario fixtures |
| `docs/` | [Architecture](docs/architecture.md), [installation](docs/installation.md), [privacy](docs/privacy.md), [testing](docs/testing.md) |

## Documentation

- [docs/architecture.md](docs/architecture.md) covers the process model, accounting rules,
  registry, storage, the command allowlist, startup and the Phase-2 seams.
- [docs/installation.md](docs/installation.md) covers building, installing and launch-at-login.
- [docs/privacy.md](docs/privacy.md) lists exactly what is and isn't recorded.
- [docs/testing.md](docs/testing.md) covers automated tests and the manual Windows checklist.
- [Known limitations](docs/architecture.md#16-known-limitations) lists accuracy bounds and
  deliberate trade-offs.
