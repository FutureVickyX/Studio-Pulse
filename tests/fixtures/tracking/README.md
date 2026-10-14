# Tracking scenario fixtures

Each `*.json` file in this directory is one scenario for the Rust interval-accounting engine
(`apps/desktop/src-tauri/src/tracker/engine.rs`, design in `docs/architecture.md` §4).
`apps/desktop/src-tauri/tests/engine_fixtures.rs` (`tracking_fixtures`) loads every file in
lexical order, replays it through a fresh `Engine` with `SequentialIds` (ids `iv-1`, `iv-2`, …),
applies every `StepOutput` to a strict in-memory model of the `tracking_events` table, and then
compares the result with the file's `expect` block.

Run them with:

```sh
cd apps/desktop/src-tauri
cargo test --test engine_fixtures
```

Name files after the scenario in kebab-case (`system-sleep.json`, `alt-tab-flicker.json`). A new
file is picked up automatically. Unknown keys are rejected, so a typo fails loudly instead of
being ignored.

## Time model

All times in a fixture are **relative milliseconds**, and can be negative:

- A sample at relative time `t` has wall time `baseWallMs + t`.
- Its monotonic time is `t + monoOffset`. `monoOffset` starts at `0` and is **sticky**: once a
  sample step sets it, it applies to every later sample until another step changes it. Changing
  the offset between two samples is how a scenario models a clock that moves differently from the
  monotonic clock:

  | Situation | How to write it |
  | --- | --- |
  | Normal ticks | consecutive samples, no `monoOffset` change |
  | System sleep (wall jumps 10 min, monotonic +1 s) | next sample at `t + 600000`, `monoOffset` lowered by `599000` |
  | Hibernate or a hung tracker (both clocks jump) | next sample later, `monoOffset` unchanged |
  | Wall clock set back 10 min | next sample at `t − 599000`, `monoOffset` raised by `600000` |
  | Wall clock set forward 1 h | next sample at `t + 3601000`, `monoOffset` lowered by `3600000` |
  | Process restart (monotonic clock starts near 0) | `monoOffset` set so that `t + monoOffset` is small |

  The monotonic time must never be negative.
- Idle time is written as **`lastInputAt`**, the relative wall time of the user's last input. Each
  sample gets `idleMs = max(0, t − lastInputAt)`. When `lastInputAt` is omitted the user is
  giving input continuously (`idleMs = 0`). A raw `idleMs` value can be given instead, for
  probe-level scenarios. `lastInputAt` is not sticky: set it on every step it applies to.

## File structure

```jsonc
{
  "description": "What happens and what must be recorded.",   // required, non-empty
  "baseWallMs": 1760000000000,      // optional: wall time of relative 0 (default 1760000000000)
  "config": { "idleThresholdMs": 300000 },   // optional EngineConfig overrides (see below)
  "highWater": 0,                   // optional: initial high-water mark (relative ms)
  "checkpointEvery": 15,            // optional: checkpoint cadence in samples (default 15)
  "apps": { "figma": "Figma" },     // optional: application id -> display name
  "steps": [ /* sample steps and op steps, replayed in order */ ],
  "expect": { /* see below */ }
}
```

`config` and `setConfig` patches accept any subset of `idleDetection`, `idleThresholdMs`,
`minIntervalMs`, `maxGapMs` and `clockToleranceMs`. Omitted fields keep their current value. The
initial base is `EngineConfig::default()`: idle detection on, 5 min threshold, 2 s minimum
interval, 15 s maximum gap, 5 s clock tolerance.

`highWater` is the latest `ended_at_ms` recorded by a previous session, passed to `Engine::new`.
The harness checks that no interval starts before it.

`checkpointEvery` imitates the tracker service's periodic upsert of the open interval. After every
`n` processed (non-paused) samples, the harness writes the engine's open interval to the store
model. This exercises the "open row is later closed, or discarded" paths.

An application id missing from `apps` uses the id itself as the display name.

### Sample steps

A sample step produces one sample (`at`) or a range of samples (`from`, `to`, `every`):

