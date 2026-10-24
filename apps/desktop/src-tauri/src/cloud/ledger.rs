//! What the account manager and sync service need from the local database. Implemented by
//! [`crate::store::Store`]; tests use an in-memory fake.
//!
//! Ownership rules (docs/supabase.md):
//! - While an account is signed in, intervals recorded on this device are stamped with its user
//!   id when they are first written ([`SyncLedger::set_account_user`]).
//! - Intervals recorded while signed out have no owner. They are uploaded only after the user
//!   explicitly claims them ([`SyncLedger::claim_unowned`]); another account's intervals are
//!   never uploaded under the current one.

use crate::tracker::EpochMs;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("local database: {0}")]
pub struct LedgerError(pub String);

/// A closed, pending interval ready to upload (columns of `tracking_events`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingEntry {
    pub id: String,
    pub device_id: String,
    pub application_id: String,
    pub application_name: String,
    /// `active` | `idle`.
    pub kind: String,
    pub started_at_ms: EpochMs,
    pub ended_at_ms: EpochMs,
    pub active_ms: i64,
    pub idle_ms: i64,
    pub end_reason: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub revision: i64,
    pub created_at_ms: EpochMs,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OutboxCounts {
    /// Closed, pending intervals owned by the given user.
    pub pending: u64,
    /// Closed, pending intervals with no owner (recorded while signed out).
    pub unclaimed: u64,
    /// Intervals the server rejected permanently (`sync_status = 'failed'`), any owner.
    pub rejected: u64,
}

pub trait SyncLedger: Send + Sync {
    /// The account that owns intervals recorded from now on (`None` = signed out).
    fn set_account_user(&self, user_id: Option<&str>) -> Result<(), LedgerError>;
    fn account_user(&self) -> Result<Option<String>, LedgerError>;

    /// The workspace this device uploads to.
    fn sync_workspace(&self) -> Result<Option<String>, LedgerError>;
    fn set_sync_workspace(&self, workspace_id: Option<&str>) -> Result<(), LedgerError>;

    /// Closed, pending intervals owned by `user_id`, oldest first, at most `limit`.
    fn pending_entries(
        &self,
        user_id: &str,
        limit: usize,
    ) -> Result<Vec<PendingEntry>, LedgerError>;

    /// Outbox counts; `pending` is for `user_id` (0 when `None`).
    fn outbox_counts(&self, user_id: Option<&str>) -> Result<OutboxCounts, LedgerError>;

    /// Server-confirmed uploads: `sync_status = 'synced'`, `workspace_id`, `synced_at_ms`. Only
    /// closed, pending rows change. Returns rows updated.
    fn mark_synced(
        &self,
        ids: &[String],
        workspace_id: &str,
        at_ms: EpochMs,
    ) -> Result<usize, LedgerError>;

    /// Permanent rejections `(id, reason)`: `sync_status = 'failed'`, `last_sync_error`. The rows
    /// are kept. Returns rows updated.
    fn mark_rejected(&self, rejections: &[(String, String)]) -> Result<usize, LedgerError>;

    /// Which of `ids` still exist locally, in any state. Notices intervals deleted on this device
    /// while their upload was in flight.
    fn existing_ids(&self, ids: &[String]) -> Result<Vec<String>, LedgerError>;

    /// A transient failure for these rows: `sync_attempts += 1`, `last_sync_error = error`. They
    /// stay pending.
    fn record_attempt_failure(&self, ids: &[String], error: &str) -> Result<(), LedgerError>;

    /// Explicit consent: give intervals recorded while signed out (closed or open, `user_id`
    /// NULL) to `user_id`. Returns rows claimed.
    fn claim_unowned(&self, user_id: &str) -> Result<usize, LedgerError>;

    fn last_sync_success(&self) -> Result<Option<EpochMs>, LedgerError>;
    fn set_last_sync_success(&self, at_ms: EpochMs) -> Result<(), LedgerError>;
}
