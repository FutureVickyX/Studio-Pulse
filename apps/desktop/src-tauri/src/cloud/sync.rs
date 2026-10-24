//! The background uploader of closed local intervals (docs/supabase.md §Sync).
//!
//! One dedicated thread runs [`SyncCore::run_once`], so two sync jobs can never submit the same
//! batch concurrently. Per pass: take a valid access token, read up to `batch_size` pending
//! intervals of the signed-in user, call `sync_time_entries`, and apply the per-entry results:
//! `Synced` → mark synced (only now); `Rejected` → mark failed (kept, never retried
//! automatically). A whole-call failure leaves every entry pending and schedules a retry with
//! bounded exponential backoff and jitter. Retrying after a lost response is safe: the server
//! reports already-present entries as `Synced`, and the primary key forbids duplicates.
//!
//! An entry the server's answer does not mention stays pending (its attempt is recorded as a
//! failure and the pass backs off): nothing is marked synced without the server's confirmation.

use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use super::account::{AccountError, AccountManager, AccountState};
use super::api::{EntryOutcome, EntryResult, RemoteApi, RemoteError, RemoteTimeEntry};
use super::ledger::{LedgerError, OutboxCounts, PendingEntry, SyncLedger};
use crate::store::iso_from_ms;
use crate::tracker::EpochMs;

/// `sync_time_entries` refuses more entries than this in one call.
const SERVER_MAX_BATCH: usize = 500;
/// Batches uploaded by one pass before the thread looks at its commands again. A pass that stops
/// here returns `RetryAfter(0)` and the next pass continues immediately.
const MAX_BATCHES_PER_PASS: usize = 25;
/// A server-requested delay (`Retry-After`) is honoured, but never shorter than this.
const MIN_SERVER_RETRY_MS: u64 = 1_000;
/// New intervals are uploaded this long after the first `Kick` (bursts coalesce).
const KICK_DEBOUNCE: Duration = Duration::from_secs(2);
/// A pass runs this long after `AccountChanged` (one sign-in emits several changes).
const ACCOUNT_CHANGE_DELAY: Duration = Duration::from_millis(500);
/// The first pass after the thread starts.
const STARTUP_DELAY: Duration = Duration::from_secs(1);
/// The periodic check never runs more often than this, whatever the settings say.
const MIN_IDLE_INTERVAL: Duration = Duration::from_secs(1);
/// A retry after a failure never runs sooner than this, whatever the settings say.
const MIN_RETRY_WAIT: Duration = Duration::from_millis(250);
/// Longest single wait of the thread (keeps `Instant` arithmetic far from overflow).
const MAX_WAIT: Duration = Duration::from_secs(24 * 60 * 60);
/// The range of instants an ISO-8601 timestamp with a four-digit year can express.
const MIN_ISO_MS: EpochMs = -62_167_219_200_000;
const MAX_ISO_MS: EpochMs = 253_402_300_799_999;

const SESSION_EXPIRED: &str = "Your session has expired. Sign in again to resume syncing.";
const SESSION_REFUSED: &str =
    "Supabase refused the renewed session. Studio Pulse will try again shortly.";
const INTERNAL_ERROR: &str =
    "Sync stopped because of an internal error. Studio Pulse will try again.";
const NOT_RECORDED: &str =
    "The local database did not record the last upload. Studio Pulse will try again.";

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
///
/// Attempt 0 counts as 1. A `jitter_unit` outside [0, 1] is clamped; NaN means no jitter.
pub fn backoff_delay_ms(attempt: u32, settings: &SyncSettings, jitter_unit: f64) -> u64 {
    let exponent = attempt.max(1) - 1;
    let growth = 2u64.checked_pow(exponent).unwrap_or(u64::MAX);
    let capped = settings
        .base_delay_ms
        .saturating_mul(growth)
        .min(settings.max_delay_ms);
    let unit = if jitter_unit.is_nan() {
        0.5
    } else {
        jitter_unit.clamp(0.0, 1.0)
    };
    // Exact for any delay below 2^53 ms; the float-to-int cast saturates.
    (capped as f64 * (0.8 + 0.4 * unit)).round() as u64
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
    ledger: Arc<dyn SyncLedger>,
    account: Arc<AccountManager>,
    api: Option<Arc<dyn RemoteApi>>,
    settings: SyncSettings,
    clock: Box<dyn Fn() -> EpochMs + Send>,
    jitter: Box<dyn FnMut() -> f64 + Send>,
    /// What the last pass concluded (or `Syncing` while one uploads).
    phase: SyncPhase,
    /// Consecutive failed passes; drives the backoff (0 = not backing off).
    failures: u32,
    last_attempt_at_ms: Option<EpochMs>,
    next_attempt_at_ms: Option<EpochMs>,
    last_error: Option<String>,
    /// Publishes the `Syncing` phase while a pass runs (installed by [`spawn`]).
    progress: Option<ProgressHook>,
}

