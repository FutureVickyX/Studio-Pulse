# Studio Pulse — Team workspace (Phases 2B and 3A)

The team workspace (`apps/web`) is where a studio plans and shares work: projects, tasks with
checklists and comments, personal and shared notes, attribution of synced desktop time to
projects and tasks, and (Phase 3A) analytics of that time (§8). It is a static React app with no server of its own. It talks to the same
Supabase project as the desktop app, with the publishable key and the signed-in user's session,
so Row Level Security decides every read and write.

The desktop tracker is unchanged. It keeps recording and syncing exactly as in Phase 2A. Its
**Tasks**, **Notes** and **Projects** entries (Ctrl+2, 3, 4) open these pages in the browser when
the desktop build links to a workspace (§3.3).

## 1. Pages

| Page | What it shows |
| --- | --- |
| **Overview** | Your work in progress (open tasks assigned to you, in progress, in review, overdue), your open tasks most urgent first, the team's open tasks that are overdue or due in the next 14 days, and recently updated projects and notes. A new, empty workspace gets a getting-started state; every list has its own empty state. The sidebar shows the workspace, you and your role. |
| **Projects** | Projects with lead, start date, last update, task progress (done / total), due date and status. Views: Current, Completed, Archived and All; search. Owners and admins create projects. |
| **Project** (`#/projects/<id>`) | Details, edit (version-checked), archive / restore, delete (only while nothing is attached). Its tasks, its notes and **Insights** on the time attributed to it (§8.3). |
| **Tasks** | *My tasks* (assigned to you) and *All tasks*, grouped by status. Filters: status, project, assignee and priority; search by title. A project's tasks are on its page. A task opens as a panel over any page (`?task=<id>`). |
| **Task panel** | Title, description, status, priority, assignee (active members only), project, start and due dates. Checklist (subtasks), comments, archive / restore, delete (only without tracked time), and the time attributed to the task. |
| **Notes** | Personal (private) and shared notes, filtered by scope, project and archived; search by title and text. The editor autosaves (§5.2). Owners share or unshare, move to a project, pin, archive and delete. |
| **Time** | Your synced desktop sessions for Today, Yesterday, 7 days or 30 days, with active and foreground totals overall and by project; filter by application to see one application's totals. Select sessions and attribute them to a project and optionally a task, or clear the attribution. Days here group sessions by the day they started; Analytics splits sessions at midnight and counts overlapping time once, so totals can differ slightly. |
| **Analytics** (`#/analytics`) | Recorded time and task progress for a range, for your own work or the workspace (§8). |

The layout is a sidebar on desktop widths and a top bar with a slide-over menu at 760 px and below. It has one colour
palette (no light or dark switch) and uses `@studio-pulse/ui`, the same tokens and
primitives as the desktop app.

## 2. Run it locally

