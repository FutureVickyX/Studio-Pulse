# Studio Pulse — Supabase backend (Phase 2A)

Phase 2A adds team identity, a workspace-scoped Postgres schema protected by Row Level Security,
and reliable upload of the intervals the desktop tracker records locally. The tracker, idle
detection and startup behaviour from Phase 1 are unchanged: everything still works offline, and
the local SQLite database stays the source of truth until the server confirms an upload.

## 1. Set up a project

1. Create a **new, dedicated** Supabase project for development (free tier is fine).
2. **Authentication › Sign In / Providers › Email**: keep *Email* enabled and **turn on
   *Confirm email* for any project real people use**. `accept_invitation` trusts the email in the
   user's JWT. Without confirmation, someone could register an address they don't own and
   accept an invitation sent to it. New accounts then click the emailed link before their first
   sign-in.
3. Copy `supabase/.env.example` to `supabase/.env.local` (gitignored) and fill in:

| Variable | Where | Used by |
| --- | --- | --- |
| `SUPABASE_URL` | Project Settings › API › Project URL | desktop build, scripts |
| `SUPABASE_PUBLISHABLE_KEY` | Project Settings › API › Publishable key (or legacy `anon`) | desktop build, scripts |
| `SUPABASE_SECRET_KEY` | Project Settings › API › Secret key (or legacy `service_role`) | **local admin scripts only** |
| `SUPABASE_DB_URL` | Project Settings › Database › Connection string › *Session pooler* | migration script only |

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

```bash
npm run supabase:migrate:status
```
```bash
npm run supabase:migrate
```

The runner applies each pending file in its own transaction. It records versions in
`supabase_migrations.schema_migrations`, the same table the Supabase CLI uses, so
`supabase db push` stays compatible. It prints file names only, never the connection string.

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

It deletes everything it created, even when a check fails. Each check prints PASS or FAIL, and
any failure gives a non-zero exit code.

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
  the caller's role first:

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

- **Same-workspace integrity is structural.** Composite foreign keys `(project_id, workspace_id)`
  and `(task_id, workspace_id)` make a cross-workspace reference impossible. Triggers forbid
  changing `workspace_id`, or a note's owner, after insert.
- **Notes.** `private` notes are visible to their owner only. `workspace` notes are visible to
  members. Only the owner edits. Updates bump `version`, so Phase 2B clients can detect conflicts
  instead of overwriting.
- **Time entries are private by default.** Only the member who recorded them can read them. An
  owner may set the workspace's visibility to `admins`, which lets owners and admins read
  members' entries. Entries are immutable: there is no update policy. Members can delete their
  own.
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

## 9. Behaviour worth knowing

These are asserted by `tests/integration/supabase`:

- **Removing a member revokes their pending invitations** in that workspace, and so does
  leaving. Re-invite after removing, not before.
- **Accepting an invitation while already a member keeps your current role.** Use
  `set_member_role` to promote someone.
- **A removed member keeps their own time entries** in that workspace and can still read or
  delete them, but cannot add new ones.
- **A removed assignee must be reassigned.** Once an assignee leaves the workspace, a task that
  still names them can't be edited until the assignee is changed or cleared.
- **`workspace_invitations` has column-level SELECT without `token_hash`.** List the columns
  explicitly; `select=*` is refused.
- **A retry can name a different workspace from the original upload.** That happens if the sync
  workspace is switched after a lost response. The entry stays where it was first uploaded and
  is reported `synced` (`already present`). Nothing is duplicated or moved.

## 10. Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Sync isn't configured in this build" | Build without `STUDIO_PULSE_SUPABASE_URL` / `…_PUBLISHABLE_KEY`, or the key was rejected (the message says why) |
| "Confirm your email address before signing in" | The project requires email confirmation |
| "This invitation was sent to a different email address" | Sign in with the invited email |
| Pending count doesn't fall, status "Can't reach Supabase" | Offline or project paused; retries continue automatically. "Sync now" retries immediately |
| Entries marked rejected | The server judged the entry invalid. It is kept locally; the reason is in Settings › Sync |
