//! [`SyncLedger`] for the local SQLite store (Phase 2A outbox). Schema: migrations/0002.
//!
//! - Account, sync workspace and last success live in `meta` under `account_user_id`,
//!   `sync_workspace_id` and `last_sync_success_ms` (strings; absent = none).
//! - The outbox is `tracking_events` itself: a row is uploadable while it is `closed`,
//!   `pending` and owned by the signed-in user. Sync state changes only ever touch closed,
//!   pending rows, so an open interval is never marked and a synced or rejected one never
//!   changes again. Ownership is the one exception: [`SyncLedger::claim_unowned`] also gives
//!   the open interval to the user, so it is uploaded once it closes.
//! - Every multi-row change runs in one `BEGIN IMMEDIATE` transaction. Id lists are bound as
//!   a single JSON array parameter (`json_each`), so their length is not limited by SQLite's
//!   parameter limit and a duplicated id still changes its row once.
//! - Error text stored in `last_sync_error` is cut to [`MAX_SYNC_ERROR_CHARS`] characters.

use rusqlite::{params, Row};

use crate::cloud::ledger::{LedgerError, OutboxCounts, PendingEntry, SyncLedger};
use crate::tracker::EpochMs;

use super::preferences::{self, read_meta, write_meta, LAST_SYNC_SUCCESS_KEY, SYNC_WORKSPACE_KEY};
use super::{to_i64, Store, StoreError};

/// `last_sync_error` keeps at most this many characters (Unicode scalar values).
const MAX_SYNC_ERROR_CHARS: usize = 300;

/// Closed, pending rows of one owner, oldest first. Served by `tracking_events_outbox_by_user`.
const SELECT_PENDING: &str = "SELECT id, device_id, application_id, application_name, kind,
        started_at_ms, ended_at_ms, active_ms, idle_ms, end_reason, project_id, task_id,
        revision, created_at_ms
    FROM tracking_events
    WHERE state = 'closed' AND sync_status = 'pending' AND user_id = ?1
    ORDER BY started_at_ms, id
    LIMIT ?2";

/// One snapshot of the three outbox counts. `?1` NULL (signed out) matches no owner, so
/// `pending` is 0 then.
const OUTBOX_COUNTS: &str = "SELECT
        (SELECT COUNT(*) FROM tracking_events
         WHERE state = 'closed' AND sync_status = 'pending' AND user_id = ?1),
        (SELECT COUNT(*) FROM tracking_events
         WHERE state = 'closed' AND sync_status = 'pending' AND user_id IS NULL),
        (SELECT COUNT(*) FROM tracking_events WHERE sync_status = 'failed')";

/// `?1` = JSON array of ids. Rows already synced, rejected or still open are left alone, so
/// confirming the same upload twice is a no-op.
///
/// The unary `+` keeps `state` / `sync_status` out of index selection: without it SQLite walks
/// the whole closed-pending outbox (`tracking_events_sync_outbox`) and filters it by the id
/// list, so each batch would cost O(outbox) instead of O(batch). A unit test pins the plan.
const MARK_SYNCED: &str = "UPDATE tracking_events
    SET sync_status = 'synced', workspace_id = ?2, synced_at_ms = ?3, last_sync_error = NULL
    WHERE id IN (SELECT value FROM json_each(?1))
      AND +state = 'closed' AND +sync_status = 'pending'";

const MARK_REJECTED: &str = "UPDATE tracking_events
    SET sync_status = 'failed', last_sync_error = ?2
    WHERE id = ?1 AND state = 'closed' AND sync_status = 'pending'";

/// `?1` = JSON array of ids. One call is one attempt, even if an id is listed twice. Looked up
/// by id for the same reason as [`MARK_SYNCED`].
const RECORD_ATTEMPT_FAILURE: &str = "UPDATE tracking_events
    SET sync_attempts = sync_attempts + 1, last_sync_error = ?2
    WHERE id IN (SELECT value FROM json_each(?1))
      AND +state = 'closed' AND +sync_status = 'pending'";

/// `?1` = JSON array of ids; the ones present, in any state.
const EXISTING_IDS: &str =
    "SELECT id FROM tracking_events WHERE id IN (SELECT value FROM json_each(?1))";

/// Rows recorded while signed out, open or closed, pending or rejected. A row that is already
/// synced keeps its (absent) owner: it is on the server already and must not be re-attributed.
const CLAIM_UNOWNED: &str = "UPDATE tracking_events
    SET user_id = ?1
    WHERE user_id IS NULL AND sync_status <> 'synced'";

