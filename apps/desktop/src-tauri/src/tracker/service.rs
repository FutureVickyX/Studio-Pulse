//! The background tracker: samples the platform probe once per second, feeds the [`Engine`],
//! persists its output, checkpoints the open interval and publishes [`TrackerStatus`].
//!
//! Split for testability:
//! - [`TrackerCore`] holds all logic and is driven synchronously (`tick`, `handle`). Integration
//!   tests run it with a fake probe and a fake clock, with no threads and no Tauri.
//! - [`spawn`] runs a `TrackerCore` on a dedicated thread, using `recv_timeout` on the command
//!   channel as its tick.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::platform::SystemProbe;
use crate::registry::{AppCategory, Registry};
use crate::settings::Settings;
use crate::store::{iso_from_ms, Store, StoreError};

use super::engine::Engine;
use super::types::{
    EndReason, EngineActivity, EpochMs, Interval, IntervalKind, Sample, StepOutput, UuidV7Ids,
};

/// Serialized shape = `TrackerState` in shared-types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackerState {
    NotStarted,
    Tracking,
    Idle,
    Untracked,
    Away,
    Paused,
    Disabled,
    ClockBehind,
}

/// Serialized shape = `CurrentInterval` in shared-types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentInterval {
    pub event_id: String,
    pub application_id: String,
    pub application_name: String,
    pub category: AppCategory,
    pub kind: IntervalKind,
    /// ISO-8601 UTC.
    pub started_at: String,
}

/// Serialized shape = `TrackerStatus` in shared-types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerStatus {
    pub state: TrackerState,
    pub current: Option<CurrentInterval>,
    pub paused_until: Option<String>,
    pub last_sample_at: Option<String>,
    pub idle_threshold_seconds: u64,
}

impl TrackerStatus {
    /// True when the parts the UI renders differ (ignores the per-tick `last_sample_at`).
    fn differs_meaningfully(&self, other: &TrackerStatus) -> bool {
        self.state != other.state
            || self.current != other.current
            || self.paused_until != other.paused_until
            || self.idle_threshold_seconds != other.idle_threshold_seconds
    }
}

/// Time source. Production: [`SystemClock`]. Tests: a manual clock.
pub trait Clock: Send {
    /// UTC epoch ms from the system clock.
    fn wall_ms(&self) -> EpochMs;
    /// Monotonic ms since an arbitrary fixed origin.
    fn mono_ms(&self) -> u64;
}

/// `SystemTime` for wall time, `Instant` for monotonic time.
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn wall_ms(&self) -> EpochMs {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
            Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
        }
    }

    fn mono_ms(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// Messages from the command layer to the tracker thread. Every variant that the UI waits on
/// carries a `reply` channel so commands can return the post-change status.
pub enum TrackerCommand {
    /// Pause until `until_ms` (UTC epoch ms), or until resumed when `None`.
    Pause {
        until_ms: Option<EpochMs>,
        reply: Sender<()>,
    },
    Resume {
        reply: Sender<()>,
    },
    /// Settings changed: re-read them and reconfigure the engine. Handles enable/disable and
    /// onboarding completion.
    SettingsChanged {
        reply: Sender<()>,
    },
    /// Registry changed: matching changes take effect on the next sample; status is refreshed.
    RegistryChanged,
    /// Delete local history inside the tracker thread so a concurrent checkpoint can't re-insert
    /// a deleted row. `None` deletes everything and resets the engine.
    DeleteHistory {
        before_ms: Option<EpochMs>,
        reply: Sender<Result<u64, String>>,
    },
    /// Persist the open interval and any buffered writes now.
    Flush {
        reply: Sender<()>,
    },
    /// Close the open interval (`Shutdown`), persist, stop the thread.
    Shutdown {
        reply: Sender<()>,
    },
}

/// Callbacks into the app shell (emit Tauri events, update the tray, notify).
pub trait TrackerObserver: Send {
    fn status_changed(&self, status: &TrackerStatus);
    fn events_changed(&self);
    /// A pause-for-duration expired and tracking resumed by itself.
    fn auto_resumed(&self) {}
}

/// Everything the tracker needs, injected so tests can substitute fakes.
pub struct TrackerDeps {
    pub store: Arc<Store>,
    pub probe: Box<dyn SystemProbe>,
    pub clock: Box<dyn Clock>,
    pub registry: Arc<RwLock<Registry>>,
    pub settings: Arc<RwLock<Settings>>,
    pub device_id: String,
    pub observer: Box<dyn TrackerObserver>,
}

/// Shared snapshot read by commands without blocking the tracker thread.
#[derive(Debug, Clone)]
pub struct LiveState {
    pub status: TrackerStatus,
    /// The open interval as of the last tick, which may be newer than its last checkpoint.
    pub open: Option<Interval>,
}

/// Why the tracker is or isn't recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Onboarding not finished: nothing is recorded until the user consents.
    NotStarted,
    /// `tracking.enabled = false`.
    Disabled,
    Paused {
        until_ms: Option<EpochMs>,
    },
    Running,
}