1. Apply every migration in `supabase/migrations` to the project ([supabase.md §2](supabase.md#2-apply-the-migrations)).
2. Copy `apps/web/.env.example` to `apps/web/.env.local` (gitignored) and fill in the two public
   values: `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. Start the dev server:

```bash
npm run dev:web
```

4. Open `http://127.0.0.1:5180`. Sign in with an existing account or create one, then create a
   workspace or join one with an invitation code. Invitations are created in the desktop app
   (**Settings › Workspace**) by an owner or admin.

Without the two values the page explains what is missing instead of failing.

## 3. Build and deploy

### 3.1 Build

```bash
npm run build:web
```

The static site is written to `apps/web/dist`. The Supabase URL and publishable key are embedded
at build time from `apps/web/.env.production.local`, `.env.local`, or `VITE_*` environment
variables. **The build refuses a secret or service-role key** in the publishable-key slot
(`vite.config.ts` uses the same classifier as the desktop's `build.rs`), and so does any other
`VITE_*` value that looks like a secret key or a database connection string. After building, run
`npm run check:secrets:web`, which scans `apps/web/dist` on its own. `npm run check:secrets` scans
it too, together with the desktop release outputs, and so needs a desktop release build first.

### 3.2 Host

Any static host that serves over HTTPS works (Netlify, Vercel, Cloudflare Pages, S3 and
CloudFront, nginx). Routes are hash-based (`#/tasks`), so no rewrite rules are needed. Then set
up Supabase Auth for that address:

- **Authentication › URL Configuration › Site URL**: the workspace's address, for example
  `https://workspace.example.com`. Sign-up confirmation links lead there.
- **Redirect URLs**: add the same address, plus `http://127.0.0.1:5180` for local development
  if you want confirmation links to work locally. Sign-up asks Supabase to send the confirmation
  link back to the address the page was opened from; Supabase honours that only for addresses on
  this list and otherwise falls back to the Site URL.
- Keep **Confirm email** on ([supabase.md §1](supabase.md#1-set-up-a-project)).

### 3.3 Link the desktop app to it

Set `STUDIO_PULSE_WORKSPACE_URL` when building the desktop app:

```powershell
$env:STUDIO_PULSE_WORKSPACE_URL = "https://workspace.example.com"
```

The address must be `https://` (or `http://` on `localhost` / `127.0.0.1` for development). It is
compiled in, and Rust opens `<url>/#/<section>` in the default browser. The webview never chooses
the address. Without it, the desktop's Tasks, Notes and Projects entries say the build doesn't
link to a workspace. Debug builds also read the variable at runtime.

## 4. Security model

- **Publishable key only.** The bundle contains the project URL and the publishable key, which
  are public by design. Everything else is decided by RLS for the signed-in user. The secret key,
  the database URL and service-role access never reach the browser.
- **Session.** supabase-js keeps the session in the browser's `localStorage` for this site.
  Anyone who can use that browser profile can use the session until it expires or you sign out.
  **Sign out** ends the session on this browser only, so other devices stay signed in.
- **Unsaved note text** (§5.2) is kept in the same `localStorage`, keyed by your account, so
  another account signing in on this browser never sees it. Signing out does not erase it: it is
  offered again when you sign back in here. On a shared computer, don't leave unsaved notes behind.
- **Realtime.** The page subscribes to `projects`, `tasks`, `task_subtasks`, `task_comments` and
  `notes` changes in the open workspace. For inserts and updates, Supabase checks RLS for every
  subscriber and the page filters by workspace, so a private note's contents never reach anyone
  but its owner (verified live, §9). **Deletes are different:** Supabase can neither filter nor
  RLS-check DELETE events, so every signed-in subscriber to these tables receives the id (only
  the id: no title, text or workspace) of every deleted row in the project, with its timing. The
  page refetches only for deleted rows it holds. Events only trigger a refetch, which is again
  subject to RLS.

Who may do what, enforced in the database (`supabase/migrations`, tests in
`tests/integration/supabase`):

| Table | Select | Insert | Update | Delete |
| --- | --- | --- | --- | --- |
| `projects` | members | owners/admins, as creator; lead must be an active member | owners/admins, or the project's lead (only owners/admins change the lead; a new lead must be an active member) | owners/admins, and only when no tasks, notes or time are attached |
| `tasks` | members | members, as creator; assignee must be an active member | creator, assignee or owner/admin (a new assignee must be an active member) | creator or owner/admin, and only without tracked time |
| `task_subtasks` | members | anyone who may edit the task | anyone who may edit the task | anyone who may edit the task |
| `task_comments` | members | members, as author | the author | the author, or owners/admins |
| `notes` (private) | the owner | the owner | the owner | the owner |
| `notes` (shared) | members | the owner | members edit title and text; only the owner changes sharing, project, pin or archive | the owner, or owners/admins |
| `time_entries` | the owner (plus owners/admins if the workspace allows) | the owner, as themselves, while an active member (the desktop does this through `sync_time_entries`; the workspace never creates sessions) | the owner, `project_id` and `task_id` only | the owner |

"Members" means active members of that workspace. Removed members lose access to everything except
their own time entries, as in Phase 2A. A project or task that still names a former member as
lead or assignee stays editable; the page marks that person as a former member, and choosing a
new lead or assignee requires an active member.

## 5. Concurrency, retries and conflicts

### 5.1 Projects and tasks

- **Creates happen once.** Each new project, task, checklist item, comment and note carries an id
  generated in the browser. A network failure is retried with the same id. If an earlier attempt
  already landed, the database answers "already exists" and the page uses that row. The id belongs
  to the draft, so pressing Create again after a failure doesn't add a second row either.
- **Edits are version-checked.** Every project, task and note has a `version` the database
  increments on each update. The page saves only on top of the version it showed you. If someone
  else saved first, nothing is overwritten. The form or panel shows their version and says so.
- **The task panel** saves each change as you make it: a select at once, a text field when you
  leave it, a date when you leave it or press Enter (only a complete date, year 1900 or later).
  Changes made while a save runs are queued, so the control you used keeps focus, and each goes
  out on the version you were looking at when you made it. A field you aren't editing follows
  teammates' changes live; a field you are editing keeps your text. If a teammate changed what you
  changed, your change isn't applied and a banner names it until you make it again or dismiss it.
  Closing the panel (Escape, Back, the close button) saves edits still in a field; if one of
  those runs into a teammate's change, a notice says so instead.
- **The project dialog** saves on top of the version it opened with, so a teammate's save while
  it is open comes back as a conflict. It sends only the fields you changed.
- **Double submits are ignored** while a save is in flight. Notices also appear over an open
  dialog.

### 5.2 Note autosave

- Typing schedules a save 800 ms after the last keystroke. The editor shows **Saving…**,
  **Saved** (with the time), **Not saved — offline. Retrying; your text is kept on this device**,
  **Not saved —** followed by the reason, or **Not saved — changed by someone else**.
- Each save is sent on top of the version the editor last saw. If a teammate saved the shared note
  meanwhile, the save becomes a **conflict** instead of overwriting their text. You choose **Keep
  my version** (save your text on top of theirs) or **Use theirs** (discard your unsaved text).
  Your own save whose response was lost, or its realtime echo, is recognised as yours and is not
  reported as a conflict.
- Network, rate-limit and unexpected failures retry after 2 s, 5 s and 15 s, then every 30 s
  until the save goes through. Failures that retrying can't fix (session, permission, a note that
  no longer exists, invalid input) stop until you change the text or press **Retry now**; the
  editor says what happened. A note body over 1 MB (1,000,000 bytes of UTF-8, the database's
  limit) is not sent at all; the editor asks you to shorten it and keeps the text.
- Unsaved text is also kept in this browser's `localStorage`, under your account, until the
  server confirms it. After a crash, a closed tab or a reload while offline, reopening the note
  offers **Restore them** or **Discard** for the unsaved changes. If the note was saved since that
  text was written, restoring opens the conflict choice above instead of overwriting the newer
  version.
- Sharing, moving, pinning and archiving a note wait for any text save in flight and are
  version-checked too, so they never race your typing.
- Leaving the note, switching notes or closing the editor flushes pending edits. A late response
  from an earlier save never replaces newer text.
- Updates from teammates arrive by realtime. While you have unsaved changes or a save is in flight,
  incoming versions are held back, so your typing isn't replaced.

## 6. Offline behaviour

The workspace is **online-only**. Being honest about what that means:

- Lists and pages need a connection to load. Data already loaded stays on screen (it is held in
  memory, not stored), and the page refetches when the browser comes back online, regains focus
  or the realtime channel reconnects.
- Creating or editing projects, tasks, checklists and comments while offline fails with "Can't
  reach Supabase". Nothing is queued. Retry once you are back online; creates still won't
  duplicate (§5.1).
- **Note text is the exception.** It is kept locally and retried (§5.2), so typing offline isn't
  lost as long as the browser's storage survives.
- The **desktop tracker** keeps working fully offline and syncs later (Phase 2A). Time attribution
  happens in the workspace, after sessions have synced.

## 7. Time attribution

- The workspace has no way to create sessions: they come from the desktop's sync. The tracker
  measures them; the workspace never edits a start, end, application, active or idle value. The
  database grants clients update on `project_id` and `task_id` only.
- **Foreground** is how long an application was in front. **Active** excludes idle periods. Both
  are shown separately, and **neither is billable time**. Manual time entries and billable flags
  are Phase 3. Nothing is attributed automatically, and no project is inferred from an
  application name.
- Attribution is always a user action on your own sessions: select sessions on the Time page,
  then choose a project and optionally a task. `set_time_entry_attribution` updates at most 1,000
  sessions per call (the page sends larger selections in chunks) and returns how many changed.
- Choosing a task sets the project to the task's project. **Moving a task to another project
  moves its time with it** (everyone's, done by the database), so a task's time is always counted
  on the project the task belongs to. Archived projects and tasks keep the time they have but take
  no new time, so moving a timed task into an archived project is refused.
- **No double counting.** A session has at most one project and one task. Totals add
  `ended_at − started_at` of distinct sessions, so a project total includes its tasks' time
  exactly once.
- **History is preserved.** A project with tasks, notes or tracked time can't be deleted, and a
  task with tracked time can't be deleted. Archive them instead: they disappear from the default
  lists and keep everything attached.
- Who sees whose time follows the workspace's time-entry visibility (Phase 2A): by default only
  your own. Project and task totals therefore show the time you can see, and the page says so.

## 8. Analytics (Phase 3A)

Totals are added up on the server by `analytics_time_summary` (migration 10,
[supabase.md §5](supabase.md#analytics-phase-3a-migration-10)), which reads time entries as the
signed-in user, so RLS decides whose time counts. The page never downloads a tracking history to
add it up, and the UI's own guess about visibility never widens what is shown.

### 8.1 The Analytics page

- **Views.** *My work* shows your own time: Active, In foreground, Unattributed (Idle instead
  while a project filter is set) and Sessions tiles; activity over time (by day, week or month, or
  a timeline of your sessions when the range is one day); time by application, project and task;
  your task progress; your open tasks overdue or due in the next 7 days; your assigned projects;
  and your recent sessions (with *Show more*, and *Only unattributed* while no project filter is
  set). *Workspace* shows the same totals for everyone whose time you can see, or for one person
  chosen under **Time of**, plus task progress and, for everyone, a **Members** table in
  alphabetical order. A note at the top says whose time is included; where the server's answer
  differs from what the page expected, the note follows the server.
- **Sessions follow the filters.** The one-day timeline, Recent sessions and the *My sessions*
  export apply the Project and Application filters as the totals do. A project filter that hides
  all your assigned projects says so ("Not one of your assigned projects") rather than "No
  assigned projects".
- **Without teammates' visibility** (members, and owners and admins while the owner keeps time
  private), *Workspace* shows task and project progress only, with no time and no request for it,
  and links to *My work*.
- **Range and filters.** Today, Yesterday, Last 7 days (the default), Last 30 days or a custom
  range of up to 366 days from 1 January 2020. Project (a project, or Unattributed: no project and
  no task) and Application. Filters apply after overlapping time is counted once, so a filtered
  figure is a part of the unfiltered one.
- **Previous period.** The Active tile names the previous period's total as a plain reference,
  never as a change. It is left out for today alone and for a single teammate.
- **No scores, rankings or judgements.** Lists of people are alphabetical; there is no
  per-person trend for teammates. The footnote under every view with time says the figures are
  recorded application time, not billable time, and that manual time entries aren't available
  yet.
- **Refresh and freshness.** The header shows when the figures were read ("Updated HH:MM").
  Refresh reloads the report, projects, tasks and the workspace's visibility. Realtime doesn't
  cover time entries, so new sessions appear on Refresh, when the tab becomes visible again, when
  the browser comes back online or when the realtime channel reconnects. A session appears only
  after it ends on the desktop and syncs, so today lags by the session still open.
- **Errors.** A report that takes too long asks for a shorter range or a filter. A database
  without migration 10 says so. If the database doesn't know the reporting time zone, the page
  shows the report in UTC, says so, and forgets the saved zone.
- **Exports** (header › Export): *Summary CSV* and *Summary JSON* in both views, *My sessions
  CSV* and *My sessions JSON* in *My work* only. Files are named
  `studio-pulse_<workspace>_<report>_<from>_to_<to>.<csv|json>`. CSV files are UTF-8 with a byte
  order mark and CRLF line ends, and text cells that start with `=`, `+`, `-`, `@`, a tab or a
  carriage return get a leading `'` so spreadsheets don't run them as formulas. CSV columns are
  only ever appended to, and JSON files carry `formatVersion: 1`. *My sessions* holds your own
  sessions overlapping the range that match the filters (and *Only unattributed*, when it is
  on): the same sessions as Recent sessions, whole and not reconciled, so it can add up to more
  than the summary. It is refused past 50,000 sessions. Export waits until the project and task
  names it is labelled with have loaded.

### 8.2 Time zones

Days are calendar days in the **reporting time zone**: the browser's by default, or the one
chosen in **Report settings**. Each request sends the zone's IANA name; the server uses it for
that request only and doesn't store it. A day starts at the first instant of its date, so a
day with a skipped midnight starts later and one with a repeated midnight starts at the earlier
instant. Weeks start on Monday.

### 8.3 Project Insights

Each project page has an **Insights** section in place of the old tracked-time card: Active, In
foreground and Sessions, tasks done (X of Y), activity over time, time by application and by task,
tasks awaiting review and overdue tasks. The range is *All time* (the default, by month), *Last 90
days* (by week) or *Last 30 days* (by day); the last two include today. It is labelled **Your time on
this project** or **Time you can see on this project**, depending on visibility. Task counts come
from the project's current tasks, not from the range. Deleting a project is still refused while
any time is attached.

### 8.4 Preferences

The view, range, bucket, project and application filters, reporting time zone, Insights range and
up to 20 named **saved views** are kept in this browser's `localStorage`, under your account and
the workspace (`studio-pulse:analytics:<user>:<workspace>`). They are written shortly after a
change and **survive sign-out on that browser, saved view names included**. Another account on
the same browser has its own. The person picked under **Time of** is never saved, and no filter
value or member id goes in the address. The report cache itself is held in memory and cleared on
sign-out.

## 9. Testing

| What | Where | Command |
| --- | --- | --- |
| Pure logic: filters, sorting, due dates, validation, time totals, routes, error mapping, idempotent creates, paged list reads, cache updates, task-panel text sync, autosave (debounce, conflicts, retries, flush on dispose, per-user drafts, restore, meta writes) | `tests/unit/web` | `npx vitest run tests/unit/web` |
| RLS for projects, tasks, checklists, comments, notes and attribution on a Supabase-shaped Postgres (PGlite) | `tests/integration/supabase` | `npx vitest run tests/integration/supabase` |
| Analytics (Phase 3A): the report function, its TypeScript twin, the page's pure logic, exports and rendered cards | see [testing.md, Phase 3A](testing.md#phase-3a-analytics) | `npx vitest run tests/unit/web tests/unit/time-engine tests/integration/supabase/analytics.test.ts tests/integration/supabase/analytics-oracle.test.ts` |
| The workspace's data layer against the real project, as three real users | `tests/live/workspace.live.test.ts` | see [tests/live/README.md](../tests/live/README.md) |
| Every RLS/RPC check against the real project, incl. shared-note editing and version conflicts | `scripts/supabase/verify.mjs` | `npm run supabase:verify` |

Results from the dev project are in [supabase.md §3](supabase.md#3-verify-against-the-real-project).

### Manual check of the team workflows

Use two accounts in two browsers, or one normal and one private window:

1. **A** signs in, creates a workspace and invites **B** from the desktop app (Settings ›
   Workspace). **B** signs in on the web and joins with the code.
2. **A** creates a project with **B** as lead, and a task assigned to **B** with a due date in
   three days. **B** sees it under *My tasks* and on the Overview, without reloading.
3. **B** adds checklist items and a comment. **A** sees them appear in the open task panel.
4. Both open the same task and change its title. The second save says someone else saved first and
   shows their version.
5. **A** creates a shared note and **B** a private one. **A** never sees **B**'s private note.
   Both edit the shared note at once: one gets a conflict and chooses Keep my version or Use theirs.
6. Go offline in **B**'s browser (DevTools › Network › Offline) and type in a note. It shows
   "Not saved — offline". Close the tab (the workspace has no offline app shell, so a reload while
   offline shows the browser's offline page), go back online, and reopen the note: the unsaved
   changes are offered (Restore them) and save.
7. With desktop sessions synced, **A** opens Time, selects sessions and attributes them to the
   task. The project page shows the time and the task panel shows the same time once. Move the
   task to another project: the time moves to that project's page.
8. Try to delete the project: it is refused while work is attached. Archive it instead, check it
   no longer offers itself for new time, then restore it.
9. Narrow the window to 760 px or less: navigation moves into the menu and every page stays
   usable.
10. Open **Analytics** as **B** (a member): *My work* shows only **B**'s time, and *Workspace*
    shows task progress with no time. Set the workspace's time-entry visibility to `admins` (no
    screen changes it yet: the owner calls `set_time_entry_visibility`, [supabase.md
    §5](supabase.md#5-security-model)). As **A** (owner), press Refresh: *Workspace* now shows everyone's time and
    the Members table, alphabetical. Export a summary and **A**'s sessions, and check that the
    sessions file holds only **A**'s sessions. Sign out and back in: the saved views are still
    there.