/// Receives the overview when a pass starts uploading.
type ProgressHook = Box<dyn Fn(&SyncOverview) + Send>;

/// One batch either settled completely or ended the pass.
type BatchResult = Result<(), PassOutcome>;

impl SyncCore {
    pub fn new(
        ledger: Arc<dyn SyncLedger>,
        account: Arc<AccountManager>,
        api: Option<Arc<dyn RemoteApi>>,
        settings: SyncSettings,
        clock: Box<dyn Fn() -> EpochMs + Send>,
        jitter: Box<dyn FnMut() -> f64 + Send>,
    ) -> Self {
        let phase = if api.is_some() {
            SyncPhase::Idle
        } else {
            SyncPhase::Disabled
        };
        Self {
            ledger,
            account,
            api,
            settings,
            clock,
            jitter,
            phase,
            failures: 0,
            last_attempt_at_ms: None,
            next_attempt_at_ms: None,
            last_error: None,
            progress: None,
        }
    }

    /// Upload until nothing is pending or something fails. Never marks an entry synced unless the
    /// server confirmed it.
    pub fn run_once(&mut self) -> PassOutcome {
        self.next_attempt_at_ms = None;
        let Some(api) = self.api.clone() else {
            return self.block(SyncPhase::Disabled, None);
        };
        let account = self.account.status();
        let user_id = match (account.state, account.user_id) {
            (AccountState::SignedIn, Some(user_id)) => user_id,
            (AccountState::NotConfigured, _) => return self.block(SyncPhase::Disabled, None),
            (AccountState::SessionExpired, _) => {
                return self.block(SyncPhase::NeedsSignIn, Some(SESSION_EXPIRED.into()))
            }
            (AccountState::SignedOut | AccountState::SignedIn, _) => {
                // Nobody to upload as: only history recorded while signed out can be waiting.
                return match self.ledger.outbox_counts(None) {
                    Ok(counts) if counts.pending > 0 || counts.unclaimed > 0 => {
                        self.block(SyncPhase::NeedsSignIn, None)
                    }
                    Ok(_) => self.block(SyncPhase::Disabled, None),
                    Err(err) => self.local_failure(&err),
                };
            }
        };
        // Memberships still unknown (restored offline): load them before reading the selection,
        // which a fresh list may clear.
        self.account.ensure_workspaces_loaded();
        let workspace_id = match self.ledger.sync_workspace() {
            Ok(Some(workspace_id)) => workspace_id,
            Ok(None) => return self.block(SyncPhase::NeedsWorkspace, None),
            Err(err) => return self.local_failure(&err),
        };

        let batch_size = self.settings.batch_size.clamp(1, SERVER_MAX_BATCH);
        // Every id this pass settled (synced or rejected): if the database lists one as pending
        // again, its update did not stick, and uploading it again in a loop would never end.
        let mut settled: HashSet<String> = HashSet::new();
        for _ in 0..MAX_BATCHES_PER_PASS {
            let mut entries = match self.ledger.pending_entries(&user_id, batch_size) {
                Ok(entries) => entries,
                Err(err) => return self.local_failure(&err),
            };
            if entries.is_empty() {
                return self.idle();
            }
            entries.truncate(batch_size);
            if entries.iter().any(|entry| settled.contains(&entry.id)) {
                log::error!("sync: settled intervals are still listed as pending");
                return self.retry_with_backoff(SyncPhase::Error, NOT_RECORDED.into(), None);
            }
            if let Err(outcome) = self.upload_batch(
                api.as_ref(),
                &user_id,
                &workspace_id,
                &entries,
                &mut settled,
            ) {
                return outcome;
            }
        }
        // More may remain: let the thread handle its commands, then continue right away.
        self.phase = SyncPhase::Syncing;
        PassOutcome::RetryAfter(0)
    }

