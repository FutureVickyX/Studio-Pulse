# @studio-pulse/database (Phase 2)

Not implemented in Phase 1. Phase 1 persists tracking data locally in SQLite, owned by the Rust
core (`apps/desktop/src-tauri/src/store`).

Phase 2 will add:

- the typed Supabase client (anon key only; **no service-role secrets in client code**)
- generated Postgres types from `supabase/migrations`
- query helpers shared by the desktop sync worker and `apps/web`

See `docs/architecture.md` §14 for the sync design (idempotent upserts by stable id + revision).
