//! Scenario and property tests for the interval-accounting engine (docs/architecture.md §4).
//!
//! - [`tracking_fixtures`] replays every `tests/fixtures/tracking/*.json` scenario (format:
//!   `tests/fixtures/tracking/README.md`) through [`Engine`] and checks the expected intervals,
//!   totals and final state.
//! - [`randomized_streams_keep_every_invariant`] feeds thousands of deterministic pseudo-random
//!   sample streams (gaps, clock jumps, idle, away, pauses, settings changes, resets, restarts).
//!
//! Both drive the engine through [`Harness`], which applies every [`StepOutput`] to a strict
//! in-memory model of the `tracking_events` table and checks the global invariants after every
//! single engine call.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use studio_pulse_lib::tracker::{
    EndReason, Engine, EngineActivity, EngineConfig, EpochMs, IdSource, Interval, IntervalKind,
    Sample, SequentialIds, SessionState, StepOutput, TrackedApp,
};

/// Wall time of relative time 0 when a fixture does not set `baseWallMs` (2025-10-09T08:53:20Z).
const DEFAULT_BASE_WALL_MS: EpochMs = 1_760_000_000_000;
/// Default checkpoint cadence, in processed samples (the service's default is 15 s at 1 Hz).
const DEFAULT_CHECKPOINT_EVERY: usize = 15;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/tracking")
}

// =============================================================================================
// Store model
// =============================================================================================

/// In-memory stand-in for the `tracking_events` table, enforcing the store's write rules
/// strictly: a closed row is never modified (any upsert of it panics, even an identical one),
/// a discard only ever targets a row that is still open, there is at most one open row, and an
/// interval keeps its id, start and application for life.
#[derive(Debug, Default)]
struct StoreModel {
    rows: HashMap<String, Interval>,
}

impl StoreModel {
    /// Apply one engine output the way the tracker service does: discards first, then upserts.
    fn apply(&mut self, out: &StepOutput, ctx: &str) {
        for id in &out.discard {
            self.discard(id, ctx);
        }
        for interval in &out.persist {
            self.upsert(interval, ctx);
        }
    }

    fn upsert(&mut self, interval: &Interval, ctx: &str) {
        if let Some(existing) = self.rows.get(&interval.id) {
            assert!(
                existing.open,
                "{ctx}: refused to modify closed interval {}:\n  stored: {existing:?}\n  write:  {interval:?}",
                interval.id
            );
            assert_eq!(
                (existing.started_at_ms, &existing.application_id),
                (interval.started_at_ms, &interval.application_id),
                "{ctx}: interval {} changed its start or application",
                interval.id
            );
        }
        if interval.open {
            if let Some(other) = self
                .rows
                .values()
                .find(|row| row.open && row.id != interval.id)
            {
                panic!(
                    "{ctx}: a second open interval {} while {} is still open",
                    interval.id, other.id
                );
            }
        }
        self.rows.insert(interval.id.clone(), interval.clone());
    }

    fn discard(&mut self, id: &str, ctx: &str) {
        match self.rows.get(id) {
            Some(row) if !row.open => panic!("{ctx}: discard of closed interval {row:?}"),
            Some(_) => {
                self.rows.remove(id);
            }
            None => {}
        }
    }

    /// `Store::delete_events`: `None` deletes every row, `Some(t)` deletes closed rows that
    /// ended at or before `t`.
    fn delete_history(&mut self, before: Option<EpochMs>) {
        match before {
            None => self.rows.clear(),
            Some(t) => self.rows.retain(|_, row| row.open || row.ended_at_ms > t),
        }
    }

    /// `Store::high_water_ms`: the latest end of any row.
    fn high_water(&self) -> Option<EpochMs> {
        self.rows.values().map(|row| row.ended_at_ms).max()
    }

    fn closed(&self) -> impl Iterator<Item = &Interval> {
        self.rows.values().filter(|row| !row.open)
    }

    fn open_rows(&self) -> Vec<&Interval> {
        self.rows.values().filter(|row| row.open).collect()
    }
}

// =============================================================================================
// Harness
// =============================================================================================

/// Ids for engines created by a simulated restart: `s2-iv-1`, `s2-iv-2`, … so they never
/// collide with the previous session's `iv-*` rows.
struct SessionIds {
    prefix: String,
    inner: SequentialIds,
}

impl IdSource for SessionIds {
    fn next_id(&mut self, at_ms: EpochMs) -> String {
        format!("{}{}", self.prefix, self.inner.next_id(at_ms))
    }
}

/// True when switching from `old` to `new` must close the open interval (§4.3 step 7).
fn reclassifies(old: &EngineConfig, new: &EngineConfig) -> bool {
    old.idle_detection != new.idle_detection || old.idle_threshold_ms != new.idle_threshold_ms
}

/// True when the time between two consecutive samples is plausible and may be credited
/// (§4.2 rule 3), computed independently of the engine.
fn continuous(prev: &Sample, next: &Sample, config: &EngineConfig) -> bool {
    let wall = i128::from(next.wall_ms) - i128::from(prev.wall_ms);
    let mono = i128::from(next.mono_ms) - i128::from(prev.mono_ms);
    let max_gap = i128::from(config.max_gap_ms);
    (0..=max_gap).contains(&wall)
        && mono <= max_gap
        && (wall - mono).abs() <= i128::from(config.clock_tolerance_ms)
}

/// Wall time that may be credited between two consecutive samples: the wall delta when the
/// gap is plausible, otherwise zero.
fn plausible_delta(prev: &Sample, next: &Sample, config: &EngineConfig) -> i64 {
    if continuous(prev, next, config) {
        next.wall_ms - prev.wall_ms
    } else {
        0
    }
}

/// State captured before an engine call, to judge its effects.
struct Before {
    credited: i64,
    min_interval_ms: u64,
    open: Option<Interval>,
}