    pub fn overview(&self) -> SyncOverview {
        let account = self.account.status();
        let counts = self
            .ledger
            .outbox_counts(account.user_id.as_deref())
            .unwrap_or_else(|err| {
                log::warn!("sync status: {err}");
                OutboxCounts::default()
            });
        let last_success = self.ledger.last_sync_success().unwrap_or_else(|err| {
            log::warn!("sync status: {err}");
            None
        });
        let workspace_name = account.sync_workspace_id.as_deref().and_then(|id| {
            account
                .workspaces
                .iter()
                .find(|w| w.id.eq_ignore_ascii_case(id))
                .map(|w| w.name.clone())
        });
        SyncOverview {
            phase: self.phase,
            pending_count: counts.pending,
            unclaimed_count: counts.unclaimed,
            rejected_count: counts.rejected,
            last_success_at: last_success.map(iso_from_ms),
            last_attempt_at: self.last_attempt_at_ms.map(iso_from_ms),
            next_attempt_at: self.next_attempt_at_ms.map(iso_from_ms),
            last_error: self.last_error.clone(),
            workspace_id: account.sync_workspace_id,
            workspace_name,
        }
    }

    // ---- private ------------------------------------------------------------------------

    /// Upload one batch and apply the per-entry results. `Err` ends the pass with that outcome.
    fn upload_batch(
        &mut self,
        api: &dyn RemoteApi,
        user_id: &str,
        workspace_id: &str,
        entries: &[PendingEntry],
        settled: &mut HashSet<String>,
    ) -> BatchResult {
        // An interval whose times cannot be written as ISO-8601 is refused here, never altered.
        let mut payload = Vec::with_capacity(entries.len());
        let mut unsendable = Vec::new();
        for entry in entries {
            match to_remote(entry) {
                Some(remote) => payload.push(remote),
                None => unsendable.push((
                    entry.id.clone(),
                    "the interval's times are out of range".to_owned(),
                )),
            }
        }
        if !unsendable.is_empty() {
            if let Err(err) = self.ledger.mark_rejected(&unsendable) {
                return Err(self.local_failure(&err));
            }
            settled.extend(unsendable.into_iter().map(|(id, _)| id));
        }
        if payload.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = payload.iter().map(|entry| entry.id.clone()).collect();

        let ctx = match self.account.access() {
            Ok(ctx) => ctx,
            Err(err) => return Err(self.access_failure(err)),
        };
        if ctx.user_id != user_id {
            return Err(self.account_moved());
        }
        self.still_selected(workspace_id)?;
        self.enter_syncing();
        self.last_attempt_at_ms = Some((self.clock)());
        let mut access_token = ctx.access_token;
        let mut result = api.sync_time_entries(&access_token, workspace_id, &payload);
        if matches!(result, Err(RemoteError::Unauthorized)) {
            // The access token was refused: refresh once, retry once.
            let ctx = match self.account.handle_unauthorized() {
                Ok(ctx) => ctx,
                Err(err) => return Err(self.access_failure(err)),
            };
            if ctx.user_id != user_id {
                return Err(self.account_moved());
            }
            self.still_selected(workspace_id)?;
            self.last_attempt_at_ms = Some((self.clock)());
            access_token = ctx.access_token;
            result = api.sync_time_entries(&access_token, workspace_id, &payload);
        }
        match result {
            Ok(results) => {
                self.apply_results(api, &access_token, workspace_id, &ids, results, settled)
            }
            Err(RemoteError::Unauthorized) => {
                // Even a freshly renewed token was refused (e.g. a skewed clock): try later.
                self.note_attempt_failure(&ids, "Supabase refused the session");
                Err(self.retry_with_backoff(SyncPhase::Backoff, SESSION_REFUSED.into(), None))
            }
            Err(err) if err.is_transient() => {
                self.note_attempt_failure(&ids, &err.to_string());
                Err(self.transient_failure(&err))
            }
            Err(err) => {
                // Not allowed (e.g. removed from the workspace) or refused as a whole: every entry
                // stays pending and nothing is retried until the user acts.
                log::warn!("sync stopped: {err}");
                Err(self.block(SyncPhase::Error, Some(err.to_string())))
            }
        }
    }

