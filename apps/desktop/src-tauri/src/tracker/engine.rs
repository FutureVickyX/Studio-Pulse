//! The interval accounting engine. Pure and deterministic: no OS calls, no clock reads, no I/O.
//!
//! Algorithm and invariants: docs/architecture.md §4.2–§4.3. Scenario tests replay
//! `tests/fixtures/tracking/*.json` through this type (see `tests/engine_fixtures.rs`).
//!
//! # How a sample is processed
//!
//! 1. While paused, samples are ignored and not remembered.
//! 2. **Continuity** against the previous sample (§4.2 rule 3). A gap that is not plausible
//!    (wall clock backwards, more than `max_gap_ms` on either clock, or the two clocks disagreeing
//!    by more than `clock_tolerance_ms`) closes the open interval where it already ends, at the
//!    previous sample's wall time, and the sample is handled as a fresh start. The gap itself is
//!    never credited.
//! 3. **Sample-and-hold**: on a continuous tick the open interval is extended to the sample's wall
//!    time first, so the time since the previous tick belongs to the state observed at that tick.
//! 4. The sample's **desired state** (away, untracked, or a tracked app in the active or idle
//!    kind) drives one row of the transition table in §4.3.
//!
//! # Output contract
//!
//! Every call that can close or restructure an interval returns a [`StepOutput`]:
//!
//! - `persist` lists the intervals closed by the call, in the order they closed, followed by the
//!   open interval when the call changed it structurally (relabelled it, or opened it with a
//!   retroactive start) and it already lasts at least the minimum length. A brand-new interval
//!   opened at the sample's own wall time is empty and is left to the service's checkpoints.
//! - `discard` lists intervals that closed shorter than the minimum length. Empty intervals are
//!   always discarded, even with a minimum of zero.
//!
//! Callers should apply `discard` before `persist`: a discarded interval may still be stored as
//! `open` from an earlier checkpoint, and the store allows only one open row per device.
//!
//! An interval is emitted closed at most once, and is never emitted again afterwards. Interval
//! ids come from the injected [`IdSource`] when an interval opens and never change.

use super::types::{
    EndReason, EngineActivity, EngineConfig, EpochMs, IdSource, Interval, IntervalKind, Sample,
    StepOutput, TrackedApp,
};

/// Turns a stream of [`Sample`]s into non-overlapping [`Interval`]s.
pub struct Engine {
    config: EngineConfig,
    ids: Box<dyn IdSource>,
    /// The interval being recorded. Whenever it is `Some`, `last` is `Some` too and the
    /// interval ends exactly at `last.wall_ms`.
    open: Option<Interval>,
    /// The previous processed sample, used for the continuity check. `None` means the next
    /// sample is a fresh start.
    last: Option<Sample>,
    paused: bool,
    /// Latest instant attributed to any interval on this device. Never lowered except by
    /// [`Engine::reset`].
    high_water_ms: Option<EpochMs>,
    activity: EngineActivity,
}

/// What the current sample says should be recorded (§4.3 step 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Desired<'a> {
    /// Session locked, screen saver or disconnected.
    Away,
    /// No enabled registry application in the foreground.
    Untracked,
    /// A tracked application in the foreground, in the given kind.
    Tracked(&'a TrackedApp, IntervalKind),
}

/// Result of the continuity check between two consecutive samples (§4.2 rule 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Continuity {
    /// The time between the samples may be credited.
    Continuous,
    /// The time between the samples is never credited; the open interval closes with this
    /// reason at the previous sample.
    Broken(EndReason),
}

/// Classify the step from `prev` to `next`.
///
/// Discontinuous when the wall clock went backwards, either clock advanced by more than
/// `max_gap_ms`, or the two deltas disagree by more than `clock_tolerance_ms`. The reason is
/// `ClockChange` when the wall clock went backwards or disagrees with the monotonic clock within
/// a short wall step; any other discontinuity (sleep, hibernate, a hung tracker, a large forward
/// jump) is a `TimeGap`. A monotonic clock that runs backwards cannot happen on a real system;
/// it is treated as a clock change rather than trusted.
fn continuity(prev: &Sample, next: &Sample, config: &EngineConfig) -> Continuity {
    // i128 so that no combination of i64 wall times and u64 monotonic times can overflow.
    let wall_delta = i128::from(next.wall_ms) - i128::from(prev.wall_ms);
    let mono_delta = i128::from(next.mono_ms) - i128::from(prev.mono_ms);
    let max_gap = i128::from(config.max_gap_ms);
    let mismatch = (wall_delta - mono_delta).abs() > i128::from(config.clock_tolerance_ms);

    if wall_delta < 0 || mono_delta < 0 {
        return Continuity::Broken(EndReason::ClockChange);
    }
    let gap = wall_delta > max_gap || mono_delta > max_gap;
    if !gap && !mismatch {
        Continuity::Continuous
    } else if wall_delta <= max_gap && mismatch {
        Continuity::Broken(EndReason::ClockChange)
    } else {
        Continuity::Broken(EndReason::TimeGap)
    }
}

/// Milliseconds as a signed quantity, saturating instead of wrapping.
fn signed_ms(ms: u64) -> i64 {
    i64::try_from(ms).unwrap_or(i64::MAX)
}

impl Engine {
    /// `high_water_ms` is the latest `ended_at_ms` already recorded on this device (from the
    /// store). No new interval will start before it.
    pub fn new(
        config: EngineConfig,
        high_water_ms: Option<EpochMs>,
        ids: Box<dyn IdSource>,
    ) -> Self {
        Self {
            config,
            ids,
            open: None,
            last: None,
            paused: false,
            high_water_ms,
            activity: EngineActivity::Starting,
        }
    }

    /// The tuning currently in effect.
    pub fn config(&self) -> &EngineConfig {
        &self.config
    }

