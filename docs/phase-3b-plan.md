# Phase 3B implementation checkpoint

Branch: `feat/phase-3b-automation`, isolated worktree `studio-pulse-automation`.
Base: `db068eb` (clean checkout), fast-forwarded to Phase 3A commit `7897fdd` once available on
15 November 2026. The primary checkout remains on Claude's
`feat/phase-3a-analytics` branch.

## Audit

- Tauri 2/Rust owns Windows tracking, startup, local SQLite and the tracking sync outbox.
- The shared React/Vite workspace uses the existing authenticated Supabase client and RLS.
- Tasks have date-only deadlines, versions, assignees and creators; projects have a lead. There
  is no reviewer field or mention parser. Review notifications will use the existing project lead.
- Desktop notifications currently describe local tracking state. They are not a server job system.
- No server scheduler, team notification center or automation queue exists.
- Phase 3A's completion report is `docs/handoff-phase-3a.md`. Digests reuse its `summarizeReport`
  and pure task reporting builders. The existing invoker reporting RPC is not changed or elevated.
  Migration 10 was applied to the hosted development project on 15 November 2026; its invoker
  security was verified in the catalog.
- The Supabase connector became available during implementation. The development database woke
  from hibernation after an application request. New automation migration requests require a
  separate Supabase confirmation. Public configuration exists in ignored env files; no
  privileged credential is needed in either frontend.

## Ordered slices

1. Add recipient-private notifications/preferences, administrator workspace switches, a private
   job outbox, task event triggers, and narrowly granted worker RPCs. Prove isolation and retries.
2. Add bounded scheduling for date-only due reminders, review and opt-in inactivity. Resolve local
   calendar boundaries in PostgreSQL; defer quiet-hour delivery; invalidate obsolete occurrences.
3. Add a trusted Supabase Edge worker with transactional job claims, leases, bounded retries,
   safe attempt logs and idempotent notification creation. Reuse the canonical time-engine for
   digest aggregation, then verify the actual Phase 3A integration once its code is available.
4. Add the web notification center and automation settings using the existing client, query cache,
   routing and design tokens. Do not advertise email/native delivery as implemented.
5. Add daily/weekly summaries and operational outcomes; test DST, privacy, stale jobs, retries,
   digest accounting and direct unauthorized requests.
6. Run regressions, builds and secret scans. Supply explicit deployment SQL/instructions for
   pg_cron + pg_net invoking the Edge worker. Do not claim production scheduling is active without
   observing a real scheduled execution.

## Reliability and boundaries

- Stable occurrence keys and a database unique constraint make retries idempotent.
- Claims use `FOR UPDATE SKIP LOCKED`, a lease and a claim token. A stale worker cannot acknowledge
  a newer claim. Interrupted work is reclaimed with bounded attempts.
- Before delivery, recheck membership, recipient, task state, schedule generation and preferences.
- Only trusted worker credentials may claim/finish/fail jobs. Authenticated users can read only
  their own current-workspace notifications and update read state. Admin outcomes omit payloads.
- In-app delivery only. Existing desktop tracking remains offline-first; web mutations remain
  online-only with explicit failures. Already loaded notifications stay in memory while offline.
- Secrets stay in the Edge environment/Vault. No privileged key enters a client or committed env.
