# apps/web — Phase 2

The responsive web dashboard (team reports, tasks, notes, projects) arrives in Phase 2 on top of
Supabase. It is intentionally empty in Phase 1. Phase 1 is the Windows desktop tracker in
`apps/desktop`.

Planned stack: Next.js (App Router) in `app/`, shared components from `@studio-pulse/ui` in
`components/`, and reporting maths from `@studio-pulse/time-engine` via `lib/`. The web app will
use the same `TrackingEvent` contract (`@studio-pulse/shared-types`) and RLS-protected Supabase
queries (`@studio-pulse/database`).