/// Drives an [`Engine`] (and its restarts) against a [`StoreModel`] and checks the invariants
/// after every call. Keeps its own oracle of pause state, configuration and continuity so the
/// credited-time bound does not trust the engine's bookkeeping.
struct Harness {
    label: String,
    engine: Engine,
    store: StoreModel,
    config: EngineConfig,
    /// Engine sessions so far (restarts create a new engine).
    sessions: u32,
    /// The high-water mark the current engine was created or reset with. No interval first
    /// seen afterwards may start before it.
    floor: Option<EpochMs>,
    /// Ids already emitted closed or discarded: never to be emitted or opened again.
    finished: HashSet<String>,
    /// Every interval id seen so far (opened, persisted or discarded), in order of appearance.
    seen: HashSet<String>,
    discarded: usize,
    /// End reasons of every interval persisted closed.
    reasons: HashMap<EndReason, usize>,
    /// Every activity the engine reported after a call.
    activities: HashSet<EngineActivity>,
    checkpoint_every: usize,
    samples_since_checkpoint: usize,
    /// Oracle: paused between pause() and resume().
    paused: bool,
    /// Oracle: the previous sample the engine may treat as continuous with the next one.
    prev_sample: Option<Sample>,
    /// Σ of plausible inter-sample wall deltas so far: an upper bound on credited time.
    credit_bound: i64,
    calls: usize,
}

impl Harness {
    fn new(
        label: &str,
        config: EngineConfig,
        high_water: Option<EpochMs>,
        checkpoint_every: usize,
    ) -> Self {
        Self {
            label: label.to_owned(),
            engine: Engine::new(
                config.clone(),
                high_water,
                Box::new(SequentialIds::default()),
            ),
            store: StoreModel::default(),
            config,
            sessions: 1,
            floor: high_water,
            finished: HashSet::new(),
            seen: HashSet::new(),
            discarded: 0,
            reasons: HashMap::new(),
            activities: HashSet::new(),
            checkpoint_every: checkpoint_every.max(1),
            samples_since_checkpoint: 0,
            paused: false,
            prev_sample: None,
            credit_bound: 0,
            calls: 0,
        }
    }

    fn ctx(&self, what: &str) -> String {
        format!("{} (call #{} {what})", self.label, self.calls)
    }

    /// Time credited so far: stored closed rows plus the live open interval.
    fn credited(&self) -> i64 {
        let closed: i64 = self.store.closed().map(Interval::duration_ms).sum();
        closed + self.engine.open_interval().map_or(0, Interval::duration_ms)
    }

    fn before(&self) -> Before {
        Before {
            credited: self.credited(),
            min_interval_ms: self.config.min_interval_ms,
            open: self.engine.open_interval().cloned(),
        }
    }

    // --- engine calls ---------------------------------------------------------------------

    fn step(&mut self, sample: &Sample) -> StepOutput {
        self.calls += 1;
        let ctx = self.ctx(&format!(
            "step wall={} mono={}",
            sample.wall_ms, sample.mono_ms
        ));
        let before = self.before();
        let allowed = if self.paused {
            0
        } else {
            let allowed = self
                .prev_sample
                .as_ref()
                .map_or(0, |prev| plausible_delta(prev, sample, &self.config));
            self.prev_sample = Some(sample.clone());
            allowed
        };
        let out = self.engine.step(sample);
        if self.paused {
            assert!(out.is_empty(), "{ctx}: a paused engine emitted {out:?}");
            assert_eq!(self.engine.activity(), EngineActivity::Paused, "{ctx}");
        }
        self.after(&out, &before, allowed, false, &ctx);

        if !self.paused {
            self.samples_since_checkpoint += 1;
            if self.samples_since_checkpoint >= self.checkpoint_every {
                self.samples_since_checkpoint = 0;
                if let Some(open) = self.engine.open_interval().cloned() {
                    self.store.upsert(&open, &format!("{ctx} checkpoint"));
                    self.check_state(&ctx);
                }
            }
        }
        out
    }

    fn pause(&mut self, reason: EndReason) -> StepOutput {
        self.calls += 1;
        let ctx = self.ctx(&format!("pause({reason:?})"));
        let before = self.before();
        let out = self.engine.pause(reason);
        self.paused = true;
        assert!(self.engine.is_paused(), "{ctx}");
        assert_eq!(self.engine.activity(), EngineActivity::Paused, "{ctx}");
        assert!(self.engine.open_interval().is_none(), "{ctx}");
        self.after(&out, &before, 0, true, &ctx);
        out
    }

    fn resume(&mut self) {
        self.calls += 1;
        let ctx = self.ctx("resume");
        let before = self.before();
        self.engine.resume();
        if self.paused {
            self.paused = false;
            self.prev_sample = None;
            assert_eq!(self.engine.activity(), EngineActivity::Starting, "{ctx}");
        }
        assert!(!self.engine.is_paused(), "{ctx}");
        self.after(&StepOutput::default(), &before, 0, true, &ctx);
    }

    fn finish(&mut self, reason: EndReason) -> StepOutput {
        self.calls += 1;
        let ctx = self.ctx(&format!("finish({reason:?})"));
        let before = self.before();
        let out = self.engine.finish(reason);
        self.prev_sample = None;
        assert!(self.engine.open_interval().is_none(), "{ctx}");
        self.after(&out, &before, 0, true, &ctx);
        out
    }

    fn set_config(&mut self, config: EngineConfig) -> StepOutput {
        self.calls += 1;
        let ctx = self.ctx(&format!("set_config({config:?})"));
        let before = self.before();
        let closes = reclassifies(&self.config, &config);
        let out = self.engine.set_config(config.clone());
        if closes {
            self.prev_sample = None;
            assert!(self.engine.open_interval().is_none(), "{ctx}");
            assert!(self.engine.last_sample().is_none(), "{ctx}");
        } else {
            assert!(
                out.is_empty(),
                "{ctx}: a non-classifying change emitted {out:?}"
            );
        }
        assert_eq!(self.engine.config(), &config, "{ctx}");
        self.config = config;
        self.after(&out, &before, 0, true, &ctx);
        out
    }

