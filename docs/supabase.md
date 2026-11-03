# Studio Pulse — Supabase backend (Phases 2A and 2B)

Phase 2A adds team identity, a workspace-scoped Postgres schema protected by Row Level Security,
and reliable upload of the intervals the desktop tracker records locally. The tracker, idle
detection and startup behaviour from Phase 1 are unchanged: everything still works offline, and
the local SQLite database stays the source of truth until the server confirms an upload.

Phase 2B adds the team workspace (`apps/web`, see [workspace.md](workspace.md)) on the same
schema: project leads, dates and statuses, task checklists and comments, shared notes that members
edit, version-based conflict detection, and attribution of synced time to projects and tasks. It
is one additive migration. Nothing from Phase 2A was replaced, and no access to data that was
protected before was widened.

## 1. Set up a project

1. Create a **new, dedicated** Supabase project for development (free tier is fine).
2. **Authentication › Sign In / Providers › Email**: keep *Email* enabled and **turn on
   *Confirm email* for any project real people use**. `accept_invitation` trusts the email in the
   user's JWT. Without confirmation, someone could register an address they don't own and
   accept an invitation sent to it. New accounts then click the emailed link before their first
   sign-in. Also turn on **leaked password protection** in the Auth password settings (it refuses
   passwords found in known breaches) where your plan offers it. The security advisor reports it
   while it is off.
3. Copy `supabase/.env.example` to `supabase/.env.local` (gitignored) and fill in:

| Variable | Where | Used by |
| --- | --- | --- |
| `SUPABASE_URL` | Project Settings › API › Project URL | desktop build, scripts |
| `SUPABASE_PUBLISHABLE_KEY` | Project Settings › API › Publishable key (or legacy `anon`) | desktop build, scripts |
| `SUPABASE_SECRET_KEY` | Project Settings › API › Secret key (or legacy `service_role`) | **local admin scripts only** |
| `SUPABASE_DB_URL` | Project Settings › Database › Connection string › *Session pooler* | migration script only |

Only the first two are needed to build the app. `npm run supabase:verify` also needs the secret
key, and `npm run supabase:migrate` the database URL. Without them on disk, apply the migrations
another way (§2) and run the same checks with users you provision yourself (§3).

The secret key and database URL **never** go into the desktop app, the frontend, the repository
or logs.
- `build.rs` refuses to compile if the configured key is a secret or service-role key.
- `npm run check:secrets` scans the built bundle and sources for leaked secrets.

## 2. Apply the migrations

Migrations live in `supabase/migrations/` and run in filename order:

| File | Contents |
| --- | --- |
| `20261017090000_identity_and_workspaces.sql` | `profiles` (created by a trigger on `auth.users`), `workspaces`, `workspace_members`, `workspace_invitations`, the authorization helpers and the privileged RPCs |
| `20261017090100_projects_tasks_notes.sql` | `projects`, `tasks`, `notes` (ready for Phase 2B) |
| `20261017090200_time_entries.sql` | `time_entries` and the idempotent `sync_time_entries` RPC |
| `20261017090300_membership_hardening.sql` | Fixes found by the RLS suite. Removal revokes the member's pending invitations. Membership changes lock the workspace row and refuse to demote or remove the last owner. Trigger functions are not executable by clients |
| `20261017090400_advisor_hardening.sql` | Fixes from Supabase's database advisors. The four RLS helpers move to a `private` schema that the API does not expose. Policies evaluate `auth.uid()` once per statement. Every foreign key gets a covering index. No behaviour changes |
| `20261017090500_owner_succession.sql` | Deleting the last owner's account no longer leaves an unmanageable workspace: the longest-standing active admin (else member) becomes owner |
| `20261017090600_text_bounds.sql` | Names, titles and uploaded application names are stored trimmed, so their length limits bound the stored value; invitation emails are capped at 320 characters |
| `20261024090000_workspace_collaboration.sql` | Phase 2B. Project statuses (planning, on hold, completed), lead, start and due dates; `version` on projects and tasks; `task_subtasks` and `task_comments`; shared notes editable by members (sharing, project, pin and archive stay owner-only); `archived_at` on notes; time attribution (`set_time_entry_attribution`); deletion guards that keep history; client-supplied ids for idempotent creates; the shared tables join `supabase_realtime` |
| `20261029090000_collaboration_fixes.sql` | Phase 2B review fixes. A project's lead and a task's assignee are validated when they change, so a project or task that still names a former member stays editable by those allowed to edit it. Moving a task to another project moves its tracked time with it (refused into an archived project) |

