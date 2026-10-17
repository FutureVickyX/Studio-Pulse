//! [`SyncLedger`] for the local SQLite store (Phase 2A outbox). Schema: migrations/0002.

use crate::cloud::ledger::{LedgerError, OutboxCounts, PendingEntry, SyncLedger};
use crate::tracker::EpochMs;

use super::Store;

impl SyncLedger for Store {
    fn set_account_user(&self, _user_id: Option<&str>) -> Result<(), LedgerError> {
        todo!("Store::set_account_user")
    }

    fn account_user(&self) -> Result<Option<String>, LedgerError> {
        todo!("Store::account_user")
    }

    fn sync_workspace(&self) -> Result<Option<String>, LedgerError> {
        todo!("Store::sync_workspace")
    }

    fn set_sync_workspace(&self, _workspace_id: Option<&str>) -> Result<(), LedgerError> {
        todo!("Store::set_sync_workspace")
    }

    fn pending_entries(
        &self,
        _user_id: &str,
        _limit: usize,
    ) -> Result<Vec<PendingEntry>, LedgerError> {
        todo!("Store::pending_entries")
    }

    fn outbox_counts(&self, _user_id: Option<&str>) -> Result<OutboxCounts, LedgerError> {
        todo!("Store::outbox_counts")
    }

    fn mark_synced(
        &self,
        _ids: &[String],
        _workspace_id: &str,
        _at_ms: EpochMs,
    ) -> Result<usize, LedgerError> {
        todo!("Store::mark_synced")
    }

    fn mark_rejected(&self, _rejections: &[(String, String)]) -> Result<usize, LedgerError> {
        todo!("Store::mark_rejected")
    }

    fn record_attempt_failure(&self, _ids: &[String], _error: &str) -> Result<(), LedgerError> {
        todo!("Store::record_attempt_failure")
    }

    fn claim_unowned(&self, _user_id: &str) -> Result<usize, LedgerError> {
        todo!("Store::claim_unowned")
    }

    fn last_sync_success(&self) -> Result<Option<EpochMs>, LedgerError> {
        todo!("Store::last_sync_success")
    }

    fn set_last_sync_success(&self, _at_ms: EpochMs) -> Result<(), LedgerError> {
        todo!("Store::set_last_sync_success")
    }
}
