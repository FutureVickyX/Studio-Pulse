//! The interval accounting engine. Pure and deterministic: no OS calls, no clock reads, no I/O.
//!
//! Algorithm and invariants: docs/architecture.md §4.2–§4.3. Scenario tests replay
//! `tests/fixtures/tracking/*.json` through this type (see `tests/engine_fixtures.rs`).

use super::types::{
    EndReason, EngineActivity, EngineConfig, EpochMs, IdSource, Interval, Sample, StepOutput,
};

/// Turns a stream of [`Sample`]s into non-overlapping [`Interval`]s.
pub struct Engine {
    config: EngineConfig,
    ids: Box<dyn IdSource>,
    open: Option<Interval>,
    last: Option<Sample>,
    paused: bool,
    high_water_ms: Option<EpochMs>,
    activity: EngineActivity,
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

    pub fn config(&self) -> &EngineConfig {
        &self.config
    }

    /// Process one sample. See the transition table in docs/architecture.md §4.3.
    pub fn step(&mut self, _sample: &Sample) -> StepOutput {
        todo!("engine.step")
    }

    /// Close the open interval at the last sample's wall time (`reason` is usually `Paused` or
    /// `Disabled`) and ignore samples until [`Engine::resume`].
    pub fn pause(&mut self, _reason: EndReason) -> StepOutput {
        todo!("engine.pause")
    }

    /// Leave the paused state. The next sample is treated as a fresh start: the paused span is
    /// never credited.
    pub fn resume(&mut self) {
        todo!("engine.resume")
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Close the open interval at the last sample's wall time (graceful shutdown).
    pub fn finish(&mut self, _reason: EndReason) -> StepOutput {
        todo!("engine.finish")
    }

    /// Apply new tuning. If `idle_detection` or `idle_threshold_ms` changes, the open interval is
    /// closed with `SettingsChanged` at the last sample, and the next sample starts fresh.
    /// Other fields apply from the next sample on.
    pub fn set_config(&mut self, _config: EngineConfig) -> StepOutput {
        todo!("engine.set_config")
    }

    /// Forget the open interval and continuity state after local history was deleted. Returns
    /// the id of the dropped open interval, if any. `high_water_ms` is the new high-water mark.
    pub fn reset(&mut self, _high_water_ms: Option<EpochMs>) -> Option<String> {
        todo!("engine.reset")
    }

    /// The interval currently being recorded, extended to the last sample.
    pub fn open_interval(&self) -> Option<&Interval> {
        self.open.as_ref()
    }

    pub fn activity(&self) -> EngineActivity {
        self.activity
    }

    pub fn high_water_ms(&self) -> Option<EpochMs> {
        self.high_water_ms
    }

    pub fn last_sample(&self) -> Option<&Sample> {
        self.last.as_ref()
    }
}