    /// Mark exactly the entries the server confirmed; anything it did not mention stays pending.
    fn apply_results(
        &mut self,
        api: &dyn RemoteApi,
        access_token: &str,
        workspace_id: &str,
        ids: &[String],
        results: Vec<EntryResult>,
        settled: &mut HashSet<String>,
    ) -> BatchResult {
        let sent: HashMap<String, &String> = ids.iter().map(|id| (id_key(id), id)).collect();
        let mut outcomes: HashMap<String, EntryOutcome> = HashMap::new();
        let mut unknown = 0usize;
        for result in results {
            match sent.get(&id_key(&result.id)) {
                // The first answer for an id counts.
                Some(id) => {
                    outcomes.entry((*id).clone()).or_insert(result.outcome);
                }
                None => unknown += 1,
            }
        }
        if unknown > 0 {
            log::warn!("sync: ignored {unknown} results for entries that were not sent");
        }
        let mut synced = Vec::new();
        let mut rejected = Vec::new();
        let mut missing = Vec::new();
        for id in ids {
            match outcomes.remove(id) {
                Some(EntryOutcome::Synced) => synced.push(id.clone()),
                Some(EntryOutcome::Rejected(reason)) => rejected.push((id.clone(), reason)),
                None => missing.push(id.clone()),
            }
        }

        let now = (self.clock)();
        if !synced.is_empty() {
            if let Err(err) = self.ledger.mark_synced(&synced, workspace_id, now) {
                // The server has them; the next attempt is answered "already present".
                return Err(self.local_failure(&err));
            }
            self.remove_deleted_during_upload(api, access_token, &synced);
        }
        if !rejected.is_empty() {
            log::warn!(
                "sync: Supabase rejected {} entries; they are kept locally and not retried",
                rejected.len()
            );
            if let Err(err) = self.ledger.mark_rejected(&rejected) {
                return Err(self.local_failure(&err));
            }
        }
        settled.extend(synced);
        settled.extend(rejected.into_iter().map(|(id, _)| id));

        if !missing.is_empty() {
            self.note_attempt_failure(&missing, "not confirmed by Supabase");
            let message = format!(
                "Supabase did not confirm {} of {} entries. They stay pending and will be sent \
                 again.",
                missing.len(),
                ids.len()
            );
            return Err(self.retry_with_backoff(SyncPhase::Backoff, message, None));
        }

        // The whole batch is settled.
        self.failures = 0;
        self.last_error = None;
        if let Err(err) = self.ledger.set_last_sync_success(now) {
            log::warn!("sync: could not record the last success: {err}");
        }
        Ok(())
    }

    fn enter_syncing(&mut self) {
        if self.phase == SyncPhase::Syncing {
            return;
        }
        self.phase = SyncPhase::Syncing;
        if self.progress.is_some() {
            let overview = self.overview();
            if let Some(progress) = &self.progress {
                progress(&overview);
            }
        }
    }

    fn note_attempt_failure(&self, ids: &[String], error: &str) {
        if let Err(err) = self.ledger.record_attempt_failure(ids, error) {
            log::warn!("sync: could not record the failed attempt: {err}");
        }
    }

    /// Nothing to do until the user (or the account) changes something.
    fn block(&mut self, phase: SyncPhase, error: Option<String>) -> PassOutcome {
        self.phase = phase;
        self.failures = 0;
        self.last_error = error;
        self.next_attempt_at_ms = None;
        PassOutcome::Blocked
    }

    fn idle(&mut self) -> PassOutcome {
        self.phase = SyncPhase::Idle;
        self.failures = 0;
        self.last_error = None;
        self.next_attempt_at_ms = None;
        PassOutcome::Idle
    }

