# supabase/ — Phase 2

Versioned Postgres migrations, RLS policies, edge functions and seed data for the shared
workspace. Not implemented in Phase 1.

Planned tables (requirement §17): `profiles`, `workspaces`, `workspace_members`,
`workspace_invitations`, `projects`, `tasks`, `task_comments`, `notes`, `note_tags`,
`applications`, `device_registrations`, `tracking_events`, `manual_time_entries`,
`task_time_assignments`, `user_preferences`, `workspace_settings`.

Design commitments carried over from Phase 1 (docs/architecture.md §14):

- `tracking_events.id` is the client-generated UUIDv7: the server upserts by id and keeps the
  highest `revision`, so sync retries cannot duplicate intervals.
- Detailed tracking rows are readable only by their owner. Team reports read aggregated views
  governed by `workspace_settings.tracking_visibility`.
- Every workspace-owned row carries `workspace_id`. RLS checks membership through
  `workspace_members`. Client-supplied workspace ids are never trusted.
- No service-role key ever ships in client code.
