# apps/web — Studio Pulse team workspace (Phase 2B)

Projects, tasks (checklists, comments), personal and shared notes with autosave, and attribution
of synced desktop time to projects and tasks. A static React 19 + Vite app with hash routes and
no server of its own: it talks to Supabase with the publishable key and the signed-in user's
session, and Row Level Security decides every read and write.

```bash
cp apps/web/.env.example apps/web/.env.local   # then fill in the two public values
npm run dev:web                                # http://127.0.0.1:5180
npm run build:web                              # static site in apps/web/dist
```

Setup, deployment, the security model, offline behaviour, conflict handling and the manual test
walkthrough are in [docs/workspace.md](../../docs/workspace.md).

| Path | What |
| --- | --- |
| `src/app` | Session and workspace gates, sign-in, onboarding (create or join a workspace), the shell with navigation and realtime |
| `src/views` | Overview, Projects, Project, Tasks, Task panel, Notes and the note editor, Time |
| `src/components` | Forms and shared pieces on top of `@studio-pulse/ui` |
| `src/lib/api.ts` | Every Supabase query: idempotent creates, version-checked updates, time attribution |
| `src/lib/autosave.ts` | Note autosave: debounce, version-checked saves, retries, local drafts |
| `src/lib/model.ts`, `time.ts` | Pure rules: labels, filters, sorting, due dates, validation, time totals |
| `src/lib/store.ts`, `realtime.ts`, `router.ts` | Query cache, realtime refetch, hash routes |

Tests: `tests/unit/web` (pure logic, autosave, idempotent creates) and `tests/live` (the data layer
against a real project). `vite.config.ts` refuses to build with a secret or service-role key.
