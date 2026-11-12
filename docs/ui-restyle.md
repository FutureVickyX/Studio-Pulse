# Figma restyle verification

Verified on Windows on 12 November 2026. The underlying shared workspace is the Phase 2B
implementation in commit `1c4fa72`; this change finishes the subsequent Figma restyle.

## Design and implementation

The reference is the **Sign in** and **Create account** frames in the
[Studiopulse Figma section](https://www.figma.com/design/hYoXpJlZnbPSFuXDmvn1D6/Personal-draft?node-id=2305-6327).

- Shared tokens, primitives, charts, web workspace and desktop surfaces use the same plum, cream,
  orange and maroon palette. Instrument Sans and Redaction 35 are bundled locally under OFL.
- Sign-in, sign-up and workspace onboarding share the responsive authentication layout. The logo
  and back-arrow assets are local SVGs. No temporary Figma asset URL is used at runtime.
- The desktop has one palette and dark native window frames. Legacy `general.theme` values remain
  readable in settings, preserving existing settings files; the theme switch has been removed.
- Flat cards, compact uppercase UI labels and maroon selections carry the reference into the
  existing workspace. User-written names and content keep their original case.
- Authentication, RLS, database migrations, synchronization and interval accounting are reused.
  This restyle adds no database migration or monitoring capability.

The unfinished review was checked against the actual code. Fixes preserve focused filter and note
title borders, make the case-preservation utility win over component styles, keep workspace and
application names in their original case, and leave long-text/executable prompts in sentence case.
Sidebar spacing, navigation focus rings, avatar shapes, label sizes and skeleton corners now agree
between the shells. The sticky time-selection toolbar stays flat.

## Executed checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed across all workspaces and the root tests. Repeated after the review fixes. |
| `npx vitest run` | 50 files, 1,099 passed. Includes workspace logic, autosave, retry/idempotency, authorization and all migrations on PGlite. |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` | Passed. |
| `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings` | Passed. |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 365 passed, 12 opt-in tests ignored. Includes the tracker, SQLite recovery/outbox, sync and 11 tests against scratch Windows startup registry keys. |
| Six opt-in Windows probe tests | Passed: own/missing process lookup, idle information, session state, application enumeration and foreground-process consistency. These do not steal focus. |
| Isolated Chrome, real local web application | Sign-in/sign-up validation, first-invalid-field focus, local font loading, offline authentication errors and no uncaught browser exceptions passed. |
| Figma reference geometry, 1440 × 748 | Both auth cards and the loaded logo proportions matched the reference within 1 CSS pixel. |
| Responsive auth screen | No horizontal overflow or clipped form at 1440 × 900, 390 × 844 and 320 × 568. |
| Browser CSS regression checks | Original-case content, sentence-case long-text placeholders and orange focus borders passed after reproducing the failures. These are component-style checks, not authenticated workspace workflow tests. |
| `npm run build:web` | Passed. |
| Windows Tauri release build | Passed; NSIS x64 installer produced (about 4 MB). |
| Bundle secret scan | Passed: 51 files, 21.3 MB across both frontends, Rust sources, release executable and installer. Only documented key-rejection-rule reference strings were allowlisted. |
| Actual Tauri/WebView2 smoke test | Passed with a separate temporary SQLite database and WebView profile: onboarding and Home; Time and six settings pages at 880 × 560; pause/resume; preserved onboarding and a persistent pause after restart. No applications were enabled for recording. |

The browser checks used a separate temporary Chrome profile and no real account credentials.
The focused style checks used the actual loaded app styles. Existing live Supabase verification
and test-data cleanup are recorded separately in [supabase.md](supabase.md); they were not rerun
for this presentation change.

The installer is under `CARGO_TARGET_DIR/release/bundle/nsis/Studio Pulse_0.1.0_x64-setup.exe`.
SHA-256 for this verification build:
`fd390929fe014a575c4cdd15f85f7e87f4f3944b9cd8784daacdb9566c92fa7f`.

## Intentional adaptations and remaining manual checks

- The primary button uses a darker orange text colour than the reference so its cream fill has
  readable text contrast. A scrim protects the mobile hero headline's contrast.
- The back arrow appears on Create account, where it returns to Sign in. The initial Sign in
  page has no previous in-app screen.
- Both production builds report a JavaScript chunk-size warning. Code splitting can be addressed
  separately without hiding or raising the warning threshold.
- The verification installer links desktop workspace navigation to `http://127.0.0.1:5180`.
  Run `npm run dev:web` for these links. A distributed build needs the deployed HTTPS workspace
  address in `STUDIO_PULSE_WORKSPACE_URL`; see [workspace.md](workspace.md#33-link-the-desktop-app-to-it).
- Authenticated web workflows still require a manual visual pass with two real accounts. Check
  Projects, the task panel, shared/private notes, conflicts, time attribution and mobile navigation
  using [workspace.md's checklist](workspace.md#manual-check-of-the-team-workflows).
- Reboot/start-at-login, sleep/resume and detection of installed creative applications were not
  repeated in this restyle pass. Use the [Windows checklist](testing.md#3-manual-windows-verification-checklist).
  The native agent and its accounting tests remain intact.

## Main changed areas

- `packages/ui/src`: tokens, fonts, logo, shared controls, cards, labels and chart styling.
- `apps/web/src/app`, `assets` and `styles`: auth layout/forms and workspace presentation.
- `apps/desktop/src`: entry screens, onboarding, navigation, tracker/settings presentation.
- `apps/desktop/src-tauri/src`: native frame theme and compatibility for stored theme settings.
- `package-lock.json`, `packages/ui/package.json`: the two bundled font packages.
- `docs/architecture.md`, `docs/workspace.md`, this report: palette, fonts and verification.

No service-role key, new Supabase client, replacement tracker or parallel synchronization engine
is introduced.
