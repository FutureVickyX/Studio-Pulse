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
| Project / task | empty until you attribute the session in the team workspace | Optional attribution, always manual |
| Sync status, revision | `pending`, `1` | Reliable upload when sync is on |
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

Everything is recorded on your computer first, in a SQLite database at:

```
%APPDATA%\com.studiopulse.desktop\studio-pulse.sqlite3
```

Without an account nothing leaves the computer. If you sign in and choose a workspace in
**Settings › Sync**, closed intervals are uploaded to that workspace's Supabase project. The
interval still open is never uploaded. Intervals recorded while signed out are uploaded only after
you claim them in Settings › Sync. The uploaded fields are listed in the
[Supabase guide](supabase.md#8-what-is-uploaded); nothing under "Never recorded" is among them.

**No telemetry.** Studio Pulse sends no usage statistics, crash reports or other data about how
you use the app, to us or anyone else. The **Analytics** page in the team workspace is something
different: when you open it, it adds up the synced time entries you are allowed to read (see
[Analytics in the team workspace](#analytics-in-the-team-workspace)). It reads only what the
workspace already shows you: those entries, projects, tasks and members' names. It never reads
notes.

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
| Hide an application from reports without deleting it | Settings › Applications › "In reports". This device's reports only. Synced time still appears in web Analytics (yours, and owners/admins under 'admins' visibility). To keep an application's time off the server, stop tracking it. |
| See every stored field, row counts and the database location | Settings › Privacy |
| Export your records (JSON or CSV) | Settings › Privacy › Export |
| Delete history older than 30 or 90 days, or everything | Settings › Privacy › Delete history. Deleted rows are overwritten in the database file and purged from its write-ahead log, so they can't be recovered with file tools. This deletes the copy on this computer: time already synced to a workspace stays there. |

Tracking never starts until you finish onboarding, where these points are explained.

## Analytics in the team workspace

The workspace's **Analytics** page and each project's **Insights** add up synced time on the
server. They follow the same rules as every other read of time entries, enforced by the database:

- **Your time is private by default.** Members only ever see their own time, in every view, chart
  and export.
- **Owners and admins see teammates' time only when the workspace owner chose 'admins'
  visibility.** Then they see everyone's synced time in that workspace, including former members'.
  The page says which case applies; it never decides this itself, and where the server's answer
  differs from what the page expected, the note follows the server. The summary function runs as
  the signed-in user under Row Level Security, so it can't show more than a plain read would.
- **No scores, no rankings, no judgements.** Members are listed alphabetically. The previous
  period's total is shown as a plain reference (never a change or a trend), and never for one
  teammate's time.
- **Exports** (CSV or JSON) are built in your browser from the same data the page reads. A
  "My sessions" export holds only your own sessions; no export holds another member's sessions.
- **Time zone.** Each analytics request sends the reporting time zone you chose (by default your
  browser's), so days start at your midnight. The server uses it for that request and doesn't
  store it.
- **Preferences** (view, range, filters, time zone and saved view names) are kept in this
  browser's `localStorage`, per account and workspace, and survive sign-out on that browser. The
  person picked under "Time of" is never saved, and no filter or member id goes in the address.
- Applications hidden in a device's reports still appear here (see the table above), and today's
  figures leave out the session still open on your computer until it ends and syncs.

## Notifications and personal summaries

Notifications are addressed to one person and require their active workspace membership to read.
Workspace administrators cannot browse another person's notification inbox. Personal preferences
are stored per workspace; administrator outcome logs omit recipients and private payloads.

Opt-in daily/weekly summaries read only your own assigned tasks and recorded time in that
workspace. They use Analytics' reconciliation rules and label application measurements separately
from manual or billable time. Private notes are never included. Received summaries are snapshots;
late offline uploads appear in later reports. In-app delivery is the only supported channel.
See [automation.md](automation.md) for scheduling, quiet hours and data retention.

## Principles

- **No hidden monitoring.** Tracking is always visible and can always be paused.
- **Automatic measurements are labelled as such.** Foreground time isn't billable time, and
  long hours aren't productive hours. Studio Pulse doesn't score or rank people.
- **Minimum data.** If a field isn't needed for reliable time totals, it isn't collected.
