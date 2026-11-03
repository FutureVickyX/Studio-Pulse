# Live tests (real Supabase project)

Not part of `npm test`: they need the network, a project with every migration applied, and three
confirmed throwaway users. They run the web workspace's data layer
(`apps/web/src/lib/api.ts`) exactly as the UI does, through the publishable key and each user's own
session, and delete what they create.

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