    /// Count a failure and schedule the next attempt (the server's delay when it named one).
    fn retry_with_backoff(
        &mut self,
        phase: SyncPhase,
        message: String,
        server_delay_ms: Option<u64>,
    ) -> PassOutcome {
        self.failures = self.failures.saturating_add(1);
        let delay = match server_delay_ms {
            Some(ms) => ms
                .max(MIN_SERVER_RETRY_MS)
                .min(self.settings.max_delay_ms.max(MIN_SERVER_RETRY_MS)),
            None => backoff_delay_ms(self.failures, &self.settings, (self.jitter)()),
        };
        self.phase = phase;
        self.last_error = Some(message);
        let now = (self.clock)();
        self.next_attempt_at_ms =
            Some(now.saturating_add(i64::try_from(delay).unwrap_or(i64::MAX)));
        PassOutcome::RetryAfter(delay)
    }

    fn transient_failure(&mut self, err: &RemoteError) -> PassOutcome {
        let phase = match err {
            RemoteError::Network(_) => SyncPhase::WaitingForNetwork,
            _ => SyncPhase::Backoff,
        };
        let server_delay = match err {
            RemoteError::RateLimited { retry_after_ms } => *retry_after_ms,
            _ => None,
        };
        self.retry_with_backoff(phase, err.to_string(), server_delay)
    }

    fn local_failure(&mut self, err: &LedgerError) -> PassOutcome {
        log::error!("sync: {err}");
        self.retry_with_backoff(SyncPhase::Error, err.to_string(), None)
    }

    /// No usable access token.
    fn access_failure(&mut self, err: AccountError) -> PassOutcome {
        match err {
            AccountError::Remote(remote) if remote.is_transient() => {
                self.transient_failure(&remote)
            }
            AccountError::NotConfigured(_) => self.block(SyncPhase::Disabled, None),
            AccountError::NotSignedIn
            | AccountError::Remote(RemoteError::Unauthorized | RemoteError::Forbidden(_)) => {
                // The session ended (expired, or signed out meanwhile). Entries stay pending.
                let expired = self.account.status().state == AccountState::SessionExpired;
                self.block(
                    SyncPhase::NeedsSignIn,
                    expired.then(|| SESSION_EXPIRED.to_owned()),
                )
            }
            AccountError::Remote(remote) => self.block(SyncPhase::Error, Some(remote.to_string())),
            AccountError::Invalid(message) | AccountError::Local(message) => {
                self.retry_with_backoff(SyncPhase::Error, message, None)
            }
        }
    }

    /// Someone else signed in while the pass ran: stop; the account change starts a new pass.
    /// Intervals the user deleted on this device while their upload was in flight reached the
    /// server anyway. Delete them there too, so deleting history means what it says. Best effort:
    /// a failure is logged, and the rows stay the user's own to delete.
    fn remove_deleted_during_upload(
        &self,
        api: &dyn RemoteApi,
        access_token: &str,
        synced: &[String],
    ) {
        let present: HashSet<String> = match self.ledger.existing_ids(synced) {
            Ok(present) => present.iter().map(|id| id_key(id)).collect(),
            Err(err) => {
                log::warn!(
                    "sync: could not check for intervals deleted during their upload: {err}"
                );
                return;
            }
        };
        let gone: Vec<String> = synced
            .iter()
            .filter(|id| !present.contains(&id_key(id)))
            .cloned()
            .collect();
        if gone.is_empty() {
            return;
        }
        match api.delete_time_entries(access_token, &gone) {
            Ok(()) => log::info!(
                "sync: removed {} interval(s) from Supabase that were deleted on this device                  during their upload",
                gone.len()
            ),
            Err(err) => log::warn!(
                "sync: {} interval(s) deleted on this device during their upload are still on                  Supabase: {err}",
                gone.len()
            ),
        }
    }

