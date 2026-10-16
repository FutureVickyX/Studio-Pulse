# Studio Pulse — Privacy

Studio Pulse measures **which creative application is in the foreground and for how long**, so
designers can see where their time goes. It is not employee monitoring. This page lists exactly
what it records, what it never records, and how you stay in control.

## What is recorded

For each stretch of time a tracked application is in the foreground, one record holds:

| Field | Example | Why |
| --- | --- | --- |
| Application id and display name | `adobe-photoshop`, "Adobe Photoshop" | Which tool |
| Start and end time (UTC) | `2026-10-13T09:15:00Z` | When |
| Active or idle | `active` | Separates working time from time away |
| Active and idle milliseconds | `2 400 000` | Totals |
| Device id | random UUID created on first launch | Distinguishes your computers |
| End reason | `appSwitch`, `becameIdle`, `sessionAway`… | Lets you audit how an interval ended |
| Project / task | empty in Phase 1 | Optional attribution later, always manual |
| Sync status, revision | `pending`, `1` | Reliable sync in Phase 2 |
| Row created / last updated (UTC) | `2026-10-13T09:15:02Z` | Bookkeeping for checkpoints and sync |

Idle detection reads one number from Windows: **the time of your last keyboard or mouse input**
(`GetLastInputInfo`). It never sees which key you pressed or where you clicked.

Only applications you enable are recorded. When any other application is in the foreground,
nothing is stored. Not even its name. Applications added to the built-in list by a later update
arrive switched off: you opt in to them in Settings › Applications.

## Never recorded

- Screenshots or screen recordings
- Keystrokes, key counts, mouse clicks or movement
- Clipboard contents
- File names, file paths or file contents
- **Window titles** (they often contain file and client names)
- Browser URLs or page contents
- Messages, emails or chats
- Microphone, camera or location

The executable path of the foreground process is read **in memory** to work out which
application it is (for example to tell Affinity's `Designer.exe` apart from another program with
the same file name). It is never written to disk with tracking records.

## Where the data lives

In this version (Phase 1) everything stays on your computer, in a SQLite database at:

```
%APPDATA%\com.studiopulse.desktop\studio-pulse.sqlite3
```

Nothing is uploaded. Studio Pulse has no account, no telemetry and no analytics. Team sharing
arrives in Phase 2. It will be opt-in, governed by a visible workspace policy, and shown in
**Settings › Privacy** and **Settings › Sync** before anything leaves the device.

A small diagnostic log is kept at `%LOCALAPPDATA%\com.studiopulse.desktop\logs\studio-pulse.log`
(2 MB, replaced when full). At its default level it records when Studio Pulse starts, recovery
counts after a crash, warnings and errors. It never contains window titles, file names, executable
paths or which application you used. History deletion doesn't touch this file. Delete it yourself if
you want it gone.

## You stay in control

| Control | Where |
| --- | --- |
| See whether tracking is on | Tray icon colour and tooltip, the sidebar status pill, the compact indicator |
| Pause for 15 minutes, 1 hour, or until resumed | Tray menu, sidebar, indicator, `Ctrl+Shift+P`. A pause survives restarts: "until resumed" means exactly that. |
| Turn tracking off entirely | Settings › Tracking › Enable tracking |
| Choose which applications are tracked | Onboarding, Settings › Applications |
| Hide an application from reports without deleting it | Settings › Applications › "In reports" |
| See every stored field, row counts and the database location | Settings › Privacy |
| Export your records (JSON or CSV) | Settings › Privacy › Export |
| Delete history older than 30 or 90 days, or everything | Settings › Privacy › Delete history. Deleted rows are overwritten in the database file and purged from its write-ahead log, so they can't be recovered with file tools. |

Tracking never starts until you finish onboarding, where these points are explained.

## Principles

- **No hidden monitoring.** Tracking is always visible and can always be paused.
- **Automatic measurements are labelled as such.** Foreground time isn't billable time, and
  long hours aren't productive hours. Studio Pulse doesn't score or rank people.
- **Minimum data.** If a field isn't needed for reliable time totals, it isn't collected.