    /// Process one sample. See the transition table in docs/architecture.md §4.3.
    pub fn step(&mut self, sample: &Sample) -> StepOutput {
        let mut out = StepOutput::default();
        if self.paused {
            // Remember nothing, credit nothing: resume() starts afresh anyway.
            self.activity = EngineActivity::Paused;
            return out;
        }

        let continuity = self.last.as_ref().map(|prev| {
            (
                prev.wall_ms,
                prev.mono_ms,
                continuity(prev, sample, &self.config),
            )
        });
        match continuity {
            Some((_, _, Continuity::Continuous)) => self.extend_open(sample.wall_ms),
            Some((prev_wall, prev_mono, Continuity::Broken(reason))) => {
                log::debug!(
                    "tracker: sample discontinuity ({}): wall delta {} ms, mono delta {} ms; \
                     the gap is not credited",
                    reason.as_str(),
                    i128::from(sample.wall_ms) - i128::from(prev_wall),
                    i128::from(sample.mono_ms) - i128::from(prev_mono),
                );
                // The open interval already ends at the previous sample's wall time.
                self.close_open(reason, &mut out);
            }
            // Fresh start. An open interval cannot exist without a previous sample; closing is
            // a no-op kept so that the invariant cannot be broken silently.
            None => self.close_open(EndReason::TimeGap, &mut out),
        }
        self.last = Some(sample.clone());

        let desired = self.desired(sample);
        let structural = self.transition(sample, desired, &mut out);
        if structural {
            if let Some(open) = &self.open {
                if self.meets_minimum(open) {
                    out.persist.push(open.clone());
                }
            }
        }

        let previous_activity = self.activity;
        self.activity = self.activity_after(sample, desired);
        if self.activity == EngineActivity::ClockBehind
            && previous_activity != EngineActivity::ClockBehind
        {
            log::warn!(
                "tracker: wall clock is {} ms behind the high-water mark; recording holds until \
                 it catches up",
                self.high_water_ms
                    .map_or(0, |hw| i128::from(hw) - i128::from(sample.wall_ms)),
            );
        }
        out
    }

    /// Close the open interval at the last sample's wall time (`reason` is usually `Paused` or
    /// `Disabled`) and ignore samples until [`Engine::resume`].
    pub fn pause(&mut self, reason: EndReason) -> StepOutput {
        let mut out = StepOutput::default();
        self.close_open(reason, &mut out);
        self.paused = true;
        self.activity = EngineActivity::Paused;
        out
    }

    /// Leave the paused state. The next sample is treated as a fresh start: the paused span is
    /// never credited. Does nothing when the engine is not paused.
    pub fn resume(&mut self) {
        if !self.paused {
            return;
        }
        self.paused = false;
        self.last = None;
        self.activity = EngineActivity::Starting;
    }

    /// True between [`Engine::pause`] and [`Engine::resume`].
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Close the open interval at the last sample's wall time (graceful shutdown). A sample
    /// processed afterwards is treated as a fresh start.
    pub fn finish(&mut self, reason: EndReason) -> StepOutput {
        let mut out = StepOutput::default();
        self.close_open(reason, &mut out);
        self.forget_last_sample();
        out
    }

    /// Apply new tuning. If `idle_detection` or `idle_threshold_ms` changes, the open interval is
    /// closed with `SettingsChanged` at the last sample, and the next sample starts fresh.
    /// Other fields apply from the next sample on.
    pub fn set_config(&mut self, config: EngineConfig) -> StepOutput {
        let mut out = StepOutput::default();
        let reclassifies = config.idle_detection != self.config.idle_detection
            || config.idle_threshold_ms != self.config.idle_threshold_ms;
        if reclassifies {
            // Closed under the old tuning (including its minimum length): it was recorded
            // under it.
            self.close_open(EndReason::SettingsChanged, &mut out);
            self.forget_last_sample();
        }
        self.config = config;
        out
    }

    /// Forget the open interval and continuity state after local history was deleted. Returns
    /// the id of the dropped open interval, if any. `high_water_ms` is the new high-water mark.
    ///
    /// The dropped interval is not closed or emitted: the caller deletes its stored row, if any.
    pub fn reset(&mut self, high_water_ms: Option<EpochMs>) -> Option<String> {
        let dropped = self.open.take().map(|interval| interval.id);
        self.high_water_ms = high_water_ms;
        self.forget_last_sample();
        dropped
    }

    /// The interval currently being recorded, extended to the last sample.
    pub fn open_interval(&self) -> Option<&Interval> {
        self.open.as_ref()
    }

    /// What the engine believes is happening, as of the last call.
    pub fn activity(&self) -> EngineActivity {
        self.activity
    }

    /// Latest instant attributed to an interval on this device, including the open interval as
    /// it extends. No interval opens before it. It only moves forward, except through
    /// [`Engine::reset`].
    pub fn high_water_ms(&self) -> Option<EpochMs> {
        self.high_water_ms
    }

