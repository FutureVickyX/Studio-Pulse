//! The background uploader of closed local intervals (docs/supabase.md §Sync).
//!
//! One dedicated thread runs [`SyncCore::run_once`], so two sync jobs can never submit the same
//! batch concurrently. Per pass: take a valid access token, read up to `batch_size` pending
//! intervals of the signed-in user, call `sync_time_entries`, and apply the per-entry results:
//! `Synced` → mark synced (only now); `Rejected` → mark failed (kept, never retried
//! automatically). A whole-call failure leaves every entry pending and schedules a retry with
//! bounded exponential backoff and jitter. Retrying after a lost response is safe: the server
//! reports already-present entries as `Synced`, and the primary key forbids duplicates.

use std::sync::mpsc::Sender;
use std::sync::{Arc, RwLock};

use serde::Serialize;

use super::account::AccountManager;
use super::api::RemoteApi;
use super::ledger::SyncLedger;
use crate::tracker::EpochMs;

/// Serialized shape = `SyncPhase` in shared-types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncPhase {
    Disabled,
    Idle,
    Syncing,
    WaitingForNetwork,
    Backoff,
    NeedsSignIn,
    NeedsWorkspace,
    Error,
}

/// Serialized shape = `SyncOverview` in shared-types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOverview {
    pub phase: SyncPhase,
    pub pending_count: u64,
    pub unclaimed_count: u64,
    pub rejected_count: u64,
    /// ISO-8601.
    pub last_success_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncSettings {
    /// Entries per `sync_time_entries` call (the server accepts at most 500).
    pub batch_size: usize,
    /// First retry delay after a failure.
    pub base_delay_ms: u64,
    /// Retry delays never exceed this.
    pub max_delay_ms: u64,
    /// With nothing pending, check again after this long anyway.
    pub idle_interval_ms: u64,
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            batch_size: 100,
            base_delay_ms: 5_000,
            max_delay_ms: 15 * 60_000,
            idle_interval_ms: 5 * 60_000,
        }
    }
}

/// Delay before retry number `attempt` (1-based): `base · 2^(attempt-1)`, capped at `max`, then
/// multiplied by a jitter factor in [0.8, 1.2] derived from `jitter_unit` ∈ [0, 1). Pure.
pub fn backoff_delay_ms(_attempt: u32, _settings: &SyncSettings, _jitter_unit: f64) -> u64 {
    todo!("cloud::sync::backoff_delay_ms")
}

/// What one pass decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PassOutcome {
    /// Everything pending was uploaded (or there was nothing to do); check again later.
    Idle,
    /// Run again after this many ms (backoff, or more batches remain).
    RetryAfter(u64),
    /// Nothing can happen until the user acts (sign in, choose a workspace, …).
    Blocked,
}

/// Messages to the sync thread.
pub enum SyncCommand {
    /// New intervals were written; sync soon (debounced) unless backing off.
    Kick,
    /// The user pressed "Sync now": ignore backoff, run immediately, reply when done.
    SyncNow {
        reply: Sender<()>,
    },
    /// Signed in/out or the sync workspace changed.
    AccountChanged,
    Shutdown {
        reply: Sender<()>,
    },
}

/// Called whenever the overview changes (emits `sync://status`).
pub type SyncObserver = Box<dyn Fn(&SyncOverview) + Send + Sync>;

/// Synchronous sync logic, driven by [`spawn`] or directly by tests.
pub struct SyncCore {
    #[allow(dead_code)]
    ledger: Arc<dyn SyncLedger>,
    #[allow(dead_code)]
    account: Arc<AccountManager>,
    #[allow(dead_code)]
    api: Option<Arc<dyn RemoteApi>>,
    #[allow(dead_code)]
    settings: SyncSettings,
    #[allow(dead_code)]
    clock: Box<dyn Fn() -> EpochMs + Send>,
    #[allow(dead_code)]
    jitter: Box<dyn FnMut() -> f64 + Send>,
}

impl SyncCore {
    pub fn new(
        ledger: Arc<dyn SyncLedger>,
        account: Arc<AccountManager>,
        api: Option<Arc<dyn RemoteApi>>,
        settings: SyncSettings,
        clock: Box<dyn Fn() -> EpochMs + Send>,
        jitter: Box<dyn FnMut() -> f64 + Send>,
    ) -> Self {
        Self {
            ledger,
            account,
            api,
            settings,
            clock,
            jitter,
        }
    }

    /// Upload until nothing is pending or something fails. Never marks an entry synced unless the
    /// server confirmed it.
    pub fn run_once(&mut self) -> PassOutcome {
        todo!("SyncCore::run_once")
    }

    pub fn overview(&self) -> SyncOverview {
        todo!("SyncCore::overview")
    }
}

/// Handle used by commands and the tracker observer.
#[derive(Clone)]
pub struct SyncHandle {
    tx: Sender<SyncCommand>,
    overview: Arc<RwLock<SyncOverview>>,
}

impl SyncHandle {
    pub fn send(&self, command: SyncCommand) {
        if self.tx.send(command).is_err() {
            log::warn!("sync thread is not running; command dropped");
        }
    }

    pub fn overview(&self) -> SyncOverview {
        match self.overview.read() {
            Ok(o) => o.clone(),
            Err(p) => p.into_inner().clone(),
        }
    }
}

/// Run a [`SyncCore`] on a dedicated thread named `studio-pulse-sync`.
pub fn spawn(_core: SyncCore, _observer: SyncObserver) -> std::io::Result<SyncHandle> {
    todo!("cloud::sync::spawn")
}
