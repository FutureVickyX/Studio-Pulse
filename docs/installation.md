# Studio Pulse — Installation and build

Studio Pulse Phase 1 targets **Windows 10 (1809+) and Windows 11, x64**. Other platforms are not
supported.

## 1. Install a released build

1. Run `Studio Pulse_<version>_x64-setup.exe`.
   - It installs **per user** into `%LOCALAPPDATA%\Studio Pulse` and needs no administrator rights.
   - WebView2 is preinstalled on Windows 11. On Windows 10 without it, the installer downloads the
     Evergreen bootstrapper from Microsoft.
   - The build is not code-signed yet. SmartScreen may show "Windows protected your PC". Choose
     **More info › Run anyway** only if you trust where the installer came from.
2. Launch **Studio Pulse** from the Start menu.
3. Complete onboarding. Nothing is recorded before this step.
   1. Read what is and isn't tracked.
   2. Choose the applications to monitor.
   3. Optionally turn on **Launch Studio Pulse when Windows starts**.
4. Tracking starts. The tray icon (bottom right, possibly behind the `^` overflow arrow) shows
   the state: coral means tracking, amber means idle, dimmed means on standby (no tracked app in
   focus), grey means paused or off.

Uninstall with **Settings › Apps › Installed apps › Studio Pulse › Uninstall**. Your local data
stays in `%APPDATA%\com.studiopulse.desktop` until you delete that folder. You can also use
**Settings › Privacy › Delete history** before uninstalling.

## 2. Launch at Windows sign-in

**Settings › General › Launch at Windows startup** (or the onboarding step).

- Off by default.
- Turning it on writes a per-user entry (no admin rights):
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `Studio Pulse` =
  `"<install path>\Studio Pulse.exe" --autostart`. It also marks the entry as enabled under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`.
- Studio Pulse reads both values back after writing them. The toggle only shows **on** if the read-back
  matches. Otherwise it shows the error and stays off.
- If you disable Studio Pulse in **Task Manager › Startup apps** (or **Settings › Apps ›
  Startup**), Studio Pulse shows "Windows has disabled Studio Pulse in Startup apps". Turning
  the toggle on again re-enables it.
- Turning it off deletes both values and verifies they are gone.
- With **Start minimized** on (the default), a sign-in launch shows only the tray icon. With it off,
  Studio Pulse opens the compact indicator, or the full window if **Launch full window on startup**
  is on.
- Only one instance runs. Launching again brings the existing window forward.
- Unfinished intervals from the previous session (power loss, crash) are closed at their last
  checkpoint on start. Sleep, shutdown and powered-off time are never counted.

Development builds register the development executable. The setting shows a "development build"
note. Turn the setting off before deleting a dev build.

## 3. Build from source

### Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Windows | 10 / 11 x64 | |
| Node.js | ≥ 22 (tested with 24) | npm ≥ 10 |
| Rust | stable (tested with 1.99), `x86_64-pc-windows-msvc` | `rustup default stable-msvc` |
| Visual Studio Build Tools | 2022 or 2026 | "Desktop development with C++" workload (MSVC + Windows 11 SDK) |
| WebView2 Runtime | Evergreen | preinstalled on Windows 11 |

### Commands

```bash
git clone https://github.com/FutureVickyX/Studio-Pulse.git
cd Studio-Pulse
npm install
npm run dev        # dev app: Vite on 127.0.0.1:1420 + debug Rust build
npm test           # vitest + cargo test
npm run build      # release build + NSIS installer
```

The installer is written to
`apps/desktop/src-tauri/target/release/bundle/nsis/Studio Pulse_<version>_x64-setup.exe`. If
`CARGO_TARGET_DIR` is set, look under `$CARGO_TARGET_DIR/release/bundle/nsis/` instead. The
first `npm run build` downloads the NSIS toolchain used by the Tauri bundler.

### Repositories inside OneDrive or Dropbox

The Rust `target` directory grows to several GB with tens of thousands of files. Syncing it slows
builds down and can cause "Access is denied" errors while files are locked. Point Cargo outside
the synced folder:

```powershell
setx CARGO_TARGET_DIR "%LOCALAPPDATA%\studio-pulse-build\target"
```

Then open a new terminal.

### Manual verification tools

```bash
npm run probe                  # foreground app, registry match, idle seconds, session state, every second
npm run probe -- --list        # running apps with visible windows and their registry match
npm run test:windows-live      # live Win32 tests (interactive desktop session required)
```

See [testing.md](testing.md) for the full manual checklist.

## 4. Where things live

| What | Where |
| --- | --- |
| Database | `%APPDATA%\com.studiopulse.desktop\studio-pulse.sqlite3` (WAL mode; `-wal`/`-shm` side files) |
| Logs | `%LOCALAPPDATA%\com.studiopulse.desktop\logs\studio-pulse.log` (rotated at 2 MB; no titles, paths or file names) |
| Startup entry | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `Studio Pulse` (only when enabled) |
