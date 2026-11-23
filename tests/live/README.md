# Live tests (real Supabase project)

Not part of `npm test`: they need the network, a project with every migration applied, and three
confirmed throwaway users. They run the web workspace's data layer
(`apps/web/src/lib/api.ts`) exactly as the UI does, through the publishable key and each user's own
session. The workspace suite deletes its own workspace through the owner's session (owners may
delete a workspace; the delete cascades to all of its data). The automation suite keeps its
workspace for inspection and records its exact IDs; the provisioning operator deletes that
workspace and all the disposable users afterwards.

```bash
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_PUBLISHABLE_KEY=sb_publishable_… \
SP_LIVE_USERS_FILE=/path/to/users.json \
npx vitest run -c vitest.live.config.ts
```

`users.json` lists the users as `{"users":[{"label":"a","email":…,"password":…,"id":…}, …]}`:
`a` becomes the workspace owner, `b` a member, `c` stays outside. Keep the file outside the
repository and delete the users afterwards (Authentication › Users). Users can be created with
the secret key (`scripts/supabase/verify.mjs` does) or with SQL, as described in
[docs/supabase.md §3](../../docs/supabase.md#3-verify-against-the-real-project).

Without the three variables the suite is skipped.

`automation.live.test.ts` additionally requires the deployed Phase 3B worker and an active
verified scheduler. Four checks cover scheduled assignment/deadline/digest delivery, recipient
privacy/read state, digest equality with the authenticated Phase 3A RPC, and rejected privileged
operations. A fifth creates twelve tasks to test idempotent burst delivery. Its optional
concurrent-worker verification uses two trusted operator invocations; tests never receive the
worker or service-role credential. Polling is bounded, not an unlimited wait: 110 seconds for the
scheduled deliveries, and 150 seconds for the burst (test timeout 170 seconds). Without operator
invocations, its twelve jobs need two scheduled batches of ten, a minute apart.

The automation suite records exact workspace IDs in `automationWorkspace`/`automationWorkspaces`
in the supplied ignored fixture file for operator cleanup. Stop test sessions, delete those
workspaces (and other workspaces created by the disposable users), then delete the users and
credential file. Never run these checks against real user accounts or delete unrelated data.