impl SyncLedger for Store {
    fn set_account_user(&self, user_id: Option<&str>) -> Result<(), LedgerError> {
        if let Some(id) = user_id {
            require_non_empty("user id", id)?;
        }
        self.with_conn(|conn| write_meta(conn, preferences::ACCOUNT_USER_KEY, user_id))
            .map_err(ledger_error)
    }

    fn account_user(&self) -> Result<Option<String>, LedgerError> {
        self.with_conn(preferences::account_user)
            .map_err(ledger_error)
    }

    fn sync_workspace(&self) -> Result<Option<String>, LedgerError> {
        self.with_conn(|conn| read_meta(conn, SYNC_WORKSPACE_KEY))
            .map_err(ledger_error)
    }

    fn set_sync_workspace(&self, workspace_id: Option<&str>) -> Result<(), LedgerError> {
        if let Some(id) = workspace_id {
            require_non_empty("workspace id", id)?;
        }
        self.with_conn(|conn| write_meta(conn, SYNC_WORKSPACE_KEY, workspace_id))
            .map_err(ledger_error)
    }

    fn pending_entries(
        &self,
        user_id: &str,
        limit: usize,
    ) -> Result<Vec<PendingEntry>, LedgerError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        self.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(SELECT_PENDING)?;
            let rows = stmt.query_map(params![user_id, to_i64(limit)], map_pending)?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .map_err(ledger_error)
    }

    fn outbox_counts(&self, user_id: Option<&str>) -> Result<OutboxCounts, LedgerError> {
        let (pending, unclaimed, rejected) = self
            .with_conn(|conn| {
                Ok(conn.query_row(OUTBOX_COUNTS, params![user_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?)
            })
            .map_err(ledger_error)?;
        Ok(OutboxCounts {
            pending: count(pending),
            unclaimed: count(unclaimed),
            rejected: count(rejected),
        })
    }

    fn mark_synced(
        &self,
        ids: &[String],
        workspace_id: &str,
        at_ms: EpochMs,
    ) -> Result<usize, LedgerError> {
        require_non_empty("workspace id", workspace_id)?;
        if ids.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            let ids = serde_json::to_string(ids)?;
            Ok(tx.execute(MARK_SYNCED, params![ids, workspace_id, at_ms])?)
        })
        .map_err(ledger_error)
    }

    fn mark_rejected(&self, rejections: &[(String, String)]) -> Result<usize, LedgerError> {
        if rejections.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            let mut stmt = tx.prepare_cached(MARK_REJECTED)?;
            let mut updated = 0;
            for (id, reason) in rejections {
                updated += stmt.execute(params![id, truncate_error(reason)])?;
            }
            Ok(updated)
        })
        .map_err(ledger_error)
    }

    fn existing_ids(&self, ids: &[String]) -> Result<Vec<String>, LedgerError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        self.with_conn(|conn| {
            let ids = serde_json::to_string(ids)?;
            let mut stmt = conn.prepare_cached(EXISTING_IDS)?;
            let rows = stmt.query_map(params![ids], |row| row.get::<_, String>(0))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .map_err(ledger_error)
    }

    fn record_attempt_failure(&self, ids: &[String], error: &str) -> Result<(), LedgerError> {
        if ids.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            let ids = serde_json::to_string(ids)?;
            tx.execute(RECORD_ATTEMPT_FAILURE, params![ids, truncate_error(error)])?;
            Ok(())
        })
        .map_err(ledger_error)
    }

    fn claim_unowned(&self, user_id: &str) -> Result<usize, LedgerError> {
        require_non_empty("user id", user_id)?;
        self.write(|tx| Ok(tx.execute(CLAIM_UNOWNED, params![user_id])?))
            .map_err(ledger_error)
    }

    fn last_sync_success(&self) -> Result<Option<EpochMs>, LedgerError> {
        let stored = self
            .with_conn(|conn| read_meta(conn, LAST_SYNC_SUCCESS_KEY))
            .map_err(ledger_error)?;
        Ok(stored.and_then(|value| match value.parse::<EpochMs>() {
            Ok(at_ms) => Some(at_ms),
            Err(_) => {
                // Unknown rather than invented: the next successful pass overwrites it.
                log::warn!("stored last sync time is unreadable; treating it as never");
                None
            }
        }))
    }

    fn set_last_sync_success(&self, at_ms: EpochMs) -> Result<(), LedgerError> {
        let value = at_ms.to_string();
        self.with_conn(|conn| write_meta(conn, LAST_SYNC_SUCCESS_KEY, Some(&value)))
            .map_err(ledger_error)
    }
}