/// Synchronous tracker logic. Owns the [`Engine`].
pub struct TrackerCore {
    deps: TrackerDeps,
    engine: Engine,
    live: Arc<RwLock<LiveState>>,
    mode: Mode,
    checkpoint_ms: u64,
    min_interval_ms: i64,
    /// Monotonic time of the last checkpoint of the open interval.
    last_checkpoint_mono: Option<u64>,
    /// Writes that failed (disk full, locked file); retried every tick. Upserts are idempotent.
    pending_writes: Vec<Interval>,
    pending_discards: Vec<String>,
    last_published: Option<TrackerStatus>,
}

fn read_settings(settings: &Arc<RwLock<Settings>>) -> Settings {
    match settings.read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn mode_for(settings: &Settings, at_startup: bool) -> Mode {
    if !settings.onboarding.completed {
        Mode::NotStarted
    } else if !settings.tracking.enabled {
        Mode::Disabled
    } else if at_startup && !settings.tracking.start_automatically {
        Mode::Paused { until_ms: None }
    } else {
        Mode::Running
    }
}

impl TrackerCore {
    /// Build the core. Applies startup policy: onboarding incomplete → `NotStarted`; tracking
    /// disabled → `Disabled`; `startAutomatically = false` → paused until resumed. Crash recovery
    /// (`Store::recover_open_intervals`) must already have run.
    pub fn new(deps: TrackerDeps) -> Result<Self, StoreError> {
        let settings = read_settings(&deps.settings);
        let high_water = deps.store.high_water_ms(&deps.device_id)?;
        let mut engine = Engine::new(settings.engine_config(), high_water, Box::new(UuidV7Ids));
        let mode = mode_for(&settings, true);
        if mode != Mode::Running {
            // Nothing is open yet, so this only puts the engine in its paused state.
            let _ = engine.pause(EndReason::Paused);
        }
        let placeholder = TrackerStatus {
            state: TrackerState::NotStarted,
            current: None,
            paused_until: None,
            last_sample_at: None,
            idle_threshold_seconds: u64::from(settings.tracking.idle_timeout_minutes) * 60,
        };
        let mut core = Self {
            deps,
            engine,
            live: Arc::new(RwLock::new(LiveState {
                status: placeholder,
                open: None,
            })),
            mode,
            checkpoint_ms: u64::from(settings.tracking.checkpoint_seconds) * 1_000,
            min_interval_ms: i64::from(settings.tracking.minimum_interval_seconds) * 1_000,
            last_checkpoint_mono: None,
            pending_writes: Vec::new(),
            pending_discards: Vec::new(),
            last_published: None,
        };
        core.publish(false);
        Ok(core)
    }

    /// Take one sample and process it: engine step, persist, checkpoint when due, auto-resume
    /// when a timed pause expires, publish status if it changed.
    pub fn tick(&mut self) {
        let wall = self.deps.clock.wall_ms();
        let mono = self.deps.clock.mono_ms();
        let mut wrote = self.flush_pending();

        if let Mode::Paused {
            until_ms: Some(until),
        } = self.mode
        {
            if wall >= until {
                self.engine.resume();
                self.mode = Mode::Running;
                log::info!("timed pause expired; tracking resumed");
                self.deps.observer.auto_resumed();
            }
        }

        if self.mode == Mode::Running {
            let sample = self.take_sample(wall, mono);
            let out = self.engine.step(&sample);
            wrote |= self.apply(out);
            wrote |= self.checkpoint_if_due(mono, false);
        }

        self.publish(wrote);
    }

    /// Handle one command. Returns false when the tracker should stop (after `Shutdown`).
    pub fn handle(&mut self, command: TrackerCommand) -> bool {
        match command {
            TrackerCommand::Pause { until_ms, reply } => {
                let mut wrote = false;
                match self.mode {
                    Mode::Running => {
                        let out = self.engine.pause(EndReason::Paused);
                        wrote = self.apply(out);
                        self.mode = Mode::Paused { until_ms };
                    }
                    Mode::Paused { .. } => self.mode = Mode::Paused { until_ms },
                    Mode::NotStarted | Mode::Disabled => {}
                }
                self.publish(wrote);
                let _ = reply.send(());
            }
            TrackerCommand::Resume { reply } => {
                if let Mode::Paused { .. } = self.mode {
                    self.engine.resume();
                    self.mode = Mode::Running;
                }
                self.publish(false);
                let _ = reply.send(());
            }
            TrackerCommand::SettingsChanged { reply } => {
                let wrote = self.reconfigure();
                self.publish(wrote);
                let _ = reply.send(());
            }
            TrackerCommand::RegistryChanged => self.publish(false),
            TrackerCommand::DeleteHistory { before_ms, reply } => {
                let result = self.delete_history(before_ms);
                self.publish(true);
                let _ = reply.send(result);
            }
            TrackerCommand::Flush { reply } => {
                let mono = self.deps.clock.mono_ms();
                let wrote = self.flush_pending() | self.checkpoint_if_due(mono, true);
                self.publish(wrote);
                let _ = reply.send(());
            }
            TrackerCommand::Shutdown { reply } => {
                let out = self.engine.finish(EndReason::Shutdown);
                let wrote = self.apply(out) | self.flush_pending();
                self.publish(wrote);
                if !self.pending_writes.is_empty() {
                    log::error!(
                        "{} interval write(s) could not be persisted at shutdown",
                        self.pending_writes.len()
                    );
                }
                let _ = reply.send(());
                return false;
            }
        }
        true
    }

    pub fn live(&self) -> Arc<RwLock<LiveState>> {
        Arc::clone(&self.live)
    }

    pub fn status(&self) -> TrackerStatus {
        match self.live.read() {
            Ok(live) => live.status.clone(),
            Err(poisoned) => poisoned.into_inner().status.clone(),
        }
    }

    fn take_sample(&mut self, wall: EpochMs, mono: u64) -> Sample {
        let session = self.deps.probe.session_state();
        let idle_ms = self.deps.probe.idle_ms().unwrap_or(0);
        let app = if session.is_away() {
            None
        } else {
            self.deps.probe.foreground_process().and_then(|process| {
                match self.deps.registry.read() {
                    Ok(registry) => registry.tracked_app(&process),
                    Err(poisoned) => poisoned.into_inner().tracked_app(&process),
                }
            })
        };
        Sample {
            wall_ms: wall,
            mono_ms: mono,
            app,
            idle_ms,
            session,
        }
    }

    /// Persist engine output. Returns true if anything was written.
    fn apply(&mut self, out: StepOutput) -> bool {
        if out.is_empty() {
            return false;
        }
        let structural_open = out.persist.iter().any(|i| i.open);
        self.pending_discards.extend(out.discard);
        self.pending_writes.extend(out.persist);
        if structural_open {
            // The engine just wrote the open interval; restart the checkpoint window.
            self.last_checkpoint_mono = Some(self.deps.clock.mono_ms());
        }
        self.flush_pending()
    }

    /// Retry buffered writes. Returns true if anything was written.
    fn flush_pending(&mut self) -> bool {
        let mut wrote = false;
        if !self.pending_discards.is_empty() {
            match self
                .deps
                .store
                .discard_open_intervals(&self.pending_discards)
            {
                Ok(_) => {
                    self.pending_discards.clear();
                    wrote = true;
                }
                Err(err) => log::warn!("could not discard short intervals yet: {err}"),
            }
        }
        if !self.pending_writes.is_empty() {
            match self
                .deps
                .store
                .upsert_intervals(&self.deps.device_id, &self.pending_writes)
            {
                Ok(()) => {
                    self.pending_writes.clear();
                    wrote = true;
                }
                Err(err) => log::warn!(
                    "could not persist {} interval write(s) yet; will retry: {err}",
                    self.pending_writes.len()
                ),
            }
        }
        wrote
    }

    /// Upsert the open interval if the aggregation window elapsed (or `force`) and it is at
    /// least the minimum length.
    fn checkpoint_if_due(&mut self, mono: u64, force: bool) -> bool {
        let Some(open) = self.engine.open_interval() else {
            return false;
        };
        if open.duration_ms() < self.min_interval_ms {
            return false;
        }
        let due = match self.last_checkpoint_mono {
            None => true,
            Some(last) => mono.saturating_sub(last) >= self.checkpoint_ms,
        };
        if !(due || force) {
            return false;
        }
        let snapshot = open.clone();
        self.last_checkpoint_mono = Some(mono);
        self.pending_writes.push(snapshot);
        self.flush_pending()
    }

    fn reconfigure(&mut self) -> bool {
        let settings = read_settings(&self.deps.settings);
        self.checkpoint_ms = u64::from(settings.tracking.checkpoint_seconds) * 1_000;
        self.min_interval_ms = i64::from(settings.tracking.minimum_interval_seconds) * 1_000;
        let mut wrote = self.apply_config(&settings);

        let wanted = mode_for(&settings, false);
        match (self.mode, wanted) {
            (Mode::Running, Mode::Disabled) | (Mode::Paused { .. }, Mode::Disabled) => {
                let out = self.engine.pause(EndReason::Disabled);
                wrote |= self.apply(out);
                self.mode = Mode::Disabled;
            }
            (Mode::Running, Mode::NotStarted) | (Mode::Paused { .. }, Mode::NotStarted) => {
                let out = self.engine.pause(EndReason::Disabled);
                wrote |= self.apply(out);
                self.mode = Mode::NotStarted;
            }
            (Mode::NotStarted, Mode::Running) | (Mode::Disabled, Mode::Running) => {
                self.engine.resume();
                self.mode = Mode::Running;
            }
            (Mode::NotStarted, Mode::Disabled) => self.mode = Mode::Disabled,
            (Mode::Disabled, Mode::NotStarted) => self.mode = Mode::NotStarted,
            // Running stays running; a user pause is kept until resumed or expired.
            _ => {}
        }
        wrote
    }

    fn apply_config(&mut self, settings: &Settings) -> bool {
        let config = settings.engine_config();
        if &config == self.engine.config() {
            return false;
        }
        let out = self.engine.set_config(config);
        self.apply(out)
    }

    fn delete_history(&mut self, before_ms: Option<EpochMs>) -> Result<u64, String> {
        // Make sure nothing buffered re-appears after the delete.
        self.pending_writes.clear();
        self.pending_discards.clear();
        let deleted = self
            .deps
            .store
            .delete_events(before_ms)
            .map_err(|err| err.to_string())?;
        if before_ms.is_none() {
            let high_water = self
                .deps
                .store
                .high_water_ms(&self.deps.device_id)
                .map_err(|err| err.to_string())?;
            self.engine.reset(high_water);
            self.last_checkpoint_mono = None;
        }
        Ok(deleted)
    }

    fn compute_status(&self) -> TrackerStatus {
        let settings = read_settings(&self.deps.settings);
        let state = match self.mode {
            Mode::NotStarted => TrackerState::NotStarted,
            Mode::Disabled => TrackerState::Disabled,
            Mode::Paused { .. } => TrackerState::Paused,
            Mode::Running => match self.engine.activity() {
                EngineActivity::Tracking => TrackerState::Tracking,
                EngineActivity::Idle => TrackerState::Idle,
                EngineActivity::Away => TrackerState::Away,
                EngineActivity::ClockBehind => TrackerState::ClockBehind,
                EngineActivity::Paused => TrackerState::Paused,
                // `Starting` lasts at most one poll; nothing is being recorded yet.
                EngineActivity::Starting | EngineActivity::Untracked => TrackerState::Untracked,
            },
        };
        let current = if self.mode == Mode::Running {
            self.engine.open_interval().map(|open| {
                let category = match self.deps.registry.read() {
                    Ok(registry) => registry.get(&open.application_id).map(|a| a.category),
                    Err(poisoned) => poisoned
                        .into_inner()
                        .get(&open.application_id)
                        .map(|a| a.category),
                }
                .unwrap_or(AppCategory::Other);
                CurrentInterval {
                    event_id: open.id.clone(),
                    application_id: open.application_id.clone(),
                    application_name: open.application_name.clone(),
                    category,
                    kind: open.kind,
                    started_at: iso_from_ms(open.started_at_ms),
                }
            })
        } else {
            None
        };
        let paused_until = match self.mode {
            Mode::Paused {
                until_ms: Some(until),
            } => Some(iso_from_ms(until)),
            _ => None,
        };
        TrackerStatus {
            state,
            current,
            paused_until,
            last_sample_at: self.engine.last_sample().map(|s| iso_from_ms(s.wall_ms)),
            idle_threshold_seconds: u64::from(settings.tracking.idle_timeout_minutes) * 60,
        }
    }

    /// Refresh the shared snapshot and notify the shell when something visible changed.
    fn publish(&mut self, events_written: bool) {
        let status = self.compute_status();
        let open = if self.mode == Mode::Running {
            self.engine.open_interval().cloned()
        } else {
            None
        };
        match self.live.write() {
            Ok(mut live) => {
                live.status = status.clone();
                live.open = open;
            }
            Err(poisoned) => {
                let mut live = poisoned.into_inner();
                live.status = status.clone();
                live.open = open;
            }
        }
        let changed = self
            .last_published
            .as_ref()
            .is_none_or(|previous| previous.differs_meaningfully(&status));
        if changed {
            self.deps.observer.status_changed(&status);
            self.last_published = Some(status);
        }
        if events_written {
            self.deps.observer.events_changed();
        }
    }
}

/// Handle used by commands, the tray and the app shell.
#[derive(Clone)]
pub struct TrackerHandle {
    tx: Sender<TrackerCommand>,
    live: Arc<RwLock<LiveState>>,
}

/// How long a command waits for the tracker thread before giving up.
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);