    /// The last processed sample, or `None` before the first sample after start, resume,
    /// finish, reset or a reclassifying settings change.
    pub fn last_sample(&self) -> Option<&Sample> {
        self.last.as_ref()
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    /// §4.3 step 4.
    fn desired<'a>(&self, sample: &'a Sample) -> Desired<'a> {
        if sample.session.is_away() {
            return Desired::Away;
        }
        let Some(app) = sample.app.as_ref() else {
            return Desired::Untracked;
        };
        let idle = self.config.idle_detection && sample.idle_ms >= self.config.idle_threshold_ms;
        let kind = if idle {
            IntervalKind::Idle
        } else {
            IntervalKind::Active
        };
        Desired::Tracked(app, kind)
    }

    /// §4.3 step 5. Returns true when the open interval changed structurally (a new interval
    /// opened, or the open one was relabelled).
    fn transition(&mut self, sample: &Sample, desired: Desired<'_>, out: &mut StepOutput) -> bool {
        let wall = sample.wall_ms;
        let (app, kind) = match desired {
            Desired::Away => {
                self.close_open(EndReason::SessionAway, out);
                return false;
            }
            Desired::Untracked => {
                self.close_open(EndReason::Untracked, out);
                return false;
            }
            Desired::Tracked(app, kind) => (app, kind),
        };

        let Some(mut open) = self.open.take() else {
            return self.open_fresh(app, kind, wall);
        };

        if open.application_id != app.application_id {
            self.close(open, EndReason::AppSwitch, out);
            return self.open_fresh(app, kind, wall);
        }

        let input_at = wall.saturating_sub(signed_ms(sample.idle_ms));
        match (open.kind, kind) {
            (IntervalKind::Active, IntervalKind::Active)
            | (IntervalKind::Idle, IntervalKind::Idle) => {
                self.open = Some(open);
                false
            }
            (IntervalKind::Active, IntervalKind::Idle) => {
                // The user has been idle since `input_at`. Idle time is never counted as active.
                let idle_start = input_at.min(open.ended_at_ms);
                if idle_start <= open.started_at_ms {
                    open.kind = IntervalKind::Idle;
                    self.open = Some(open);
                } else {
                    // Retroactive truncation: the active interval ends at the last input.
                    open.ended_at_ms = idle_start;
                    self.close(open, EndReason::BecameIdle, out);
                    self.open = Some(self.new_interval(app, IntervalKind::Idle, idle_start, wall));
                }
                true
            }
            (IntervalKind::Idle, IntervalKind::Active) => {
                // Active again from the input that ended the idle stretch, never earlier than
                // the idle interval itself.
                let resume = input_at.max(open.started_at_ms).min(open.ended_at_ms);
                open.ended_at_ms = resume;
                self.close(open, EndReason::InputResumed, out);
                self.open = Some(self.new_interval(app, IntervalKind::Active, resume, wall));
                true
            }
        }
    }

    /// Open a new interval at `wall` unless that would start before the high-water mark.
    /// Returns true when an interval was opened.
    fn open_fresh(&mut self, app: &TrackedApp, kind: IntervalKind, wall: EpochMs) -> bool {
        if self.is_behind(wall) {
            return false;
        }
        self.open = Some(self.new_interval(app, kind, wall, wall));
        self.raise_high_water(wall);
        true
    }

    fn new_interval(
        &mut self,
        app: &TrackedApp,
        kind: IntervalKind,
        started_at_ms: EpochMs,
        ended_at_ms: EpochMs,
    ) -> Interval {
        Interval {
            id: self.ids.next_id(started_at_ms),
            application_id: app.application_id.clone(),
            application_name: app.application_name.clone(),
            kind,
            started_at_ms,
            ended_at_ms,
            open: true,
            end_reason: None,
        }
    }

    /// Sample-and-hold: credit the time since the previous sample to the open interval.
    fn extend_open(&mut self, wall: EpochMs) {
        let Some(open) = self.open.as_mut() else {
            return;
        };
        open.ended_at_ms = open.ended_at_ms.max(wall);
        let ended = open.ended_at_ms;
        self.raise_high_water(ended);
    }

    /// Close the open interval, if any, where it currently ends.
    fn close_open(&mut self, reason: EndReason, out: &mut StepOutput) {
        if let Some(open) = self.open.take() {
            self.close(open, reason, out);
        }
    }

    /// Mark `interval` closed and route it to `persist` or `discard`.
    fn close(&mut self, mut interval: Interval, reason: EndReason, out: &mut StepOutput) {
        interval.open = false;
        interval.end_reason = Some(reason);
        self.raise_high_water(interval.ended_at_ms);
        if self.meets_minimum(&interval) {
            out.persist.push(interval);
        } else {
            out.discard.push(interval.id);
        }
    }

    /// True when `interval` is long enough to be stored: at least `min_interval_ms`, and never
    /// empty (so never negative either). Computed in i128 so extreme timestamps cannot overflow.
    fn meets_minimum(&self, interval: &Interval) -> bool {
        let minimum = i128::from(self.config.min_interval_ms).max(1);
        i128::from(interval.ended_at_ms) - i128::from(interval.started_at_ms) >= minimum
    }

    fn is_behind(&self, wall: EpochMs) -> bool {
        self.high_water_ms.is_some_and(|hw| wall < hw)
    }

    fn raise_high_water(&mut self, at: EpochMs) {
        self.high_water_ms = Some(self.high_water_ms.map_or(at, |hw| hw.max(at)));
    }

    fn forget_last_sample(&mut self) {
        self.last = None;
        self.activity = if self.paused {
            EngineActivity::Paused
        } else {
            EngineActivity::Starting
        };
    }

    /// Activity after processing `sample` with the given desired state.
    fn activity_after(&self, sample: &Sample, desired: Desired<'_>) -> EngineActivity {
        if let Some(open) = &self.open {
            return match open.kind {
                IntervalKind::Active => EngineActivity::Tracking,
                IntervalKind::Idle => EngineActivity::Idle,
            };
        }
        if self.is_behind(sample.wall_ms) {
            return EngineActivity::ClockBehind;
        }
        match desired {
            Desired::Away => EngineActivity::Away,
            Desired::Untracked => EngineActivity::Untracked,
            // A tracked app without an open interval only happens while the clock is behind.
            Desired::Tracked(..) => EngineActivity::ClockBehind,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::types::{SequentialIds, SessionState};
    use EndReason as R;
    use IntervalKind::{Active, Idle};

    const T0: EpochMs = 1_760_000_000_000;
    const SEC: i64 = 1_000;
    const MIN: i64 = 60 * SEC;
    const THRESHOLD: i64 = 5 * MIN;

    type Summary<'a> = (&'a str, i64, i64, IntervalKind, Option<EndReason>);

    fn app(id: &str) -> TrackedApp {
        TrackedApp {
            application_id: id.to_owned(),
            application_name: format!("App {id}"),
        }
    }

    fn ms(value: i64) -> u64 {
        u64::try_from(value).expect("test durations are non-negative")
    }

    /// A sample `t` ms after `T0` with the monotonic clock in step with the wall clock, `figma`
    /// in the foreground, input right now and an active session.
    fn s(t: i64) -> Sample {
        Sample {
            wall_ms: T0 + t,
            mono_ms: ms(t),
            app: Some(app("figma")),
            idle_ms: 0,
            session: SessionState::Active,
        }
    }

    /// Relative wall time of a sample built by [`s`].
    fn rel(sample: &Sample) -> i64 {
        sample.wall_ms - T0
    }

    trait SampleExt {
        fn on(self, id: &str) -> Self;
        fn untracked(self) -> Self;
        fn idle(self, ms: i64) -> Self;
        fn session(self, state: SessionState) -> Self;
        fn mono(self, ms: i64) -> Self;
    }

    impl SampleExt for Sample {
        fn on(mut self, id: &str) -> Self {
            self.app = Some(app(id));
            self
        }
        fn untracked(mut self) -> Self {
            self.app = None;
            self
        }
        fn idle(mut self, idle: i64) -> Self {
            self.idle_ms = ms(idle);
            self
        }
        fn session(mut self, state: SessionState) -> Self {
            self.session = state;
            self
        }
        fn mono(mut self, mono: i64) -> Self {
            self.mono_ms = ms(mono);
            self
        }
    }

    fn engine() -> Engine {
        engine_with(EngineConfig::default(), None)
    }

    fn engine_with(config: EngineConfig, high_water: Option<EpochMs>) -> Engine {
        Engine::new(config, high_water, Box::new(SequentialIds::default()))
    }

    /// Step one sample per second over `[from, to)`, shaping each with `shape`, and merge the
    /// outputs.
    fn feed(
        engine: &mut Engine,
        from: i64,
        to: i64,
        shape: impl Fn(Sample) -> Sample,
    ) -> StepOutput {
        let mut out = StepOutput::default();
        let mut t = from;
        while t < to {
            out.merge(engine.step(&shape(s(t))));
            t += SEC;
        }
        out
    }

    /// `(id, start, end, kind, reason)` with times relative to `T0`.
    fn summary(interval: &Interval) -> Summary<'_> {
        (
            interval.id.as_str(),
            interval.started_at_ms - T0,
            interval.ended_at_ms - T0,
            interval.kind,
            interval.end_reason,
        )
    }

    fn persisted(out: &StepOutput) -> Vec<Summary<'_>> {
        out.persist.iter().map(summary).collect()
    }

    fn open_of(engine: &Engine) -> Option<Summary<'_>> {
        engine.open_interval().map(summary)
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    // --- continuity -----------------------------------------------------------------------

    #[test]
    fn continuity_accepts_regular_ticks_and_boundary_values() {
        let config = EngineConfig::default();
        let prev = s(0);
        assert_eq!(continuity(&prev, &s(SEC), &config), Continuity::Continuous);
        assert_eq!(continuity(&prev, &s(0), &config), Continuity::Continuous);
        // Exactly the maximum gap on both clocks is still plausible.
        assert_eq!(
            continuity(&prev, &s(15 * SEC), &config),
            Continuity::Continuous
        );
        // Exactly the tolerance between the two clocks is still plausible.
        let skewed = s(6 * SEC).mono(SEC);
        assert_eq!(continuity(&prev, &skewed, &config), Continuity::Continuous);
    }

    #[test]
    fn continuity_flags_a_backward_wall_clock_as_clock_change() {
        let config = EngineConfig::default();
        let next = s(10 * MIN - 1).mono(10 * MIN + SEC);
        assert_eq!(
            continuity(&s(10 * MIN), &next, &config),
            Continuity::Broken(R::ClockChange)
        );
    }

    #[test]
    fn continuity_flags_long_gaps_as_time_gap() {
        let config = EngineConfig::default();
        let prev = s(MIN);
        let gap = Continuity::Broken(R::TimeGap);
        // Hibernate or a hung tracker: both clocks jump.
        assert_eq!(continuity(&prev, &s(MIN + 15 * SEC + 1), &config), gap);
        // Sleep: the wall clock jumps while the monotonic clock barely moves.
        assert_eq!(
            continuity(&prev, &s(11 * MIN).mono(MIN + SEC), &config),
            gap
        );
        // Only the monotonic clock exceeds the maximum gap, and the clocks still agree.
        assert_eq!(
            continuity(&prev, &s(MIN + 14 * SEC).mono(MIN + 16 * SEC), &config),
            gap
        );
        // A large forward clock change is indistinguishable from a gap.
        assert_eq!(
            continuity(&prev, &s(61 * MIN).mono(MIN + SEC), &config),
            gap
        );
    }

    #[test]
    fn continuity_flags_small_clock_disagreements_as_clock_change() {
        let config = EngineConfig::default();
        let prev = s(MIN);
        let change = Continuity::Broken(R::ClockChange);
        // An NTP step of 10 s forward within one tick.
        assert_eq!(
            continuity(&prev, &s(MIN + 11 * SEC).mono(MIN + SEC), &config),
            change
        );
        // The wall clock stalls while the monotonic clock advances, even beyond the maximum gap:
        // a short wall step that disagrees with the monotonic clock is a clock change.
        assert_eq!(
            continuity(&prev, &s(MIN + SEC).mono(MIN + 12 * SEC), &config),
            change
        );
        assert_eq!(
            continuity(&prev, &s(MIN + SEC).mono(MIN + 20 * SEC), &config),
            change
        );
    }

    #[test]
    fn continuity_distrusts_a_backward_monotonic_clock() {
        let config = EngineConfig::default();
        let next = s(MIN + SEC).mono(MIN - 1);
        assert_eq!(
            continuity(&s(MIN), &next, &config),
            Continuity::Broken(R::ClockChange)
        );
    }

    // --- opening and extending ------------------------------------------------------------

    #[test]
    fn a_new_engine_is_starting_and_empty() {
        let engine = engine();
        assert_eq!(engine.activity(), EngineActivity::Starting);
        assert!(engine.open_interval().is_none());
        assert!(engine.last_sample().is_none());
        assert!(!engine.is_paused());
        assert_eq!(engine.high_water_ms(), None);
        assert_eq!(engine.config(), &EngineConfig::default());
    }

    #[test]
    fn first_tracked_sample_opens_an_empty_active_interval_that_is_not_persisted() {
        let mut engine = engine();
        let out = engine.step(&s(0));
        assert!(
            out.is_empty(),
            "a zero-length interval is left to checkpoints"
        );
        assert_eq!(open_of(&engine), Some(("iv-1", 0, 0, Active, None)));
        let open = engine.open_interval().expect("open interval");
        assert!(open.open);
        assert_eq!(open.application_id, "figma");
        assert_eq!(open.application_name, "App figma");
        assert_eq!(engine.activity(), EngineActivity::Tracking);
        assert_eq!(engine.high_water_ms(), Some(T0));
        assert_eq!(engine.last_sample(), Some(&s(0)));
    }

    #[test]
    fn interval_ids_come_from_the_id_source_keyed_by_start() {
        use std::sync::{Arc, Mutex};

        struct Recording(Arc<Mutex<Vec<EpochMs>>>);
        impl IdSource for Recording {
            fn next_id(&mut self, at_ms: EpochMs) -> String {
                let mut seen = self.0.lock().expect("lock");
                seen.push(at_ms);
                format!("id-{}", seen.len())
            }
        }

        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut engine = Engine::new(
            EngineConfig::default(),
            None,
            Box::new(Recording(Arc::clone(&seen))),
        );
        feed(&mut engine, 0, 10 * SEC, |x| x);
        engine.step(&s(10 * SEC).on("blender"));
        assert_eq!(engine.open_interval().map(|i| i.id.as_str()), Some("id-2"));
        assert_eq!(*seen.lock().expect("lock"), vec![T0, T0 + 10 * SEC]);
    }

    #[test]
    fn same_app_and_kind_extends_the_open_interval_silently() {
        let mut engine = engine();
        assert!(feed(&mut engine, 0, 2 * MIN, |x| x).is_empty());
        assert_eq!(
            open_of(&engine),
            Some(("iv-1", 0, 2 * MIN - SEC, Active, None))
        );
        assert_eq!(engine.high_water_ms(), Some(T0 + 2 * MIN - SEC));
    }

    #[test]
    fn a_duplicate_sample_changes_nothing() {
        let mut engine = engine();
        feed(&mut engine, 0, 5 * SEC, |x| x);
        let before = engine.open_interval().cloned();
        assert!(engine.step(&s(4 * SEC)).is_empty());
        assert_eq!(engine.open_interval().cloned(), before);
    }

    // --- active -> idle -------------------------------------------------------------------

    #[test]
    fn active_to_idle_relabels_the_interval_when_idleness_began_before_it() {
        let mut engine = engine();
        // Focus stolen while away: no input since -2 min, the app came forward at 0.
        let out = feed(&mut engine, 0, 3 * MIN, |x| {
            let t = rel(&x);
            x.idle(t + 2 * MIN)
        });
        assert!(out.is_empty(), "still below the threshold");
        assert_eq!(engine.activity(), EngineActivity::Tracking);

        let out = engine.step(&s(3 * MIN).idle(THRESHOLD));
        assert!(out.discard.is_empty());
        assert_eq!(persisted(&out), vec![("iv-1", 0, 3 * MIN, Idle, None)]);
        assert!(out.persist[0].open, "the relabelled interval is still open");
        assert_eq!(open_of(&engine), Some(("iv-1", 0, 3 * MIN, Idle, None)));
        assert_eq!(engine.activity(), EngineActivity::Idle);
    }

    #[test]
    fn a_relabel_shorter_than_the_minimum_is_not_persisted_yet() {
        let mut engine = engine();
        engine.step(&s(0).idle(THRESHOLD - SEC));
        assert!(engine.step(&s(SEC).idle(THRESHOLD)).is_empty());
        assert_eq!(open_of(&engine), Some(("iv-1", 0, SEC, Idle, None)));
    }

    #[test]
    fn active_to_idle_truncates_the_active_interval_at_the_last_input() {
        let mut engine = engine();
        feed(&mut engine, 0, 10 * MIN, |x| x);
        // Last input at 10:00; samples keep coming without input.
        let out = feed(&mut engine, 10 * MIN, 15 * MIN, |x| {
            let t = rel(&x);
            x.idle(t - 10 * MIN)
        });
        assert!(out.is_empty());
        let out = engine.step(&s(15 * MIN).idle(THRESHOLD));
        assert!(out.discard.is_empty());
        assert_eq!(
            persisted(&out),
            vec![
                ("iv-1", 0, 10 * MIN, Active, Some(R::BecameIdle)),
                ("iv-2", 10 * MIN, 15 * MIN, Idle, None),
            ],
            "idle time is never counted as active"
        );
        assert!(!out.persist[0].open);
        assert!(out.persist[1].open);
        assert_eq!(
            open_of(&engine),
            Some(("iv-2", 10 * MIN, 15 * MIN, Idle, None))
        );
        assert_eq!(engine.activity(), EngineActivity::Idle);
        assert_eq!(engine.high_water_ms(), Some(T0 + 15 * MIN));
    }

    #[test]
    fn a_truncated_active_interval_shorter_than_the_minimum_is_discarded() {
        let mut engine = engine();
        engine.step(&s(0));
        // One more input at 0:01, then nothing.
        let out = feed(&mut engine, SEC, THRESHOLD + SEC, |x| {
            let t = rel(&x);
            x.idle(t - SEC)
        });
        assert!(out.is_empty());
        let out = engine.step(&s(THRESHOLD + SEC).idle(THRESHOLD));
        assert_eq!(out.discard, ids(&["iv-1"]));
        assert_eq!(
            persisted(&out),
            vec![("iv-2", SEC, THRESHOLD + SEC, Idle, None)]
        );
    }

    // --- idle -> active -------------------------------------------------------------------

    #[test]
    fn idle_to_active_closes_the_idle_interval_at_the_input() {
        let mut engine = engine();
        engine.step(&s(0).idle(10 * MIN));
        assert_eq!(engine.activity(), EngineActivity::Idle);
        feed(&mut engine, SEC, 2 * MIN, |x| {
            let t = rel(&x);
            x.idle(10 * MIN + t)
        });
        // Input 400 ms before the next sample.
        let out = engine.step(&s(2 * MIN).idle(400));
        assert!(out.discard.is_empty());
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, 2 * MIN - 400, Idle, Some(R::InputResumed))],
            "the new 400 ms active interval is below the minimum and not persisted yet"
        );
        assert_eq!(
            open_of(&engine),
            Some(("iv-2", 2 * MIN - 400, 2 * MIN, Active, None))
        );
        assert_eq!(engine.activity(), EngineActivity::Tracking);
    }

    #[test]
    fn input_resume_persists_the_new_active_interval_once_it_is_long_enough() {
        let mut engine = engine();
        engine.step(&s(0).idle(10 * MIN));
        engine.step(&s(10 * SEC).idle(10 * MIN + 10 * SEC));
        let out = engine.step(&s(15 * SEC).idle(3 * SEC));
        assert_eq!(
            persisted(&out),
            vec![
                ("iv-1", 0, 12 * SEC, Idle, Some(R::InputResumed)),
                ("iv-2", 12 * SEC, 15 * SEC, Active, None),
            ]
        );
    }

    #[test]
    fn input_resume_is_clamped_to_the_idle_interval_start() {
        let mut engine = engine();
        engine.step(&s(0).idle(10 * MIN));
        // An input "before" the idle interval began (inconsistent probe data).
        let out = engine.step(&s(SEC).idle(30 * SEC));
        assert_eq!(
            out.discard,
            ids(&["iv-1"]),
            "the idle interval became empty"
        );
        assert!(
            out.persist.is_empty(),
            "the 1 s active interval is below the minimum"
        );
        assert_eq!(open_of(&engine), Some(("iv-2", 0, SEC, Active, None)));
    }

    // --- switching, untracked, away -------------------------------------------------------

    #[test]
    fn app_switch_closes_at_the_sample_and_opens_the_new_app() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        let out = engine.step(&s(MIN).on("photoshop"));
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, MIN, Active, Some(R::AppSwitch))]
        );
        assert_eq!(open_of(&engine), Some(("iv-2", MIN, MIN, Active, None)));
        let open_app = engine.open_interval().map(|i| i.application_id.as_str());
        assert_eq!(open_app, Some("photoshop"));
        assert_eq!(engine.activity(), EngineActivity::Tracking);
    }

    #[test]
    fn app_switch_while_idle_opens_an_idle_interval() {
        let mut engine = engine();
        engine.step(&s(0).idle(THRESHOLD - SEC));
        let out = engine.step(&s(SEC).on("blender").idle(THRESHOLD));
        assert!(out.persist.is_empty());
        assert_eq!(out.discard, ids(&["iv-1"]), "the 1 s figma interval");
        assert_eq!(open_of(&engine), Some(("iv-2", SEC, SEC, Idle, None)));
        assert_eq!(engine.activity(), EngineActivity::Idle);
    }

    #[test]
    fn an_untracked_foreground_closes_the_interval() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        let out = engine.step(&s(MIN).untracked());
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, MIN, Active, Some(R::Untracked))]
        );
        assert!(engine.open_interval().is_none());
        assert_eq!(engine.activity(), EngineActivity::Untracked);
        // Staying untracked records nothing.
        assert!(feed(&mut engine, MIN + SEC, 2 * MIN, Sample::untracked).is_empty());
        assert_eq!(engine.activity(), EngineActivity::Untracked);
    }

    #[test]
    fn away_sessions_close_the_interval() {
        for state in [
            SessionState::Locked,
            SessionState::ScreenSaver,
            SessionState::Disconnected,
        ] {
            let mut engine = engine();
            feed(&mut engine, 0, MIN, |x| x);
            let out = engine.step(&s(MIN).session(state));
            assert_eq!(
                persisted(&out),
                vec![("iv-1", 0, MIN, Active, Some(R::SessionAway))]
            );
            assert_eq!(engine.activity(), EngineActivity::Away);
            assert!(feed(&mut engine, MIN + SEC, 2 * MIN, |x| x.session(state)).is_empty());
            assert!(engine.open_interval().is_none());
            // Coming back opens a new interval at the first active sample.
            engine.step(&s(2 * MIN));
            assert_eq!(
                open_of(&engine),
                Some(("iv-2", 2 * MIN, 2 * MIN, Active, None))
            );
        }
    }

    #[test]
    fn an_unknown_session_counts_as_active() {
        let mut engine = engine();
        let out = feed(&mut engine, 0, MIN, |x| x.session(SessionState::Unknown));
        assert!(out.is_empty());
        assert_eq!(open_of(&engine), Some(("iv-1", 0, MIN - SEC, Active, None)));
        assert_eq!(engine.activity(), EngineActivity::Tracking);
    }

    #[test]
    fn with_idle_detection_off_all_foreground_time_is_active() {
        let config = EngineConfig {
            idle_detection: false,
            ..EngineConfig::default()
        };
        let mut engine = engine_with(config, None);
        let out = feed(&mut engine, 0, 30 * MIN, |x| {
            let t = rel(&x);
            x.idle(t + 10 * MIN)
        });
        assert!(out.is_empty());
        assert_eq!(
            open_of(&engine),
            Some(("iv-1", 0, 30 * MIN - SEC, Active, None))
        );
        assert_eq!(engine.activity(), EngineActivity::Tracking);
    }

    // --- discontinuities and the high-water mark ------------------------------------------

    #[test]
    fn a_time_gap_closes_at_the_previous_sample_and_restarts() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        // Hibernate: both clocks jump 20 minutes.
        let out = engine.step(&s(21 * MIN));
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, MIN - SEC, Active, Some(R::TimeGap))],
            "the gap is never credited"
        );
        assert_eq!(
            open_of(&engine),
            Some(("iv-2", 21 * MIN, 21 * MIN, Active, None))
        );
    }

    #[test]
    fn sleep_is_not_credited() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        let out = engine.step(&s(11 * MIN).mono(MIN));
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, MIN - SEC, Active, Some(R::TimeGap))]
        );
        assert_eq!(
            open_of(&engine),
            Some(("iv-2", 11 * MIN, 11 * MIN, Active, None))
        );
    }

    #[test]
    fn a_small_clock_correction_is_a_clock_change() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        let out = engine.step(&s(MIN + 10 * SEC).mono(MIN));
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, MIN - SEC, Active, Some(R::ClockChange))]
        );
        let restart = MIN + 10 * SEC;
        assert_eq!(
            open_of(&engine),
            Some(("iv-2", restart, restart, Active, None))
        );
    }

    #[test]
    fn a_backward_clock_change_holds_until_the_high_water_mark() {
        let mut engine = engine();
        feed(&mut engine, 0, 20 * MIN, |x| x);
        // The wall clock goes back 10 minutes; the monotonic clock keeps going.
        let back = |x: Sample| {
            let t = rel(&x);
            x.mono(t + 10 * MIN)
        };
        let out = engine.step(&back(s(10 * MIN)));
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, 20 * MIN - SEC, Active, Some(R::ClockChange))]
        );
        assert!(engine.open_interval().is_none());
        assert_eq!(engine.activity(), EngineActivity::ClockBehind);
        assert!(feed(&mut engine, 10 * MIN + SEC, 20 * MIN - SEC, back).is_empty());
        assert!(engine.open_interval().is_none());
        assert_eq!(engine.activity(), EngineActivity::ClockBehind);
        assert_eq!(engine.high_water_ms(), Some(T0 + 20 * MIN - SEC));
        // The wall clock reaches the high-water mark: recording resumes exactly there.
        engine.step(&back(s(20 * MIN - SEC)));
        let resume = 20 * MIN - SEC;
        assert_eq!(
            open_of(&engine),
            Some(("iv-2", resume, resume, Active, None))
        );
        assert_eq!(engine.activity(), EngineActivity::Tracking);
    }

    #[test]
    fn clock_behind_takes_precedence_over_away_and_untracked() {
        let mut engine = engine_with(EngineConfig::default(), Some(T0 + MIN));
        engine.step(&s(0).untracked());
        assert_eq!(engine.activity(), EngineActivity::ClockBehind);
        engine.step(&s(SEC).session(SessionState::Locked));
        assert_eq!(engine.activity(), EngineActivity::ClockBehind);
        engine.step(&s(MIN).untracked());
        assert_eq!(engine.activity(), EngineActivity::Untracked);
    }

    #[test]
    fn a_restarted_engine_never_opens_before_the_stored_high_water_mark() {
        let mut engine = engine_with(EngineConfig::default(), Some(T0 + 3 * SEC));
        assert!(feed(&mut engine, 0, 3 * SEC, |x| x).is_empty());
        assert!(engine.open_interval().is_none());
        assert_eq!(engine.activity(), EngineActivity::ClockBehind);
        engine.step(&s(3 * SEC));
        assert_eq!(
            open_of(&engine),
            Some(("iv-1", 3 * SEC, 3 * SEC, Active, None))
        );
        assert_eq!(engine.high_water_ms(), Some(T0 + 3 * SEC));
    }

    #[test]
    fn the_high_water_mark_never_moves_back_while_tracking() {
        let mut engine = engine_with(EngineConfig::default(), Some(T0 - MIN));
        engine.step(&s(0));
        assert_eq!(engine.high_water_ms(), Some(T0));
        feed(&mut engine, SEC, 10 * MIN, |x| x);
        // Idle truncation moves the closed interval's end back, never the high-water mark.
        feed(&mut engine, 10 * MIN, 15 * MIN + SEC, |x| {
            let t = rel(&x);
            x.idle(t - 10 * MIN)
        });
        assert_eq!(engine.open_interval().map(|i| i.kind), Some(Idle));
        assert_eq!(engine.high_water_ms(), Some(T0 + 15 * MIN));
    }

    // --- minimum interval -----------------------------------------------------------------

    #[test]
    fn a_closed_interval_shorter_than_the_minimum_is_discarded() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        engine.step(&s(MIN).on("photoshop"));
        let out = engine.step(&s(MIN + SEC));
        assert_eq!(out.discard, ids(&["iv-2"]), "the 1 s alt-tab blip");
        assert!(out.persist.is_empty());
        assert_eq!(
            open_of(&engine),
            Some(("iv-3", MIN + SEC, MIN + SEC, Active, None))
        );
    }

    #[test]
    fn an_interval_of_exactly_the_minimum_is_kept() {
        let mut engine = engine();
        engine.step(&s(0));
        engine.step(&s(SEC));
        let out = engine.step(&s(2 * SEC).untracked());
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, 2 * SEC, Active, Some(R::Untracked))]
        );
    }

    #[test]
    fn empty_intervals_are_discarded_even_with_a_zero_minimum() {
        let config = EngineConfig {
            min_interval_ms: 0,
            ..EngineConfig::default()
        };
        let mut engine = engine_with(config, None);
        engine.step(&s(0));
        assert_eq!(engine.step(&s(0).untracked()).discard, ids(&["iv-1"]));
        engine.step(&s(SEC));
        let out = engine.step(&s(SEC + 1).untracked());
        assert_eq!(
            persisted(&out),
            vec![("iv-2", SEC, SEC + 1, Active, Some(R::Untracked))]
        );
    }

    // --- pause / resume / finish ----------------------------------------------------------

    #[test]
    fn pause_closes_at_the_last_sample_and_ignores_samples() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        let out = engine.pause(R::Paused);
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, MIN - SEC, Active, Some(R::Paused))]
        );
        assert!(engine.is_paused());
        assert_eq!(engine.activity(), EngineActivity::Paused);
        assert!(engine.open_interval().is_none());

        let last = engine.last_sample().cloned();
        assert!(feed(&mut engine, MIN, 5 * MIN, |x| x).is_empty());
        assert!(engine.open_interval().is_none());
        assert_eq!(engine.activity(), EngineActivity::Paused);
        assert_eq!(
            engine.last_sample().cloned(),
            last,
            "paused samples are not remembered"
        );
    }

    #[test]
    fn pause_for_disabled_tracking_uses_that_reason() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        let out = engine.pause(R::Disabled);
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, MIN - SEC, Active, Some(R::Disabled))]
        );
    }

    #[test]
    fn pause_without_an_open_interval_or_twice_emits_nothing() {
        let mut idle_engine = engine();
        assert!(idle_engine.pause(R::Paused).is_empty());
        assert!(idle_engine.pause(R::Paused).is_empty());
        assert!(idle_engine.is_paused());

        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        assert_eq!(engine.pause(R::Paused).persist.len(), 1);
        assert!(
            engine.pause(R::Disabled).is_empty(),
            "a closed interval is never re-emitted"
        );
    }

    #[test]
    fn pause_discards_an_interval_shorter_than_the_minimum() {
        let mut engine = engine();
        engine.step(&s(0));
        engine.step(&s(SEC));
        let out = engine.pause(R::Paused);
        assert_eq!(out.discard, ids(&["iv-1"]));
        assert!(out.persist.is_empty());
    }

    #[test]
    fn resume_starts_fresh_without_crediting_the_paused_span() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        engine.pause(R::Paused);
        feed(&mut engine, MIN, 5 * MIN, |x| x);
        engine.resume();
        assert!(!engine.is_paused());
        assert_eq!(engine.activity(), EngineActivity::Starting);
        assert!(engine.last_sample().is_none());
        // Even a sample continuous with the pre-pause one starts fresh.
        assert!(engine.step(&s(MIN)).is_empty());
        assert_eq!(open_of(&engine), Some(("iv-2", MIN, MIN, Active, None)));
    }

    #[test]
    fn resume_when_not_paused_changes_nothing() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        engine.resume();
        assert_eq!(engine.last_sample(), Some(&s(MIN - SEC)));
        assert_eq!(open_of(&engine), Some(("iv-1", 0, MIN - SEC, Active, None)));
        assert_eq!(engine.activity(), EngineActivity::Tracking);
    }

    #[test]
    fn finish_closes_at_the_last_sample() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        let out = engine.finish(R::Shutdown);
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, MIN - SEC, Active, Some(R::Shutdown))]
        );
        assert!(engine.open_interval().is_none());
        assert!(
            engine.finish(R::Shutdown).is_empty(),
            "nothing left to close"
        );
        assert_eq!(engine.high_water_ms(), Some(T0 + MIN - SEC));
    }

    #[test]
    fn finish_without_an_open_interval_emits_nothing() {
        let mut engine = engine();
        assert!(engine.finish(R::Shutdown).is_empty());
        engine.step(&s(0).untracked());
        assert!(engine.finish(R::Shutdown).is_empty());
    }

    // --- settings -------------------------------------------------------------------------

    #[test]
    fn changing_the_idle_threshold_closes_with_settings_changed_and_restarts() {
        let mut engine = engine();
        feed(&mut engine, 0, 3 * MIN, |x| {
            let t = rel(&x);
            x.idle(t)
        });
        let config = EngineConfig {
            idle_threshold_ms: 2 * 60_000,
            ..EngineConfig::default()
        };
        let out = engine.set_config(config.clone());
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, 3 * MIN - SEC, Active, Some(R::SettingsChanged))]
        );
        assert_eq!(engine.config(), &config);
        assert!(engine.last_sample().is_none());
        assert_eq!(engine.activity(), EngineActivity::Starting);
        // The next sample starts fresh under the new threshold: idle from now, not before.
        assert!(engine.step(&s(3 * MIN).idle(3 * MIN)).is_empty());
        assert_eq!(
            open_of(&engine),
            Some(("iv-2", 3 * MIN, 3 * MIN, Idle, None))
        );
    }

    #[test]
    fn toggling_idle_detection_closes_with_settings_changed() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        let out = engine.set_config(EngineConfig {
            idle_detection: false,
            ..EngineConfig::default()
        });
        assert_eq!(
            persisted(&out),
            vec![("iv-1", 0, MIN - SEC, Active, Some(R::SettingsChanged))]
        );
        assert!(!engine.config().idle_detection);
    }

    #[test]
    fn other_settings_apply_from_the_next_sample_without_closing() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        let config = EngineConfig {
            min_interval_ms: 10_000,
            max_gap_ms: 60_000,
            clock_tolerance_ms: 1_000,
            ..EngineConfig::default()
        };
        assert!(engine.set_config(config.clone()).is_empty());
        assert_eq!(engine.config(), &config);
        assert_eq!(engine.activity(), EngineActivity::Tracking);
        // A 30 s gap is now plausible and credited.
        assert!(engine.step(&s(MIN + 29 * SEC)).is_empty());
        assert_eq!(
            open_of(&engine),
            Some(("iv-1", 0, MIN + 29 * SEC, Active, None))
        );
    }

    #[test]
    fn set_config_while_paused_stays_paused() {
        let mut engine = engine();
        feed(&mut engine, 0, MIN, |x| x);
        engine.pause(R::Paused);
        let out = engine.set_config(EngineConfig {
            idle_threshold_ms: 60_000,
            ..EngineConfig::default()
        });
        assert!(out.is_empty());
        assert!(engine.is_paused());
        assert_eq!(engine.activity(), EngineActivity::Paused);
    }

    // --- reset ----------------------------------------------------------------------------

    #[test]
    fn reset_drops_the_open_interval_and_sets_the_high_water_mark() {
        let mut engine = engine();
        feed(&mut engine, 0, 10 * MIN, |x| x);
        assert_eq!(engine.reset(None), Some("iv-1".to_owned()));
        assert!(engine.open_interval().is_none());
        assert!(engine.last_sample().is_none());
        assert_eq!(engine.high_water_ms(), None);
        assert_eq!(engine.activity(), EngineActivity::Starting);
        // The dropped interval is not closed later.
        assert!(engine.finish(R::Shutdown).is_empty());
        engine.step(&s(10 * MIN));
        assert_eq!(
            open_of(&engine),
            Some(("iv-2", 10 * MIN, 10 * MIN, Active, None))
        );
    }

    #[test]
    fn reset_can_lower_the_high_water_mark() {
        let mut engine = engine_with(EngineConfig::default(), Some(T0 + 60 * MIN));
        engine.step(&s(0));
        assert_eq!(engine.activity(), EngineActivity::ClockBehind);
        assert_eq!(engine.reset(Some(T0 - MIN)), None);
        assert_eq!(engine.high_water_ms(), Some(T0 - MIN));
        engine.step(&s(SEC));
        assert_eq!(open_of(&engine), Some(("iv-1", SEC, SEC, Active, None)));
    }

    #[test]
    fn reset_while_paused_stays_paused() {
        let mut engine = engine();
        engine.pause(R::Paused);
        assert_eq!(engine.reset(None), None);
        assert!(engine.is_paused());
        assert_eq!(engine.activity(), EngineActivity::Paused);
    }

    // --- robustness -----------------------------------------------------------------------

    #[test]
    fn extreme_values_do_not_panic() {
        let mut engine = engine();
        let extreme = Sample {
            wall_ms: i64::MAX,
            mono_ms: u64::MAX,
            app: Some(app("figma")),
            idle_ms: u64::MAX,
            session: SessionState::Active,
        };
        engine.step(&extreme);
        engine.step(&Sample {
            wall_ms: i64::MIN,
            mono_ms: 0,
            idle_ms: 0,
            ..extreme.clone()
        });
        engine.step(&Sample {
            wall_ms: i64::MIN + 1,
            mono_ms: 1,
            idle_ms: u64::MAX,
            ..extreme.clone()
        });
        engine.step(&extreme);
        let _ = engine.finish(R::Shutdown);
        let _ = engine.pause(R::Paused);
    }
}