| Key | Meaning |
| --- | --- |
| `at` | one sample at this relative time |
| `from`, `to` | samples at `from`, `from + every`, … while `< to` (`to` is exclusive) |
| `every` | sampling period in ms for a range (default `1000`, the service's poll) |
| `app` | application id in the foreground, or `null` / omitted for an untracked or disabled app |
| `lastInputAt` | relative wall time of the last input (see above) |
| `idleMs` | raw milliseconds since the last input; cannot be combined with `lastInputAt` |
| `session` | `active` (default), `locked`, `screenSaver`, `disconnected` or `unknown` |
| `monoOffset` | new sticky monotonic offset, applied from this step on |
| `activity` | optional assertion: the engine's `activity()` after the step's last sample |
| `note` | free text, echoed in failure messages |

A disabled application looks the same as an untracked one to the engine. The registry no longer
matches it, so the sample's `app` is `null`.

### Op steps

An op step calls one engine method. It cannot carry sample keys.

| `op` | Extra keys | Effect |
| --- | --- | --- |
| `pause` | `reason` (default `paused`; `disabled` models tracking turned off) | `engine.pause(reason)` |
| `resume` | | `engine.resume()` |
| `finish` | `reason` (default `shutdown`) | `engine.finish(reason)` |
| `setConfig` | `config` (required patch) | `engine.set_config(current + patch)` |
| `reset` | `deleteBefore` (optional relative ms) | history deletion, then `engine.reset(store high-water)` |
| `restart` | | graceful restart, see below |

`activity` and `note` work on op steps too.

- **`reset`** first deletes rows from the store model the way `Store::delete_events` does. Without
  `deleteBefore` it deletes every row. With `deleteBefore` it deletes closed rows that ended at or
  before that time. It then calls `engine.reset(...)` with the store's remaining high-water mark,
  checks that the dropped open interval's id is returned, and deletes that interval's row.
- **`restart`** calls `finish(shutdown)`, checks that no open row survived, and replaces the
  engine with a new one. The new engine's high-water mark is the store's latest `ended_at_ms`,
  and its ids carry a session prefix (`s2-iv-1`, `s2-iv-2`, …) so they never collide with the
  previous session's ids. Lower `monoOffset` in the next sample step to model the new process's
  monotonic clock.

### Expectations

```jsonc
"expect": {
  "closed": [                       // every closed row in the store, ordered by (start, end)
    { "id": "iv-1", "app": "figma", "kind": "active", "start": 0, "end": 600000, "reason": "untracked" }
  ],
  "open": null,                     // or the engine's open interval at the end (no "reason")
  "totals": { "foregroundMs": 600000, "activeMs": 600000, "idleMs": 0 },
  "activity": "untracked",          // optional: final engine activity
  "discarded": 0                    // optional: number of intervals discarded (below minimum)
}
```

- `closed` must list **all** closed rows, exactly. `start` and `end` are relative ms. `kind` is
  `active` or `idle`, and `reason` is an `EndReason` in camelCase (`appSwitch`, `becameIdle`,
  `inputResumed`, `untracked`, `sessionAway`, `paused`, `disabled`, `timeGap`, `clockChange`,
  `shutdown`, `settingsChanged`). `id` is optional. When given, it must match.
- `open` is the engine's live open interval (extended to the last sample), or `null`.
- `totals` sum the closed rows plus the open interval. `foregroundMs` must equal
  `activeMs + idleMs`.
- `activity` values: `starting`, `tracking`, `idle`, `untracked`, `away`, `paused`,
  `clockBehind`.

## Invariants checked on every engine call

Every scenario (and the randomized stream test in the same file) also checks these after every
single engine call, independently of `expect`:

- **Store rules.** A closed row is never modified: any upsert of it panics, even an identical
  one. A discard only removes a row that is still open. At most one open row exists, and it is a
  checkpoint of the engine's open interval, never ahead of it. An interval keeps its id, start and
  application for life.
- **Engine output.** Nothing shorter than `minIntervalMs` (and nothing empty) is persisted. An
  interval is closed or discarded at most once and never emitted again. A call finishes at most
  the one interval that was open before it. A persisted open interval is exactly the engine's open
  interval. `pause`, `finish` and reclassifying `setConfig` calls close at the last sample.
- **Accounting.** Intervals never overlap. `ended >= started`. `active + idle = duration` on
  every row. The open interval ends exactly at the last sample's wall time. The high-water mark
  covers everything recorded. No interval first seen after engine creation or reset starts before
  the high-water mark the engine was given.
- **No over-crediting.** Credited time (closed rows plus the open interval) never grows by more
  than the plausible wall delta since the previous sample (zero after a pause, gap or clock
  change). It never exceeds the sum of plausible inter-sample deltas. The check is computed by
  the harness, independently of the engine.
