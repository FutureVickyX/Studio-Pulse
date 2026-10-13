//! The background tracker: samples the platform probe once per second, feeds the [`Engine`],
//! persists its output, checkpoints the open interval and publishes [`TrackerStatus`].
//!
//! Split for testability:
//! - [`TrackerCore`] holds all logic and is driven synchronously (`tick`, `handle`). Integration
//!   tests run it with a fake probe and a fake clock, with no threads and no Tauri.
//! - [`spawn`] runs a `TrackerCore` on a dedicated thread, using `recv_timeout(poll)` on the
//!   command channel as its tick.

use std::sync::mpsc::Sender;
use std::sync::{Arc, RwLock};

use serde::Serialize;

use crate::platform::SystemProbe;
use crate::registry::{AppCategory, Registry};
use crate::settings::Settings;
use crate::store::Store;

use super::engine::Engine;
use super::types::{EpochMs, Interval, IntervalKind};

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

/// Time source. Production: `SystemClock` (SystemTime + Instant). Tests: a manual clock.
pub trait Clock: Send {
    /// UTC epoch ms from the system clock.
    fn wall_ms(&self) -> EpochMs;
    /// Monotonic ms since an arbitrary fixed origin.
    fn mono_ms(&self) -> u64;
}

/// Messages from the command layer to the tracker thread.
pub enum TrackerCommand {
    /// Pause until `until_ms` (UTC epoch ms), or until resumed when `None`.
    Pause { until_ms: Option<EpochMs> },
    Resume,
    /// Settings changed: re-read them and reconfigure the engine. Handles enable/disable.
    SettingsChanged,
    /// Registry changed: matching changes take effect on the next sample.
    RegistryChanged,
    /// Local history was deleted: reset the engine's open interval and high-water mark.
    HistoryDeleted { reply: Sender<()> },
    /// Persist the open interval now.
    Flush { reply: Sender<()> },
    /// Close the open interval (`Shutdown`), persist, stop the thread.
    Shutdown { reply: Sender<()> },
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

/// Synchronous tracker logic. Owns the [`Engine`].
pub struct TrackerCore {
    deps: TrackerDeps,
    engine: Engine,
    live: Arc<RwLock<LiveState>>,
}

impl TrackerCore {
    /// Build the core. Applies startup policy: onboarding incomplete → `NotStarted`; tracking
    /// disabled → `Disabled`; `startAutomatically = false` → paused until resumed. Crash recovery
    /// (`Store::recover_open_intervals`) must already have run.
    pub fn new(_deps: TrackerDeps) -> Result<Self, crate::store::StoreError> {
        todo!("TrackerCore::new")
    }

    /// Take one sample and process it: engine step, persist, checkpoint when due, auto-resume
    /// when a timed pause expires, publish status if it changed.
    pub fn tick(&mut self) {
        todo!("TrackerCore::tick")
    }

    /// Handle one command. Returns false when the tracker should stop (after `Shutdown`).
    pub fn handle(&mut self, _command: TrackerCommand) -> bool {
        todo!("TrackerCore::handle")
    }

    pub fn live(&self) -> Arc<RwLock<LiveState>> {
        Arc::clone(&self.live)
    }

    pub fn status(&self) -> TrackerStatus {
        self.live.read().expect("live state poisoned").status.clone()
    }
}

/// Handle used by commands, the tray and the app shell.
#[derive(Clone)]
pub struct TrackerHandle {
    tx: Sender<TrackerCommand>,
    live: Arc<RwLock<LiveState>>,
}

impl TrackerHandle {
    pub fn send(&self, command: TrackerCommand) {
        if self.tx.send(command).is_err() {
            log::warn!("tracker thread is not running; command dropped");
        }
    }

    pub fn status(&self) -> TrackerStatus {
        self.live.read().expect("live state poisoned").status.clone()
    }

    pub fn open_interval(&self) -> Option<Interval> {
        self.live.read().expect("live state poisoned").open.clone()
    }
}

/// Run a [`TrackerCore`] on a dedicated thread named `studio-pulse-tracker`, ticking every
/// `poll_ms`.
pub fn spawn(_core: TrackerCore, _poll_ms: u64) -> TrackerHandle {
    todo!("tracker::service::spawn")
}