    /// The sync workspace can change while a pass runs: another one chosen, or cleared by
    /// `select_sync_workspace(None)` or sign-out. Server rows can't be moved afterwards, so every
    /// request goes to the workspace selected right now, never to one the user just left;
    /// otherwise the pass ends and the next one uses the new selection.
    fn still_selected(&mut self, workspace_id: &str) -> BatchResult {
        match self.ledger.sync_workspace() {
            Ok(Some(current)) if current.eq_ignore_ascii_case(workspace_id) => Ok(()),
            Ok(_) => Err(self.account_moved()),
            Err(err) => Err(self.local_failure(&err)),
        }
    }

    fn account_moved(&mut self) -> PassOutcome {
        self.phase = SyncPhase::Idle;
        self.next_attempt_at_ms = None;
        PassOutcome::RetryAfter(duration_ms(ACCOUNT_CHANGE_DELAY))
    }

    /// A panic escaped a pass: report it and retry with backoff.
    fn after_panic(&mut self) -> PassOutcome {
        log::error!("a sync pass panicked; retrying later");
        self.retry_with_backoff(SyncPhase::Error, INTERNAL_ERROR.into(), None)
    }

    fn reset_backoff(&mut self) {
        self.failures = 0;
    }

    fn is_backing_off(&self) -> bool {
        self.failures > 0
    }
}

