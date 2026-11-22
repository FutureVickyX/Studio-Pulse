# supabase/

Versioned Postgres migrations (`migrations/`), the automation scheduler's operator SQL
(`automation/`) and the Edge function configuration (`config.toml`) for the shared workspace.
The worker's source is `server/automation`; `npm run build:automation` writes the deployable,
gitignored `functions/automation-worker/index.ts`.

- Setup, migration order, RLS and sync: [docs/supabase.md](../docs/supabase.md)
- Analytics function: [docs/analytics.md](../docs/analytics.md)
- Notifications, scheduler deployment and verification: [docs/automation.md](../docs/automation.md)

Never edit an applied migration; add a new one. No service-role or secret key belongs in this
folder, the apps or any bundle.