```bash
npm run supabase:migrate:status
```
```bash
npm run supabase:migrate
```

The runner applies each pending file in its own transaction. It records versions in
`supabase_migrations.schema_migrations`, the same table the Supabase CLI uses, so
`supabase db push` stays compatible. It prints file names only, never the connection string.

Other tools (the dashboard's SQL editor, the Supabase MCP `apply_migration`) record their own
timestamp as the version. After applying a file that way, record the file's version instead, so
that the runner and `supabase db push` see it as applied:

```sql
update supabase_migrations.schema_migrations set version = '20261017090400'
where name = 'advisor_hardening';
```

## 3. Verify against the real project

```bash
npm run supabase:verify
```

The script creates three throwaway confirmed users with the secret key, locally. It then acts
**only** as those users, through the publishable key and their own sessions, and checks that:

- sign-in works, and anonymous access is denied;
- workspace isolation holds;
- nobody can escalate their own role;
- invitations work;
- time-entry privacy is enforced;
- sync is idempotent, with no duplicates after a retry;
- invalid entries are rejected individually.

It deletes everything it created, even when a check fails.

`--keep-user` keeps one dedicated live-test user and workspace for the Rust live test
(`cargo test --test supabase_live -- --ignored`). Its credentials are written to the gitignored
`supabase/.live-test.local`; delete them later with `--delete-live-user`. If the database
certificate doesn't verify against the system CAs, set `SUPABASE_DB_SSL_CA` to Supabase's CA
certificate (Database settings). `--ssl-no-verify` is an explicit, warned opt-in. Details are in
[scripts/supabase/README.md](../scripts/supabase/README.md). Each check prints PASS or FAIL, and
any failure gives a non-zero exit code.

### Without the secret key on disk

`verify.mjs` exports `runChecks`, which takes a `provision(email, displayName)` function. An
operator can create confirmed users some other way (for example with SQL in the dashboard,
inserting `auth.users` and `auth.identities` rows with an argon2id or bcrypt password hash), hand
them to `runChecks`, and delete them afterwards. The checks themselves are the same: they act only
through the publishable key, as those users.

### Results on the dev project (`studio-pulse-dev`, 18–19 October 2026)

- `runChecks`, with three users provisioned by SQL: **35 of 35 PASS** (auth, workspaces,
  invitations, roles, sync, isolation, privacy, anon, removal).
- `cargo test --test supabase_live -- --ignored`: **2 of 2 pass**. One is the HTTP contract. The
  other is the full desktop pipeline (SQLite outbox, account manager, sync engine): claim,
  upload, a lost-response retry without duplicates, session restore from the stored refresh token,
  open intervals never uploaded, and sign-out stopping uploads.
- `cargo test --test cloud_credentials -- --ignored` (real Credential Manager): **pass**.
- Supabase security advisor: only lint 0029 for the eight RPCs in §5, which are the intended API.
  Performance advisor: only "unused index", as expected on an empty database.

### Results after the Phase 2B migration (24 October 2026)

- Migration 8 applied with the same contents as the file (only its header comment was corrected
  afterwards).
- `runChecks`, with three users provisioned by SQL: **35 of 35 PASS**. The notes check now also
  asserts that members edit shared notes, that only the owner changes sharing, and that a stale
  version saves nothing.
- `tests/live/workspace.live.test.ts`, the workspace's own data layer as three real users through
  the publishable key: **7 of 7 pass**. It covers membership listing, projects, tasks with
  idempotent creates, checklists and comments, notes, time attribution, and realtime: teammates
  received workspace changes, and a private note was never delivered to anyone but its owner. See
  [tests/live/README.md](../tests/live/README.md).
- Security advisor: still only lint 0029 for the same eight RPCs (`set_time_entry_attribution` is
  `SECURITY INVOKER`, so it isn't flagged). Performance advisor: only "unused index".

### Results after the review fixes (migration 9, 29 October – 3 November 2026)

- Migration 9 applied with exactly the file's contents (checksums match), recorded as
  `20261029090000`. The PGlite suite covers it (`collaboration.test.ts` › "former members and
  moved tasks", and the reassignment test in `tasks.test.ts`).
- `runChecks`, with three users provisioned by SQL: **35 of 35 PASS**.
- `tests/live/workspace.live.test.ts`, with the web data layer's paged list reads: **7 of 7 pass**,
  including realtime (teammates receive workspace changes, nobody receives another user's private
  note).
- Security advisor: still only lint 0029 for the same eight RPCs, plus "leaked password protection
  disabled", an Auth setting to turn on in the dashboard (§1). `tasks_move_time` is
  `SECURITY DEFINER` but not executable by clients, so it isn't flagged. Performance advisor: only
  "unused index".
- Every throwaway user, workspace and row was deleted afterwards; the project was left empty.

## 4. Build the desktop app against the project

The desktop app needs only the two public values, embedded at build time:

```powershell
$env:STUDIO_PULSE_SUPABASE_URL = "https://<project-ref>.supabase.co"
```
```powershell
$env:STUDIO_PULSE_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_…"
```
```bash
npm run build
```

Without them the app still builds and tracks normally. **Settings › Sync** then says sync isn't
configured in this build. Debug builds also read the two variables at runtime.

## 5. Security model

- **Row Level Security on every table.** Clients send the publishable key plus the user's JWT,
  so every query is evaluated as `authenticated` for that user. `anon` has no table privileges at
  all.
- **Least privilege.** Grants start from nothing: `select`/`delete` where a policy allows it,
  and column-level `insert`/`update` grants. A client cannot set `completed_at`, `version`,
  `owner_id` on update, `time_entry_visibility`, `token_hash`, and so on.
- **Membership is never client-written.** `workspace_members` and `workspace_invitations` have no
  insert, update or delete policies. Changes go through `SECURITY DEFINER` functions that check
  the caller's role first. Supabase's security advisor flags these eight (lint 0029, "callable by
  signed-in users"); that is intended, because they are the API:

| Function | Who |
| --- | --- |
| `create_workspace(name)` | any signed-in user (becomes owner) |
| `create_invitation(ws, email, role)` | owner (admin/member) or admin (member). Returns a one-time token; only its SHA-256 is stored |
| `accept_invitation(token)` | the invitee. The token must match, be unexpired, unrevoked and unused, **and** be addressed to the caller's email |
| `revoke_invitation(id)` | owner/admin |
| `set_member_role(ws, user, role)` | owner, never for themselves |
| `remove_member(ws, user)` | owner (anyone but the last owner), admin (members), anyone (leave, unless last owner) |
| `set_time_entry_visibility(ws, v)` | owner |
| `my_workspaces()` | the caller's active memberships |

- **RLS helpers are not API.** `is_workspace_member`, `has_workspace_role`, `is_active_member` and
  `shares_workspace_with` live in a `private` schema. Policies call them, but PostgREST serves only
  `public`, so they have no `/rest/v1/rpc` endpoint. `authenticated` may execute them; `anon` has
  no access to the schema.
- **Same-workspace integrity is structural.** Composite foreign keys `(project_id, workspace_id)`
  and `(task_id, workspace_id)` make a cross-workspace reference impossible. Triggers forbid
  changing `workspace_id`, or a note's owner, after insert.
- **Projects and tasks (Phase 2B).** Members read both. Owners and admins create projects. A
  project's lead may edit it, but only owners and admins change the lead. A new lead, like a new
  assignee, must be an active member; the check runs when the lead or assignee changes
  (migration 9), so a project or task that still names a former member stays editable. Members create tasks as themselves and assign only active members. The creator, the
  assignee or an owner/admin edits a task, and anyone who may edit a task edits its checklist.
  Members comment as themselves; authors edit their own comments; authors and owners/admins
  delete them.
- **Versions.** Every update to a project, task or note bumps `version`. Clients save with
  `version = <the version they showed>` and treat zero updated rows as a conflict, so nothing is
  overwritten.
- **Notes.** `private` notes are visible to their owner only. `workspace` (shared) notes are
  visible to members, and members may edit their title and text. Only the owner changes a note's
  sharing, project, pin or archive state (a trigger refuses it with `42501`), so a teammate can't
  hide a shared note from the team.
- **History is kept.** A project with tasks, notes or tracked time can't be deleted, and nor can a
  task with tracked time (`23503`, "archive it instead"). Deleting a whole workspace still
  cascades.
- **Idempotent creates.** Clients may supply the id of a new project, task, note, checklist item
  or comment. A create retried after a lost response then fails with `23505` instead of
  creating a duplicate, and the client reads back the row that landed.
- **Time entries are private by default.** Only the member who recorded them can read them. An
  owner may set the workspace's visibility to `admins`, which lets owners and admins read
  members' entries. Everything measured is immutable. Since Phase 2B, the owner of an entry may
  update only `project_id` and `task_id` (attribution), directly or with
  `set_time_entry_attribution(entry_ids, project, task)`. That function is `SECURITY INVOKER`
  and updates at most 1,000 of the caller's own entries per call. A trigger sets the project from
  the task and refuses new time on archived projects and tasks. When a task moves to another
  project, a `SECURITY DEFINER` trigger moves every entry attributed to it along (migration 9),
  so time always counts on the task's project. Members can delete their own entries.
- **Tokens stay out of the webview.** The desktop signs in from Rust. The refresh token is stored
  in **Windows Credential Manager** (`Studio Pulse/supabase/<project-ref>`); the access token stays
  in memory. The UI only receives status snapshots.

## 6. Sync semantics

| Rule | How |
| --- | --- |
| Local writes never wait for the network | The tracker writes SQLite exactly as in Phase 1. Closed intervals are the outbox (`sync_status = 'pending'`). |
| Only the owner's data is uploaded | While signed in, new intervals are stamped with the account's user id. Intervals recorded while signed out have no owner and are uploaded only after an explicit **claim** in Settings › Sync. Another account's intervals are never uploaded. |
| Never marked synced without confirmation | `sync_time_entries` returns a result per entry. Only `synced` results are marked locally. |
| No duplicates after retries | The primary key is the tracker's stable UUIDv7. Re-sending an entry the server already has (e.g. after a lost response) returns `synced` / `already present`. |
| Partial failures | Invalid entries come back `rejected`. They are kept locally (`sync_status = 'failed'`) and never retried automatically; valid siblings still sync. |
| Offline / server errors | The whole batch stays pending, and retries back off exponentially from 5 s to 15 min with ±20 % jitter. |
| One job at a time | A single sync thread, so batches never overlap. |
| Expired session | Entries stay pending, the status shows "sign in again", and nothing is deleted. |
| Started offline | The saved session restores as signed in. Memberships load on the first sync pass that reaches Supabase, without needing Refresh. |
| Workspace changed during an upload | Every request re-reads the selection first. Choosing another workspace, choosing none or signing out stops the pass; the next pass uses the new selection. Only a batch already in flight (at most 100 intervals) can still land in the previous workspace. |
| History deleted during an upload | Once the server confirms a batch, intervals deleted on this device meanwhile are deleted from Supabase too (best effort; a failure is logged). |
| Signing out | The saved sign-in, the sync workspace and the account stamp are cleared first. If one of them can't be, you stay signed in and the error is shown; the app never looks signed out while the saved sign-in survives. |
| Removed from the workspace | The upload is refused (`42501`). Entries stay pending until another workspace is chosen. |

## 7. Time zones

Every instant is stored as a UTC `timestamptz` remotely and as UTC epoch milliseconds locally. A
time entry's duration is `ended_at − started_at`, and the database enforces
`active_ms + idle_ms = duration`. Days, weeks and labels are computed in the viewer's local time
zone at display time, using `@studio-pulse/time-engine`, which is DST-safe.

## 8. What is uploaded

Each closed interval uploads these fields:
- `id`, `device_id`
- application id and name
- `kind`
- start and end
- active and idle milliseconds
- end reason
- local revision and recorded-at time
- workspace id and user id (both assigned by the server, from the session)

Never uploaded: window titles, executable paths, keystrokes, screenshots, clipboard, file names or
contents. This is the Phase 1 privacy boundary, unchanged.

The tracker never uploads `project_id` or `task_id`. They stay empty until the entry's owner
attributes it in the team workspace. Nothing assigns them automatically.

## 9. Behaviour worth knowing

These are asserted by `tests/integration/supabase`:

- **Removing a member revokes their pending invitations** in that workspace, and so does
  leaving. Re-invite after removing, not before.
- **Accepting an invitation while already a member keeps your current role.** Use
  `set_member_role` to promote someone.
- **A removed member keeps their own time entries** in that workspace and can still read or
  delete them, but cannot add new ones.
- **A removed assignee or lead stays named until someone changes it.** Since migration 9 the
  task or project stays editable by those allowed to edit it; a new assignee or lead must be an
  active member. (Before migration 9, any edit of such a task or project failed until the
  assignee or lead was changed.)
- **Deleting an account keeps every workspace managed.** Deleting a user in Authentication ›
  Users cascades to their memberships. If they were a workspace's last active owner, the
  longest-standing active admin becomes owner, or else the longest-standing active member. Removed
  members are never promoted. A workspace left with no active members keeps its rows.
- **Names and titles are stored without leading or trailing spaces.** Display names, workspace
  and project names, task titles and uploaded application names are trimmed on write.
- **Invitations stay valid after their inviter is removed or demoted.** Authority is checked when
  an invitation is created, not when it is accepted. Before removing an admin, owners can check
  the invitation list (`invited_by`) and revoke what they no longer want.
- **`workspace_invitations` has column-level SELECT without `token_hash`.** List the columns
  explicitly; `select=*` is refused.
- **A retry can name a different workspace from the original upload.** That happens if the sync
  workspace is switched after a lost response. The entry stays where it was first uploaded and
  is reported `synced` (`already present`). Nothing is duplicated or moved.

Phase 2B (`tests/integration/supabase/collaboration.test.ts` and the updated suites):

- **Choosing a task decides the project.** Attributing an entry to a task sets its project to
  the task's project, whatever the client sent. Moving the task later moves its entries too; a
  move into an archived project is refused (`22023`).
- **Archived projects and tasks keep their time but take no new time.** Restore one to attribute
  more.
- **Attribution only ever touches your own entries in the target's workspace.** That holds even for
  an owner who can read members' entries. Other ids are ignored, and the function returns how
  many rows changed. A project or task you can't see is reported as not found (`P0002`).
- **A removed member can no longer attribute.** They keep reading and deleting their own
  entries, as before. They lose task threads too, including their own comments.
- **Comments record `edited_at`** when their text changes.

## 10. Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Sync isn't configured in this build" | Build without `STUDIO_PULSE_SUPABASE_URL` / `…_PUBLISHABLE_KEY`, or the key was rejected (the message says why) |
| "Confirm your email address before signing in" | The project requires email confirmation |
| "This invitation was sent to a different email address" | Sign in with the invited email |
| Pending count doesn't fall, status "Can't reach Supabase" | Offline or project paused; retries continue automatically. "Sync now" retries immediately |
| "Couldn't finish signing out" | Windows Credential Manager or the local database refused a change. You are still signed in; try again |
| Entries marked rejected | The server judged the entry invalid. It is kept locally; the reason is in Settings › Sync |
| "This project has tasks, notes or tracked time; archive it instead" | Deleting a project with work attached is refused, to keep history. Archive it |
| "Archived projects take no new time" | Restore the project (or task) before attributing time to it |
| "Only the note's owner can change its sharing, project, pin or archive state" | Ask the owner to change it |