impl TrackerHandle {
    pub fn send(&self, command: TrackerCommand) {
        if self.tx.send(command).is_err() {
            log::warn!("tracker thread is not running; command dropped");
        }
    }

    /// Send a command built around a reply channel and wait for the reply.
    pub fn request<T>(&self, build: impl FnOnce(Sender<T>) -> TrackerCommand) -> Option<T> {
        let (reply_tx, reply_rx) = mpsc::channel();
        if self.tx.send(build(reply_tx)).is_err() {
            log::warn!("tracker thread is not running; request dropped");
            return None;
        }
        match reply_rx.recv_timeout(REPLY_TIMEOUT) {
            Ok(value) => Some(value),
            Err(err) => {
                log::warn!("tracker did not reply: {err}");
                None
            }
        }
    }

    pub fn status(&self) -> TrackerStatus {
        match self.live.read() {
            Ok(live) => live.status.clone(),
            Err(poisoned) => poisoned.into_inner().status.clone(),
        }
    }

    pub fn open_interval(&self) -> Option<Interval> {
        match self.live.read() {
            Ok(live) => live.open.clone(),
            Err(poisoned) => poisoned.into_inner().open.clone(),
        }
    }
}

/// Run a [`TrackerCore`] on a dedicated thread named `studio-pulse-tracker`, ticking every
/// `poll_ms` regardless of how many commands arrive in between.
pub fn spawn(core: TrackerCore, poll_ms: u64) -> std::io::Result<TrackerHandle> {
    let (tx, rx) = mpsc::channel::<TrackerCommand>();
    let live = core.live();
    let poll = Duration::from_millis(poll_ms.max(100));
    std::thread::Builder::new()
        .name("studio-pulse-tracker".into())
        .spawn(move || {
            let mut core = core;
            let mut next_tick = Instant::now();
            loop {
                let wait = next_tick.saturating_duration_since(Instant::now());
                match rx.recv_timeout(wait) {
                    Ok(command) => {
                        let keep_running =
                            match catch_unwind(AssertUnwindSafe(|| core.handle(command))) {
                                Ok(keep) => keep,
                                Err(_) => {
                                    log::error!("tracker command handler panicked; continuing");
                                    true
                                }
                            };
                        if !keep_running {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if catch_unwind(AssertUnwindSafe(|| core.tick())).is_err() {
                            log::error!("tracker tick panicked; continuing");
                        }
                        next_tick += poll;
                        let now = Instant::now();
                        if next_tick < now {
                            // Fell behind (system was suspended or heavily loaded): don't burst.
                            next_tick = now + poll;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        let (reply, _rx) = mpsc::channel();
                        core.handle(TrackerCommand::Shutdown { reply });
                        break;
                    }
                }
            }
            log::info!("tracker thread stopped");
        })?;
    Ok(TrackerHandle { tx, live })
}