    /// Local history deletion: delete rows like `Store::delete_events`, then reset the engine
    /// with the store's new high-water mark and delete the dropped open interval's row.
    fn delete_history(&mut self, before_ms: Option<EpochMs>) {
        self.calls += 1;
        let ctx = self.ctx(&format!("delete_history({before_ms:?})"));
        let before = self.before();
        self.store.delete_history(before_ms);
        let high_water = self.store.high_water();
        let expected_drop = self.engine.open_interval().map(|open| open.id.clone());
        let dropped = self.engine.reset(high_water);
        assert_eq!(
            dropped, expected_drop,
            "{ctx}: reset must return the open interval's id"
        );
        if let Some(id) = &dropped {
            self.store.discard(id, &ctx);
            self.finished.insert(id.clone());
        }
        assert_eq!(self.engine.high_water_ms(), high_water, "{ctx}");
        assert!(self.engine.open_interval().is_none(), "{ctx}");
        assert!(self.engine.last_sample().is_none(), "{ctx}");
        self.floor = high_water;
        self.prev_sample = None;
        self.after(&StepOutput::default(), &before, 0, true, &ctx);
    }

    /// Graceful shutdown followed by a new engine whose high-water mark comes from the store,
    /// as the service does on the next launch.
    fn restart(&mut self) {
        self.finish(EndReason::Shutdown);
        self.calls += 1;
        let ctx = self.ctx("restart");
        assert!(
            self.store.open_rows().is_empty(),
            "{ctx}: open rows survived a graceful finish"
        );
        let high_water = self.store.high_water();
        self.sessions += 1;
        let ids = SessionIds {
            prefix: format!("s{}-", self.sessions),
            inner: SequentialIds::default(),
        };
        self.engine = Engine::new(self.config.clone(), high_water, Box::new(ids));
        self.floor = high_water;
        self.paused = false;
        self.prev_sample = None;
        self.samples_since_checkpoint = 0;
        assert_eq!(self.engine.activity(), EngineActivity::Starting, "{ctx}");
        self.check_state(&ctx);
    }

    // --- checks ---------------------------------------------------------------------------

    /// Validate one call's output against the engine contract, apply it, and check the state.
    fn after(
        &mut self,
        out: &StepOutput,
        before: &Before,
        allowed: i64,
        closes_at_last_sample: bool,
        ctx: &str,
    ) {
        let minimum = i64::try_from(before.min_interval_ms)
            .expect("minimum fits i64")
            .max(1);
        let live = self.engine.open_interval().cloned();

        // A call finishes (closes or discards) at most one interval: the one open before it.
        let finished_now: Vec<&str> = out
            .discard
            .iter()
            .map(String::as_str)
            .chain(
                out.persist
                    .iter()
                    .filter(|i| !i.open)
                    .map(|i| i.id.as_str()),
            )
            .collect();
        assert!(
            finished_now.len() <= 1,
            "{ctx}: several intervals finished: {finished_now:?}"
        );
        if let Some(id) = finished_now.first() {
            assert_eq!(
                before.open.as_ref().map(|open| open.id.as_str()),
                Some(*id),
                "{ctx}: finished an interval that was not open"
            );
        }
        assert!(
            out.persist.iter().filter(|i| i.open).count() <= 1,
            "{ctx}: {out:?}"
        );

        for id in &out.discard {
            assert!(
                self.finished.insert(id.clone()),
                "{ctx}: {id} discarded after it finished"
            );
            self.discarded += 1;
        }
        for interval in &out.persist {
            assert!(
                interval.duration_ms() >= minimum,
                "{ctx}: persisted an interval shorter than the minimum ({minimum} ms): {interval:?}"
            );
            assert!(
                !self.finished.contains(&interval.id),
                "{ctx}: re-emitted {interval:?}"
            );
            if interval.open {
                assert!(interval.end_reason.is_none(), "{ctx}: {interval:?}");
                assert_eq!(
                    Some(interval),
                    live.as_ref(),
                    "{ctx}: a persisted open interval must be the engine's open interval"
                );
            } else {
                let reason = interval
                    .end_reason
                    .unwrap_or_else(|| panic!("{ctx}: closed without reason {interval:?}"));
                *self.reasons.entry(reason).or_default() += 1;
                self.finished.insert(interval.id.clone());
                let prev = before.open.as_ref().expect("checked above");
                assert_eq!(
                    prev.started_at_ms, interval.started_at_ms,
                    "{ctx}: start moved"
                );
                assert_eq!(
                    prev.application_id, interval.application_id,
                    "{ctx}: app changed"
                );
                assert_eq!(prev.application_name, interval.application_name, "{ctx}");
                if closes_at_last_sample {
                    assert_eq!(
                        prev.ended_at_ms, interval.ended_at_ms,
                        "{ctx}: must close at the last sample"
                    );
                }
            }
        }
        if let Some(prev) = &before.open {
            let closed_or_dropped = self.finished.contains(&prev.id);
            let still_open = live.as_ref().is_some_and(|live| live.id == prev.id);
            assert!(
                closed_or_dropped || still_open,
                "{ctx}: open interval {} vanished without being closed or discarded",
                prev.id
            );
            if let Some(live) = live.as_ref().filter(|live| live.id == prev.id) {
                assert_eq!(prev.started_at_ms, live.started_at_ms, "{ctx}: start moved");
                assert_eq!(
                    prev.application_id, live.application_id,
                    "{ctx}: app changed"
                );
                assert!(
                    live.ended_at_ms >= prev.ended_at_ms,
                    "{ctx}: open end moved back"
                );
            }
        }

        self.store.apply(out, ctx);
        self.check_state(ctx);

        let credited = self.credited();
        assert!(
            credited <= before.credited + allowed,
            "{ctx}: credited {} ms more than the plausible {allowed} ms",
            credited - before.credited
        );
        self.credit_bound += allowed;
        assert!(
            credited <= self.credit_bound,
            "{ctx}: credited {credited} ms exceeds the plausible total {} ms",
            self.credit_bound
        );
    }