/// UUIDs compare case-insensitively.
fn id_key(id: &str) -> String {
    id.trim().to_ascii_lowercase()
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// ISO-8601 UTC with milliseconds, or `None` when a four-digit year cannot express the instant.
fn iso_ms(ms: EpochMs) -> Option<String> {
    if !(MIN_ISO_MS..=MAX_ISO_MS).contains(&ms) {
        return None;
    }
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|instant| instant.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// The upload payload of one closed interval: the recorded values, unchanged.
fn to_remote(entry: &PendingEntry) -> Option<RemoteTimeEntry> {
    Some(RemoteTimeEntry {
        id: entry.id.clone(),
        device_id: entry.device_id.clone(),
        application_id: entry.application_id.clone(),
        application_name: entry.application_name.clone(),
        kind: entry.kind.clone(),
        started_at: iso_ms(entry.started_at_ms)?,
        ended_at: iso_ms(entry.ended_at_ms)?,
        active_ms: entry.active_ms,
        idle_ms: entry.idle_ms,
        end_reason: entry.end_reason.clone(),
        project_id: entry.project_id.clone(),
        task_id: entry.task_id.clone(),
        revision: entry.revision,
        recorded_at: iso_ms(entry.created_at_ms)?,
    })
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

/// Keeps the shared snapshot current and calls the observer only when the overview changed.
struct Publisher {
    observer: SyncObserver,
    shared: Arc<RwLock<SyncOverview>>,
    last: Mutex<SyncOverview>,
}

impl Publisher {
    fn publish(&self, overview: &SyncOverview) {
        {
            let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
            if *last == *overview {
                return;
            }
            *last = overview.clone();
        }
        match self.shared.write() {
            Ok(mut shared) => *shared = overview.clone(),
            Err(poisoned) => *poisoned.into_inner() = overview.clone(),
        }
        if catch_unwind(AssertUnwindSafe(|| (self.observer)(overview))).is_err() {
            log::error!("the sync status observer panicked");
        }
    }
}

/// How the thread treats a `Kick` between passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Waiting {
    /// Kicks start a (debounced) pass.
    Ready,
    /// Retrying after a failure: kicks only refresh the counts.
    BackingOff,
    /// Stopped by an error the user must resolve: kicks only refresh the counts.
    Halted,
}

struct Schedule {
    next_pass: Option<Instant>,
    kick: Option<Instant>,
    waiting: Waiting,
}

fn after(duration: Duration) -> Instant {
    Instant::now() + duration.min(MAX_WAIT)
}

fn placeholder_overview(phase: SyncPhase) -> SyncOverview {
    SyncOverview {
        phase,
        pending_count: 0,
        unclaimed_count: 0,
        rejected_count: 0,
        last_success_at: None,
        last_attempt_at: None,
        next_attempt_at: None,
        last_error: None,
        workspace_id: None,
        workspace_name: None,
    }
}

fn publish_overview(core: &SyncCore, publisher: &Publisher) {
    match catch_unwind(AssertUnwindSafe(|| core.overview())) {
        Ok(overview) => publisher.publish(&overview),
        Err(_) => log::error!("could not compute the sync status"),
    }
}

/// One pass (panics contained), then schedule the next one from its outcome and publish.
fn run_pass(core: &mut SyncCore, publisher: &Publisher, schedule: &mut Schedule) {
    schedule.next_pass = None;
    schedule.kick = None;
    let outcome = match catch_unwind(AssertUnwindSafe(|| core.run_once())) {
        Ok(outcome) => outcome,
        Err(_) => core.after_panic(),
    };
    let idle_interval =
        Duration::from_millis(core.settings.idle_interval_ms).max(MIN_IDLE_INTERVAL);
    match outcome {
        PassOutcome::Idle => {
            schedule.waiting = Waiting::Ready;
            schedule.next_pass = Some(after(idle_interval));
        }
        PassOutcome::RetryAfter(ms) => {
            let wait = Duration::from_millis(ms);
            if core.is_backing_off() {
                schedule.waiting = Waiting::BackingOff;
                schedule.next_pass = Some(after(wait.max(MIN_RETRY_WAIT)));
            } else {
                schedule.waiting = Waiting::Ready;
                schedule.next_pass = Some(after(wait));
            }
        }
        PassOutcome::Blocked if core.phase == SyncPhase::Error => {
            schedule.waiting = Waiting::Halted;
        }
        PassOutcome::Blocked => {
            // Signed out, expired or no workspace: a cheap local re-check now and then.
            schedule.waiting = Waiting::Ready;
            schedule.next_pass = Some(after(idle_interval));
        }
    }
    publish_overview(core, publisher);
}

fn run_loop(mut core: SyncCore, commands: &Receiver<SyncCommand>, publisher: &Publisher) {
    let mut schedule = Schedule {
        next_pass: Some(after(STARTUP_DELAY)),
        kick: None,
        waiting: Waiting::Ready,
    };
    loop {
        let deadline = [schedule.next_pass, schedule.kick]
            .into_iter()
            .flatten()
            .min();
        let received = match deadline {
            Some(at) => commands.recv_timeout(at.saturating_duration_since(Instant::now())),
            None => commands.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match received {
            Ok(SyncCommand::Kick) => {
                if schedule.kick.is_none() {
                    schedule.kick = Some(after(KICK_DEBOUNCE));
                }
            }
            Ok(SyncCommand::SyncNow { reply }) => {
                core.reset_backoff();
                run_pass(&mut core, publisher, &mut schedule);
                let _ = reply.send(());
            }
            Ok(SyncCommand::AccountChanged) => {
                // Whatever failed before concerned the previous account or workspace.
                core.reset_backoff();
                schedule.waiting = Waiting::Ready;
                let soon = after(ACCOUNT_CHANGE_DELAY);
                schedule.next_pass = Some(schedule.next_pass.map_or(soon, |at| at.min(soon)));
            }
            Ok(SyncCommand::Shutdown { reply }) => {
                let _ = reply.send(());
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        let now = Instant::now();
        if schedule.next_pass.is_some_and(|at| at <= now) {
            // The pass also covers a pending kick.
            run_pass(&mut core, publisher, &mut schedule);
        } else if schedule.kick.is_some_and(|at| at <= now) {
            schedule.kick = None;
            if schedule.waiting == Waiting::Ready {
                run_pass(&mut core, publisher, &mut schedule);
            } else {
                // No extra submission while backing off or halted; keep the counts current.
                publish_overview(&core, publisher);
            }
        }
    }
    log::info!("sync thread stopped");
}

/// Run a [`SyncCore`] on a dedicated thread named `studio-pulse-sync`.
pub fn spawn(core: SyncCore, observer: SyncObserver) -> std::io::Result<SyncHandle> {
    let mut core = core;
    let initial = catch_unwind(AssertUnwindSafe(|| core.overview())).unwrap_or_else(|_| {
        log::error!("could not compute the initial sync status");
        placeholder_overview(core.phase)
    });
    let shared = Arc::new(RwLock::new(initial.clone()));
    let publisher = Arc::new(Publisher {
        observer,
        shared: Arc::clone(&shared),
        last: Mutex::new(initial),
    });
    let progress = Arc::clone(&publisher);
    core.progress = Some(Box::new(move |overview: &SyncOverview| {
        progress.publish(overview);
    }));
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("studio-pulse-sync".into())
        .spawn(move || run_loop(core, &rx, &publisher))?;
    Ok(SyncHandle {
        tx,
        overview: shared,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(base: u64, max: u64) -> SyncSettings {
        SyncSettings {
            batch_size: 10,
            base_delay_ms: base,
            max_delay_ms: max,
            idle_interval_ms: 60_000,
        }
    }

    #[test]
    fn backoff_doubles_from_base_and_caps_at_max_without_jitter() {
        let s = settings(5_000, 60_000);
        let delays: Vec<u64> = (1..=7).map(|a| backoff_delay_ms(a, &s, 0.5)).collect();
        assert_eq!(
            delays,
            [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]
        );
        assert_eq!(backoff_delay_ms(0, &s, 0.5), 5_000, "attempt 0 counts as 1");
        assert_eq!(backoff_delay_ms(u32::MAX, &s, 0.5), 60_000);
    }

    #[test]
    fn backoff_jitter_spans_plus_minus_twenty_percent() {
        let s = settings(10_000, 60_000);
        assert_eq!(backoff_delay_ms(1, &s, 0.0), 8_000);
        assert_eq!(backoff_delay_ms(1, &s, 1.0), 12_000);
        assert_eq!(backoff_delay_ms(1, &s, -3.0), 8_000);
        assert_eq!(backoff_delay_ms(1, &s, 7.0), 12_000);
        assert_eq!(backoff_delay_ms(1, &s, f64::NAN), 10_000);
    }

    #[test]
    fn backoff_with_base_above_max_is_capped() {
        assert_eq!(backoff_delay_ms(1, &settings(90_000, 60_000), 0.5), 60_000);
        assert_eq!(
            backoff_delay_ms(3, &settings(u64::MAX, u64::MAX), 0.5),
            u64::MAX
        );
    }

    #[test]
    fn iso_payload_times_are_utc_with_milliseconds() {
        assert_eq!(
            iso_ms(1_791_882_900_123).as_deref(),
            Some("2026-10-13T09:15:00.123Z")
        );
        assert_eq!(iso_ms(0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(iso_ms(MAX_ISO_MS + 1), None);
        assert_eq!(iso_ms(MIN_ISO_MS - 1), None);
    }

    #[test]
    fn payload_keeps_recorded_values_unchanged() {
        let entry = PendingEntry {
            id: "0190a7f0-0000-7000-8000-000000000001".into(),
            device_id: "0190a7f0-0000-7000-8000-0000000000d1".into(),
            application_id: "figma".into(),
            application_name: "Figma".into(),
            kind: "active".into(),
            started_at_ms: 1_791_882_900_000,
            ended_at_ms: 1_791_882_960_500,
            active_ms: 60_500,
            idle_ms: 0,
            end_reason: "appSwitch".into(),
            project_id: None,
            task_id: Some("t".into()),
            revision: 2,
            created_at_ms: 1_791_882_960_600,
        };
        let remote = to_remote(&entry).unwrap();
        assert_eq!(remote.started_at, "2026-10-13T09:15:00.000Z");
        assert_eq!(remote.ended_at, "2026-10-13T09:16:00.500Z");
        assert_eq!(remote.recorded_at, "2026-10-13T09:16:00.600Z");
        assert_eq!(remote.active_ms, 60_500);
        assert_eq!(remote.revision, 2);
        assert_eq!(remote.task_id.as_deref(), Some("t"));
        let json = serde_json::to_value(&remote).unwrap();
        for key in [
            "id",
            "deviceId",
            "applicationId",
            "applicationName",
            "kind",
            "startedAt",
            "endedAt",
            "activeMs",
            "idleMs",
            "endReason",
            "projectId",
            "taskId",
            "revision",
            "recordedAt",
        ] {
            assert!(json.get(key).is_some(), "payload is missing {key}");
        }
    }
}