/// Map a [`SELECT_PENDING`] row.
fn map_pending(row: &Row<'_>) -> rusqlite::Result<PendingEntry> {
    Ok(PendingEntry {
        id: row.get(0)?,
        device_id: row.get(1)?,
        application_id: row.get(2)?,
        application_name: row.get(3)?,
        kind: row.get(4)?,
        started_at_ms: row.get(5)?,
        ended_at_ms: row.get(6)?,
        active_ms: row.get(7)?,
        idle_ms: row.get(8)?,
        // Closed rows always have one (schema CHECK); a NULL here is a conversion error.
        end_reason: row.get(9)?,
        project_id: row.get(10)?,
        task_id: row.get(11)?,
        revision: row.get(12)?,
        created_at_ms: row.get(13)?,
    })
}

/// The first [`MAX_SYNC_ERROR_CHARS`] characters of `text` (never splits a character).
fn truncate_error(text: &str) -> &str {
    match text.char_indices().nth(MAX_SYNC_ERROR_CHARS) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}

/// An empty id would stamp or mark rows with an owner/workspace nobody has.
fn require_non_empty(what: &str, value: &str) -> Result<(), LedgerError> {
    if value.trim().is_empty() {
        return Err(LedgerError(format!("the {what} must not be empty")));
    }
    Ok(())
}

/// `COUNT(*)` is never negative.
fn count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn ledger_error(err: StoreError) -> LedgerError {
    LedgerError(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_cut_at_a_character_boundary() {
        assert_eq!(truncate_error(""), "");
        assert_eq!(truncate_error("short"), "short");
        let exact = "x".repeat(MAX_SYNC_ERROR_CHARS);
        assert_eq!(truncate_error(&exact), exact);
        let long = "é".repeat(MAX_SYNC_ERROR_CHARS + 5);
        let cut = truncate_error(&long);
        assert_eq!(cut.chars().count(), MAX_SYNC_ERROR_CHARS);
        assert_eq!(cut.len(), 2 * MAX_SYNC_ERROR_CHARS, "two bytes per 'é'");
    }

    /// `EXPLAIN QUERY PLAN` details of `sql`, one line per step.
    fn plan(store: &Store, sql: &str, values: impl rusqlite::Params) -> String {
        store
            .with_conn(|conn| {
                let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let steps = stmt
                    .query_map(values, |row| row.get::<_, String>(3))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(steps.join("\n"))
            })
            .unwrap()
    }

    #[test]
    fn outbox_statements_use_their_indexes() {
        let store = Store::open_in_memory().unwrap();
        // Id-list writes probe the primary key once per id: their cost follows the batch, not
        // the size of the outbox (a claimed backlog can hold many thousands of pending rows).
        let by_id = [
            (
                "mark_synced",
                plan(&store, MARK_SYNCED, params![r#"["a"]"#, "w", 1]),
            ),
            (
                "record_attempt_failure",
                plan(&store, RECORD_ATTEMPT_FAILURE, params![r#"["a"]"#, "e"]),
            ),
            (
                "mark_rejected",
                plan(&store, MARK_REJECTED, params!["a", "e"]),
            ),
        ];
        for (name, steps) in by_id {
            assert!(
                steps.contains("(id=?)"),
                "{name} looks rows up by id:\n{steps}"
            );
            assert!(
                !steps.contains("SCAN tracking_events") && !steps.contains("sync_outbox"),
                "{name} must not walk the table or the outbox:\n{steps}"
            );
        }
        // The upload query is served by migration 0002's index.
        let steps = plan(&store, SELECT_PENDING, params!["u", 10]);
        assert!(
            steps.contains("USING INDEX tracking_events_outbox_by_user"),
            "pending_entries:\n{steps}"
        );
    }

    #[test]
    fn a_poisoned_lock_is_a_ledger_error_not_a_panic() {
        let store = std::sync::Arc::new(Store::open_in_memory().unwrap());
        let poisoner = std::sync::Arc::clone(&store);
        let joined = std::thread::spawn(move || {
            let _guard = poisoner.conn.lock().unwrap();
            panic!("poison the connection lock");
        })
        .join();
        assert!(joined.is_err());
        let err = store.outbox_counts(Some("u")).unwrap_err();
        assert_eq!(err.to_string(), "local database: database lock poisoned");
        assert!(store.mark_synced(&["a".to_owned()], "w", 1).is_err());
    }
}