    /// Global invariants over the store model and the engine's open interval.
    fn check_state(&mut self, ctx: &str) {
        self.activities.insert(self.engine.activity());
        let live = self.engine.open_interval();

        // At most one open interval, and a stored open row is a checkpoint of the live one.
        let open_rows = self.store.open_rows();
        assert!(
            open_rows.len() <= 1,
            "{ctx}: several open rows {open_rows:?}"
        );
        if let Some(row) = open_rows.first() {
            let live = live.unwrap_or_else(|| panic!("{ctx}: stored open row {row:?} is orphaned"));
            assert_eq!(
                row.id, live.id,
                "{ctx}: stored open row is not the engine's"
            );
            assert!(
                row.ended_at_ms <= live.ended_at_ms,
                "{ctx}: checkpoint ahead of live"
            );
        }

        if let Some(live) = live {
            assert!(
                live.open && live.end_reason.is_none(),
                "{ctx}: malformed open {live:?}"
            );
            assert!(
                !self.finished.contains(&live.id),
                "{ctx}: finished id reopened {live:?}"
            );
            let last = self
                .engine
                .last_sample()
                .unwrap_or_else(|| panic!("{ctx}: open interval without a last sample"));
            assert_eq!(
                live.ended_at_ms, last.wall_ms,
                "{ctx}: open interval not at last sample"
            );
        }

        for row in self.store.rows.values() {
            assert!(
                row.ended_at_ms >= row.started_at_ms,
                "{ctx}: negative interval {row:?}"
            );
            assert_eq!(
                row.active_ms() + row.idle_ms(),
                row.duration_ms(),
                "{ctx}: {row:?}"
            );
            assert_eq!(row.open, row.end_reason.is_none(), "{ctx}: {row:?}");
        }

        // No overlaps between closed rows and the live open interval.
        let mut all: Vec<&Interval> = self.store.closed().chain(live).collect();
        all.sort_by_key(|interval| (interval.started_at_ms, interval.ended_at_ms));
        for pair in all.windows(2) {
            assert!(
                pair[0].ended_at_ms <= pair[1].started_at_ms,
                "{ctx}: overlapping intervals\n  {:?}\n  {:?}",
                pair[0],
                pair[1]
            );
        }

        // The high-water mark covers everything recorded.
        if let Some(max_end) = all.iter().map(|interval| interval.ended_at_ms).max() {
            assert!(
                self.engine.high_water_ms() >= Some(max_end),
                "{ctx}: high-water {:?} below recorded end {max_end}",
                self.engine.high_water_ms()
            );
        }

        // Nothing new starts before the high-water mark the engine was given.
        for interval in &all {
            if self.seen.insert(interval.id.clone()) {
                if let Some(floor) = self.floor {
                    assert!(
                        interval.started_at_ms >= floor,
                        "{ctx}: {interval:?} starts before the high-water mark {floor}"
                    );
                }
            }
        }
    }
}

// =============================================================================================
// Fixture format
// =============================================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    description: String,
    base_wall_ms: Option<EpochMs>,
    #[serde(default)]
    config: ConfigPatch,
    high_water: Option<i64>,
    checkpoint_every: Option<usize>,
    #[serde(default)]
    apps: BTreeMap<String, String>,
    steps: Vec<Step>,
    expect: Expect,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigPatch {
    idle_detection: Option<bool>,
    idle_threshold_ms: Option<u64>,
    min_interval_ms: Option<u64>,
    max_gap_ms: Option<u64>,
    clock_tolerance_ms: Option<u64>,
}

impl ConfigPatch {
    fn apply(&self, base: &EngineConfig) -> EngineConfig {
        EngineConfig {
            idle_detection: self.idle_detection.unwrap_or(base.idle_detection),
            idle_threshold_ms: self.idle_threshold_ms.unwrap_or(base.idle_threshold_ms),
            min_interval_ms: self.min_interval_ms.unwrap_or(base.min_interval_ms),
            max_gap_ms: self.max_gap_ms.unwrap_or(base.max_gap_ms),
            clock_tolerance_ms: self.clock_tolerance_ms.unwrap_or(base.clock_tolerance_ms),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Op {
    Pause,
    Resume,
    Finish,
    SetConfig,
    Reset,
    Restart,
}

/// Either an operation (`op` set) or a range of samples (`at`, or `from`/`to`/`every`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Step {
    /// Free text for the reader, echoed in failure messages.
    note: Option<String>,
    op: Option<Op>,
    reason: Option<EndReason>,
    config: Option<ConfigPatch>,
    delete_before: Option<i64>,
    at: Option<i64>,
    from: Option<i64>,
    to: Option<i64>,
    every: Option<i64>,
    app: Option<String>,
    last_input_at: Option<i64>,
    idle_ms: Option<u64>,
    session: Option<SessionState>,
    mono_offset: Option<i64>,
    activity: Option<EngineActivity>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expect {
    closed: Vec<ExpectedInterval>,
    open: Option<ExpectedInterval>,
    totals: Totals,
    activity: Option<EngineActivity>,
    discarded: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedInterval {
    id: Option<String>,
    app: String,
    kind: IntervalKind,
    start: i64,
    end: i64,
    reason: Option<EndReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Totals {
    foreground_ms: i64,
    active_ms: i64,
    idle_ms: i64,
}

impl ExpectedInterval {
    /// The actual interval in fixture terms. The id is kept only when the expectation names one.
    fn from_actual(interval: &Interval, base: EpochMs, keep_id: bool) -> Self {
        Self {
            id: keep_id.then(|| interval.id.clone()),
            app: interval.application_id.clone(),
            kind: interval.kind,
            start: interval.started_at_ms - base,
            end: interval.ended_at_ms - base,
            reason: interval.end_reason,
        }
    }
}

fn totals_of<'a>(intervals: impl IntoIterator<Item = &'a Interval>) -> Totals {
    intervals.into_iter().fold(
        Totals {
            foreground_ms: 0,
            active_ms: 0,
            idle_ms: 0,
        },
        |acc, interval| Totals {
            foreground_ms: acc.foreground_ms + interval.duration_ms(),
            active_ms: acc.active_ms + interval.active_ms(),
            idle_ms: acc.idle_ms + interval.idle_ms(),
        },
    )
}

fn describe(intervals: &[ExpectedInterval]) -> String {
    let mut text = String::new();
    for interval in intervals {
        let _ = writeln!(text, "    {interval:?}");
    }
    if text.is_empty() {
        text.push_str("    (none)\n");
    }
    text
}

// =============================================================================================
// Fixture replay
// =============================================================================================

/// Build the samples of one sample step. `mono_offset` is sticky across steps.
fn samples_of(
    step: &Step,
    base: EpochMs,
    mono_offset: i64,
    apps: &BTreeMap<String, String>,
    ctx: &str,
) -> Vec<Sample> {
    let times: Vec<i64> = match (step.at, step.from, step.to) {
        (Some(at), None, None) => {
            assert!(step.every.is_none(), "{ctx}: `every` needs `from`/`to`");
            vec![at]
        }
        (None, Some(from), Some(to)) => {
            let every = step.every.unwrap_or(1_000);
            assert!(every > 0 && from < to, "{ctx}: empty or invalid range");
            (0..)
                .map(|k| from + k * every)
                .take_while(|t| *t < to)
                .collect()
        }
        _ => panic!("{ctx}: a sample step needs either `at` or both `from` and `to`"),
    };
    assert!(
        !(step.last_input_at.is_some() && step.idle_ms.is_some()),
        "{ctx}: use `lastInputAt` or `idleMs`, not both"
    );
    let app = step.app.as_ref().map(|id| TrackedApp {
        application_id: id.clone(),
        application_name: apps.get(id).cloned().unwrap_or_else(|| id.clone()),
    });
    times
        .into_iter()
        .map(|t| {
            let idle_ms = match (step.last_input_at, step.idle_ms) {
                (Some(input), _) => u64::try_from((t - input).max(0)).expect("non-negative"),
                (None, Some(idle)) => idle,
                (None, None) => 0,
            };
            let mono = u64::try_from(t + mono_offset)
                .unwrap_or_else(|_| panic!("{ctx}: monotonic time {t} + {mono_offset} < 0"));
            Sample {
                wall_ms: base + t,
                mono_ms: mono,
                app: app.clone(),
                idle_ms,
                session: step.session.unwrap_or(SessionState::Active),
            }
        })
        .collect()
}

fn run_fixture(path: &Path) {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{name}: {e}"));
    let fixture: Fixture =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: invalid fixture: {e}"));
    assert!(
        !fixture.description.trim().is_empty(),
        "{name}: missing description"
    );

    let base = fixture.base_wall_ms.unwrap_or(DEFAULT_BASE_WALL_MS);
    let config = fixture.config.apply(&EngineConfig::default());
    let mut harness = Harness::new(
        &name,
        config,
        fixture.high_water.map(|t| base + t),
        fixture.checkpoint_every.unwrap_or(DEFAULT_CHECKPOINT_EVERY),
    );
    let mut mono_offset = 0_i64;

    for (index, step) in fixture.steps.iter().enumerate() {
        let ctx = match &step.note {
            Some(note) => format!("{name} step #{index} ({note})"),
            None => format!("{name} step #{index}"),
        };
        if let Some(op) = step.op {
            assert!(
                step.at.is_none()
                    && step.from.is_none()
                    && step.to.is_none()
                    && step.every.is_none()
                    && step.app.is_none()
                    && step.last_input_at.is_none()
                    && step.idle_ms.is_none()
                    && step.session.is_none()
                    && step.mono_offset.is_none(),
                "{ctx}: an op step cannot carry sample fields"
            );
            assert!(
                step.reason.is_none() || matches!(op, Op::Pause | Op::Finish),
                "{ctx}: `reason` applies to pause and finish only"
            );
            assert!(
                step.config.is_some() == (op == Op::SetConfig),
                "{ctx}: `config` goes with setConfig"
            );
            assert!(
                step.delete_before.is_none() || op == Op::Reset,
                "{ctx}: `deleteBefore` goes with reset"
            );
            match op {
                Op::Pause => {
                    harness.pause(step.reason.unwrap_or(EndReason::Paused));
                }
                Op::Resume => harness.resume(),
                Op::Finish => {
                    harness.finish(step.reason.unwrap_or(EndReason::Shutdown));
                }
                Op::SetConfig => {
                    let patch = step.config.clone().unwrap_or_default();
                    let config = patch.apply(&harness.config);
                    harness.set_config(config);
                }
                Op::Reset => harness.delete_history(step.delete_before.map(|t| base + t)),
                Op::Restart => harness.restart(),
            }
        } else {
            assert!(
                step.reason.is_none() && step.config.is_none() && step.delete_before.is_none(),
                "{ctx}: op fields on a sample step"
            );
            if let Some(offset) = step.mono_offset {
                mono_offset = offset;
            }
            for sample in samples_of(step, base, mono_offset, &fixture.apps, &ctx) {
                harness.step(&sample);
            }
        }
        if let Some(activity) = step.activity {
            assert_eq!(harness.engine.activity(), activity, "{ctx}: activity");
        }
    }

    // Expected closed intervals, in start order.
    let mut closed: Vec<&Interval> = harness.store.closed().collect();
    closed.sort_by_key(|interval| (interval.started_at_ms, interval.ended_at_ms));
    let actual: Vec<ExpectedInterval> = closed
        .iter()
        .zip(
            fixture
                .expect
                .closed
                .iter()
                .map(Some)
                .chain(std::iter::repeat(None)),
        )
        .map(|(interval, expected)| {
            let keep_id = expected.is_some_and(|e| e.id.is_some());
            ExpectedInterval::from_actual(interval, base, keep_id)
        })
        .collect();
    assert!(
        actual == fixture.expect.closed,
        "{name}: closed intervals differ\n  expected:\n{}  actual:\n{}",
        describe(&fixture.expect.closed),
        describe(&actual)
    );

    // Expected open interval.
    let open = harness.engine.open_interval();
    let actual_open = open.map(|interval| {
        let keep_id = fixture.expect.open.as_ref().is_some_and(|e| e.id.is_some());
        ExpectedInterval::from_actual(interval, base, keep_id)
    });
    assert_eq!(
        actual_open, fixture.expect.open,
        "{name}: open interval differs"
    );

    // Totals over the closed rows and the live open interval.
    let totals = totals_of(closed.iter().copied().chain(open));
    assert_eq!(totals, fixture.expect.totals, "{name}: totals differ");
    assert_eq!(
        totals.foreground_ms,
        totals.active_ms + totals.idle_ms,
        "{name}: foreground must equal active + idle"
    );

    if let Some(activity) = fixture.expect.activity {
        assert_eq!(
            harness.engine.activity(),
            activity,
            "{name}: final activity"
        );
    }
    if let Some(discarded) = fixture.expect.discarded {
        assert_eq!(
            harness.discarded, discarded,
            "{name}: discarded interval count"
        );
    }
}

#[test]
fn tracking_fixtures() {
    let dir = fixtures_dir();
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    assert!(
        paths.len() >= 20,
        "expected the full scenario set in {}, found {} fixtures",
        dir.display(),
        paths.len()
    );

    let mut failures = Vec::new();
    for path in &paths {
        if let Err(panic) = panic::catch_unwind(AssertUnwindSafe(|| run_fixture(path))) {
            let message = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                .unwrap_or_else(|| "non-string panic".to_owned());
            failures.push(message);
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} fixtures failed:\n\n{}",
        failures.len(),
        paths.len(),
        failures.join("\n\n")
    );
}

#[test]
fn store_model_refuses_to_modify_a_closed_interval() {
    let mut store = StoreModel::default();
    let mut interval = Interval {
        id: "iv-1".to_owned(),
        application_id: "figma".to_owned(),
        application_name: "Figma".to_owned(),
        kind: IntervalKind::Active,
        started_at_ms: 0,
        ended_at_ms: 10,
        open: false,
        end_reason: Some(EndReason::AppSwitch),
    };
    store.upsert(&interval, "first write");
    interval.ended_at_ms = 20;
    let result = panic::catch_unwind(AssertUnwindSafe(|| store.upsert(&interval, "rewrite")));
    assert!(result.is_err(), "rewriting a closed interval must panic");
    let result = panic::catch_unwind(AssertUnwindSafe(|| store.discard("iv-1", "discard")));
    assert!(result.is_err(), "discarding a closed interval must panic");
}

// =============================================================================================
// Randomized invariants
// =============================================================================================

/// xorshift64: tiny, deterministic, good enough to explore engine inputs.
struct XorShift(u64);

impl XorShift {
    fn new(seed: u64) -> Self {
        // Never zero (a zero state stays zero); mix the seed so neighbouring seeds diverge.
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// Uniform-ish in `[lo, hi]`.
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        let span = u64::try_from(hi - lo + 1).expect("lo <= hi");
        lo + i64::try_from(self.next() % span).expect("span fits i64")
    }

    /// True with probability `per_mille / 1000`.
    fn chance(&mut self, per_mille: u64) -> bool {
        self.next() % 1_000 < per_mille
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        let index = usize::try_from(self.next() % items.len() as u64).expect("index fits");
        items[index]
    }
}

const RANDOM_BASE_WALL_MS: EpochMs = 1_760_000_000_000;

fn random_config(rng: &mut XorShift) -> EngineConfig {
    EngineConfig {
        idle_detection: rng.chance(850),
        idle_threshold_ms: rng.pick(&[2_000, 5_000, 30_000, 300_000]),
        min_interval_ms: rng.pick(&[0, 1_000, 2_000, 10_000]),
        max_gap_ms: rng.pick(&[3_000, 15_000, 60_000]),
        clock_tolerance_ms: rng.pick(&[500, 5_000]),
    }
}

/// The simulated machine: a monotonic clock, a wall clock offset from it, the user's last
/// input (on the monotonic clock, like `GetLastInputInfo`), the foreground app and the session.
struct World {
    mono: i64,
    wall_offset: i64,
    /// Monotonic time of the previous sample: new input happens after it.
    prev_sample_mono: i64,
    last_input_mono: i64,
    user_present: bool,
    app: Option<&'static str>,
    session: SessionState,
}

impl World {
    fn sample(&self, idle_override: Option<u64>) -> Sample {
        Sample {
            wall_ms: RANDOM_BASE_WALL_MS + self.mono + self.wall_offset,
            mono_ms: u64::try_from(self.mono).expect("mono is non-negative"),
            app: self.app.map(|id| TrackedApp {
                application_id: id.to_owned(),
                application_name: id.to_uppercase(),
            }),
            idle_ms: idle_override.unwrap_or_else(|| {
                u64::try_from(self.mono - self.last_input_mono).expect("input is in the past")
            }),
            session: self.session,
        }
    }
}

/// What the random streams exercised, so the test can prove its own coverage.
#[derive(Debug, Default)]
struct RandomStats {
    calls: usize,
    credit_bound: i64,
    consistent_streams: usize,
    reasons: HashMap<EndReason, usize>,
    activities: HashSet<EngineActivity>,
    /// Same-application transition rows checked against the §4.3 table, by name.
    rows: BTreeMap<&'static str, usize>,
}

/// The kind a tracked sample asks for (§4.3 step 4), or `None` for away and untracked samples.
fn desired_kind(sample: &Sample, config: &EngineConfig) -> Option<IntervalKind> {
    if sample.session.is_away() || sample.app.is_none() {
        None
    } else if config.idle_detection && sample.idle_ms >= config.idle_threshold_ms {
        Some(IntervalKind::Idle)
    } else {
        Some(IntervalKind::Active)
    }
}

/// Check one same-application row of the §4.3 transition table after a continuous step that
/// started with `before` open. Returns the row's name.
fn check_transition_row(
    label: &str,
    before: &Interval,
    sample: &Sample,
    kind: IntervalKind,
    out: &StepOutput,
    engine: &Engine,
) -> &'static str {
    let wall = sample.wall_ms;
    let input_at =
        i64::try_from((i128::from(wall) - i128::from(sample.idle_ms)).max(i128::from(i64::MIN)))
            .expect("clamped to i64");
    let ctx = format!("{label}: row {:?} -> {kind:?} at {wall}", before.kind);
    let open = engine.open_interval().unwrap_or_else(|| {
        panic!("{ctx}: a continuous tracked sample must leave an interval open")
    });
    let closed = out.persist.iter().find(|i| i.id == before.id && !i.open);
    let discarded = out.discard.contains(&before.id);
    // Where the previous interval must end when it is split off (None: it stays open).
    let (row, split_at) = match (before.kind, kind) {
        (from, to) if from == to => {
            assert_eq!(
                (&open.id, open.kind),
                (&before.id, kind),
                "{ctx}: must just extend"
            );
            ("extend", None)
        }
        (IntervalKind::Active, IntervalKind::Idle) => {
            let idle_start = input_at.min(wall);
            if idle_start <= before.started_at_ms {
                assert_eq!(
                    (&open.id, open.kind, open.started_at_ms),
                    (&before.id, IntervalKind::Idle, before.started_at_ms),
                    "{ctx}: must relabel the interval in place"
                );
                ("relabel", None)
            } else {
                ("becameIdle", Some((idle_start, EndReason::BecameIdle)))
            }
        }
        (IntervalKind::Idle, IntervalKind::Active) => {
            let resume = input_at.clamp(before.started_at_ms, wall);
            ("inputResumed", Some((resume, EndReason::InputResumed)))
        }
        _ => unreachable!("two kinds only"),
    };
    match split_at {
        None => {
            assert!(
                closed.is_none() && !discarded,
                "{ctx}: must not close {}",
                before.id
            );
        }
        Some((at, reason)) => {
            assert_ne!(open.id, before.id, "{ctx}: must open a new interval");
            assert_eq!(
                (open.kind, open.started_at_ms),
                (kind, at),
                "{ctx}: new interval"
            );
            match closed {
                Some(closed) => {
                    assert_eq!(
                        (closed.ended_at_ms, closed.end_reason),
                        (at, Some(reason)),
                        "{ctx}"
                    );
                }
                None => assert!(
                    discarded,
                    "{ctx}: {} neither closed nor discarded",
                    before.id
                ),
            }
        }
    }
    assert_eq!(
        open.ended_at_ms, wall,
        "{ctx}: the open interval ends at the sample"
    );
    row
}

/// One random stream. In `consistent` mode the wall clock never runs back relative to the
/// monotonic clock and idle times are always derived from real input, which additionally
/// allows checking that no active interval covers an instant at which the user was idle.
fn run_random_stream(seed: u64, steps: usize, stats: &mut RandomStats) {
    let mut rng = XorShift::new(seed);
    let consistent = rng.chance(500);
    let config = random_config(&mut rng);
    let initial_high_water = rng
        .chance(200)
        .then(|| RANDOM_BASE_WALL_MS + rng.range(-60_000, 60_000));
    let label = format!("random seed {seed} (consistent: {consistent})");
    let mut harness = Harness::new(
        &label,
        config,
        initial_high_water,
        rng.pick(&[1, 5, 15, 60]),
    );
    let mut world = World {
        mono: rng.range(0, 10_000),
        wall_offset: 0,
        prev_sample_mono: 0,
        last_input_mono: 0,
        user_present: true,
        app: Some("figma"),
        session: SessionState::Active,
    };
    world.last_input_mono = world.mono;
    let mut idle_instants: Vec<EpochMs> = Vec::new();

    for _ in 0..steps {
        // Occasional operations instead of a sample.
        if harness.paused && rng.chance(100) {
            harness.resume();
            continue;
        }
        if rng.chance(15) {
            harness.pause(rng.pick(&[EndReason::Paused, EndReason::Disabled]));
            continue;
        }
        if rng.chance(3) {
            harness.resume();
            continue;
        }
        if rng.chance(5) {
            harness.finish(EndReason::Shutdown);
            continue;
        }
        if rng.chance(10) {
            let mut config = harness.config.clone();
            if rng.chance(500) {
                config = random_config(&mut rng);
            } else {
                config.min_interval_ms = rng.pick(&[0, 1_000, 2_000, 10_000]);
                config.max_gap_ms = rng.pick(&[3_000, 15_000, 60_000]);
                config.clock_tolerance_ms = rng.pick(&[500, 5_000]);
            }
            harness.set_config(config);
            continue;
        }
        if rng.chance(3) {
            let wall = RANDOM_BASE_WALL_MS + world.mono + world.wall_offset;
            let before = rng.chance(500).then(|| wall - rng.range(0, 600_000));
            harness.delete_history(before);
            continue;
        }
        if rng.chance(3) {
            harness.restart();
            continue;
        }

        // Advance the clocks.
        let roll = rng.range(0, 999);
        match roll {
            0..=29 => {}                                         // duplicate sample: no time passed
            30..=59 => world.mono += rng.range(15_000, 120_000), // hang or hibernate
            60..=79 => {
                // Sleep: wall time passes, the monotonic clock barely moves.
                world.mono += 1_000;
                world.wall_offset += rng.range(60_000, 3_600_000);
            }
            80..=99 => {
                // Forward clock change.
                world.mono += 1_000;
                world.wall_offset += rng.range(1_000, 3_600_000);
            }
            100..=129 if !consistent => {
                // Backward clock change.
                world.mono += 1_000;
                world.wall_offset -= rng.range(1_000, 1_200_000);
            }
            130..=159 if !consistent => {
                // Small skew in either direction.
                world.mono += 1_000;
                world.wall_offset += rng.range(-10_000, 10_000);
            }
            _ => world.mono += rng.range(700, 1_300),
        }

        // Change what the user is doing.
        if rng.chance(80) {
            world.app = rng.pick(&[None, Some("figma"), Some("photoshop"), Some("blender")]);
        }
        if rng.chance(50) {
            world.user_present = !world.user_present;
        }
        if world.user_present && rng.chance(900) {
            // Input at some instant after the previous sample, up to now.
            let window = (world.mono - world.prev_sample_mono - 1).clamp(0, 999);
            let input = world.mono - rng.range(0, window);
            world.last_input_mono = world.last_input_mono.max(input);
        }
        world.prev_sample_mono = world.mono;
        if rng.chance(30) {
            world.session = rng.pick(&[
                SessionState::Active,
                SessionState::Active,
                SessionState::Active,
                SessionState::Locked,
                SessionState::ScreenSaver,
                SessionState::Disconnected,
                SessionState::Unknown,
            ]);
        }
        let idle_override = (!consistent && rng.chance(30))
            .then(|| rng.pick(&[0, 1_500, 4_000, 400_000, u64::MAX]));
        let sample = world.sample(idle_override);

        let desired = (!harness.paused)
            .then(|| desired_kind(&sample, &harness.config))
            .flatten();
        let before_open = harness.engine.open_interval().cloned();
        let continuous = !harness.paused
            && harness
                .prev_sample
                .as_ref()
                .is_some_and(|prev| continuous(prev, &sample, &harness.config));
        let out = harness.step(&sample);

        if desired == Some(IntervalKind::Idle) {
            let open_kind = harness.engine.open_interval().map(|open| open.kind);
            assert_ne!(
                open_kind,
                Some(IntervalKind::Active),
                "{label}: an idle sample left an active interval open"
            );
            idle_instants.push(sample.wall_ms);
        }
        if let (true, Some(before), Some(kind)) = (continuous, &before_open, desired) {
            let same_app = sample
                .app
                .as_ref()
                .is_some_and(|app| app.application_id == before.application_id);
            if same_app {
                let row =
                    check_transition_row(&label, before, &sample, kind, &out, &harness.engine);
                *stats.rows.entry(row).or_default() += 1;
            }
        }
    }
    harness.finish(EndReason::Shutdown);

    if consistent {
        // Idle time is never credited as active: no active interval strictly contains an
        // instant at which the user was idle.
        for interval in harness.store.closed() {
            if interval.kind != IntervalKind::Active {
                continue;
            }
            if let Some(instant) = idle_instants
                .iter()
                .find(|&&w| interval.started_at_ms < w && w < interval.ended_at_ms)
            {
                panic!("{label}: active interval {interval:?} covers idle instant {instant}");
            }
        }
        stats.consistent_streams += 1;
    }
    stats.calls += harness.calls;
    stats.credit_bound += harness.credit_bound;
    for (reason, count) in &harness.reasons {
        *stats.reasons.entry(*reason).or_default() += count;
    }
    stats.activities.extend(harness.activities.iter().copied());
}

#[test]
fn randomized_streams_keep_every_invariant() {
    let mut stats = RandomStats::default();
    for seed in 1..=2_000 {
        run_random_stream(seed, 250, &mut stats);
    }

    // The streams must actually exercise the engine, or passing proves little.
    assert!(stats.calls > 400_000, "only {} engine calls", stats.calls);
    assert!(
        stats.credit_bound > 0,
        "the random streams never credited any time"
    );
    assert!(
        (500..=1_500).contains(&stats.consistent_streams),
        "unbalanced modes: {} consistent streams",
        stats.consistent_streams
    );
    for reason in EndReason::ALL {
        if reason == EndReason::Recovered {
            continue; // Set by the store's crash recovery, never by the engine.
        }
        let count = stats.reasons.get(&reason).copied().unwrap_or(0);
        assert!(
            count >= 50,
            "end reason {reason:?} seen only {count} times: {stats:?}"
        );
    }
    for activity in [
        EngineActivity::Starting,
        EngineActivity::Tracking,
        EngineActivity::Idle,
        EngineActivity::Untracked,
        EngineActivity::Away,
        EngineActivity::Paused,
        EngineActivity::ClockBehind,
    ] {
        assert!(
            stats.activities.contains(&activity),
            "activity {activity:?} never seen"
        );
    }
    for row in ["extend", "relabel", "becameIdle", "inputResumed"] {
        let count = stats.rows.get(row).copied().unwrap_or(0);
        assert!(
            count >= 100,
            "transition row {row} checked only {count} times: {stats:?}"
        );
    }
}
