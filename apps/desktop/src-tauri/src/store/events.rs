//! The `tracking_events` table: tracker upserts, crash recovery, queries, deletion, summary.

use rusqlite::{params, Connection, Row, Transaction};

use crate::tracker::{EndReason, EpochMs, Interval, IntervalKind};

use super::format::{iso_from_ms, seconds_from_ms};
use super::{
    invalid_column, DataSummary, RecoveryReport, StoreError, StoreResult, TrackingEventRecord,
    STORED_TRACKING_FIELDS,
};

/// `source` of every row the tracker writes.
const SOURCE_AUTOMATIC: &str = "automatic";
/// `sync_status` of a row that has not been synced (the Phase-2 outbox).
const SYNC_PENDING: &str = "pending";
const STATE_OPEN: &str = "open";
const STATE_CLOSED: &str = "closed";

/// Columns read by [`map_record`], in index order.
const SELECT_RECORD: &str = "SELECT id, user_id, device_id, application_id, application_name, kind,
        started_at_ms, ended_at_ms, active_ms, idle_ms, project_id, task_id, source, sync_status,
        state, end_reason, revision
    FROM tracking_events";

/// Insert, or update a row that is still open. A closed row is never modified, so replaying a
/// closed interval or an older open snapshot of it is a no-op.
const UPSERT: &str = "INSERT INTO tracking_events (
        id, device_id, user_id, application_id, application_name, kind,
        started_at_ms, ended_at_ms, active_ms, idle_ms, state, end_reason,
        project_id, task_id, source, sync_status, revision, created_at_ms, updated_at_ms)
    VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, ?12, ?13, 1, ?14, ?14)
    ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        ended_at_ms = excluded.ended_at_ms,
        started_at_ms = excluded.started_at_ms,
        active_ms = excluded.active_ms,
        idle_ms = excluded.idle_ms,
        state = excluded.state,
        end_reason = excluded.end_reason,
        revision = tracking_events.revision + 1,
        updated_at_ms = excluded.updated_at_ms
    WHERE tracking_events.state = 'open'";

/// Write `intervals` (one transaction, owned by the caller). Closed intervals go first so that
/// "close A, open B" never trips the one-open-interval-per-device index, whatever the order.
pub(super) fn upsert(
    tx: &Transaction<'_>,
    device_id: &str,
    intervals: &[Interval],
    now: EpochMs,
) -> StoreResult<()> {
    for interval in intervals {
        check_interval(interval)?;
    }
    let mut stmt = tx.prepare_cached(UPSERT)?;
    let closed_first = intervals
        .iter()
        .filter(|iv| !iv.open)
        .chain(intervals.iter().filter(|iv| iv.open));
    for interval in closed_first {
        stmt.execute(params![
            interval.id,
            device_id,
            interval.application_id,
            interval.application_name,
            interval.kind.as_str(),
            interval.started_at_ms,
            interval.ended_at_ms,
            interval.active_ms(),
            interval.idle_ms(),
            state_str(interval.open),
            interval.end_reason.map(EndReason::as_str),
            SOURCE_AUTOMATIC,
            SYNC_PENDING,
            now,
        ])?;
    }
    Ok(())
}

/// Reject intervals that break the engine contract before they reach SQL, with a readable
/// message instead of an anonymous CHECK failure.
fn check_interval(interval: &Interval) -> StoreResult<()> {
    if interval.id.is_empty() {
        return Err(StoreError::Invalid("an interval has an empty id".to_owned()));
    }
    if interval.ended_at_ms < interval.started_at_ms {
        return Err(StoreError::Invalid(format!(
            "interval {} ends before it starts",
            interval.id
        )));
    }
    if interval.open == interval.end_reason.is_some() {
        return Err(StoreError::Invalid(format!(
            "interval {} must have an end reason exactly when it is closed",
            interval.id
        )));
    }
    Ok(())
}

fn state_str(open: bool) -> &'static str {
    if open {
        STATE_OPEN
    } else {
        STATE_CLOSED
    }
}

/// Crash recovery (one transaction, owned by the caller): delete open rows shorter than
/// `min_interval_ms`, then close the rest at their last checkpoint with reason `recovered`.
pub(super) fn recover_open(
    tx: &Transaction<'_>,
    min_interval_ms: i64,
    now: EpochMs,
) -> StoreResult<RecoveryReport> {
    let discarded = tx.execute(
        "DELETE FROM tracking_events
         WHERE state = 'open' AND ended_at_ms - started_at_ms < ?1",
        params![min_interval_ms],
    )?;
    let closed = tx.execute(
        "UPDATE tracking_events
         SET state = 'closed', end_reason = ?1, revision = revision + 1, updated_at_ms = ?2
         WHERE state = 'open'",
        params![EndReason::Recovered.as_str(), now],
    )?;
    Ok(RecoveryReport { closed, discarded })
}

/// Latest `ended_at_ms` on `device_id`.
pub(super) fn high_water(conn: &Connection, device_id: &str) -> StoreResult<Option<EpochMs>> {
    Ok(conn.query_row(
        "SELECT MAX(ended_at_ms) FROM tracking_events WHERE device_id = ?1",
        params![device_id],
        |row| row.get(0),
    )?)
}

/// Delete the rows with these ids that are still open. Closed rows are never touched.
pub(super) fn discard_open(tx: &Transaction<'_>, ids: &[String]) -> StoreResult<usize> {
    let mut stmt =
        tx.prepare_cached("DELETE FROM tracking_events WHERE id = ?1 AND state = 'open'")?;
    let mut deleted = 0;
    for id in ids {
        deleted += stmt.execute(params![id])?;
    }
    Ok(deleted)
}

/// Rows overlapping `[from_ms, to_ms)`: touching an endpoint is not overlapping, and an empty
/// or inverted range overlaps nothing (not even an interval spanning it).
pub(super) fn list_range(
    conn: &Connection,
    from_ms: EpochMs,
    to_ms: EpochMs,
) -> StoreResult<Vec<TrackingEventRecord>> {
    if from_ms >= to_ms {
        return Ok(Vec::new());
    }
    let sql = format!(
        "{SELECT_RECORD} WHERE started_at_ms < ?2 AND ended_at_ms > ?1 ORDER BY started_at_ms, id"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(params![from_ms, to_ms], map_record)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every row, ordered by start then id.
pub(super) fn list_all(conn: &Connection) -> StoreResult<Vec<TrackingEventRecord>> {
    let sql = format!("{SELECT_RECORD} ORDER BY started_at_ms, id");
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map([], map_record)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// `None`: every row. `Some(t)`: closed rows that ended at or before `t`.
pub(super) fn delete(tx: &Transaction<'_>, before_ms: Option<EpochMs>) -> StoreResult<u64> {
    let deleted = match before_ms {
        None => tx.execute("DELETE FROM tracking_events", [])?,
        Some(t) => tx.execute(
            "DELETE FROM tracking_events WHERE state = 'closed' AND ended_at_ms <= ?1",
            params![t],
        )?,
    };
    Ok(u64::try_from(deleted).unwrap_or(u64::MAX))
}

/// Counts and bounds for the Privacy page.
pub(super) fn summary(
    conn: &Connection,
    device_id: String,
    database_path: String,
) -> StoreResult<DataSummary> {
    let (event_count, open_event_count, pending_sync_count, oldest, newest) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(state = 'open'), 0),
                COALESCE(SUM(state = 'closed' AND sync_status = 'pending'), 0),
                MIN(started_at_ms),
                MAX(ended_at_ms)
         FROM tracking_events",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<EpochMs>>(3)?,
                row.get::<_, Option<EpochMs>>(4)?,
            ))
        },
    )?;
    let application_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM applications", [], |row| row.get(0))?;
    Ok(DataSummary {
        device_id,
        database_path,
        event_count,
        open_event_count,
        pending_sync_count,
        application_count,
        oldest_event_at: oldest.map(iso_from_ms),
        newest_event_at: newest.map(iso_from_ms),
        stored_fields: STORED_TRACKING_FIELDS
            .iter()
            .copied()
            .map(str::to_owned)
            .collect(),
    })
}

/// Map a [`SELECT_RECORD`] row. Values the schema forbids surface as conversion errors.
fn map_record(row: &Row<'_>) -> rusqlite::Result<TrackingEventRecord> {
    let kind: String = row.get(5)?;
    let kind = IntervalKind::parse(&kind)
        .ok_or_else(|| invalid_column(5, format!("unknown interval kind {kind:?}")))?;
    let end_reason = row
        .get::<_, Option<String>>(15)?
        .map(|reason| {
            EndReason::parse(&reason)
                .ok_or_else(|| invalid_column(15, format!("unknown end reason {reason:?}")))
        })
        .transpose()?;
    let started_at_ms: EpochMs = row.get(6)?;
    let ended_at_ms: EpochMs = row.get(7)?;
    let active_ms: i64 = row.get(8)?;
    let idle_ms: i64 = row.get(9)?;
    Ok(TrackingEventRecord {
        id: row.get(0)?,
        user_id: row.get(1)?,
        device_id: row.get(2)?,
        application_id: row.get(3)?,
        application_name: row.get(4)?,
        kind,
        started_at: iso_from_ms(started_at_ms),
        ended_at: iso_from_ms(ended_at_ms),
        // The schema guarantees active_ms + idle_ms = ended_at_ms - started_at_ms.
        duration_seconds: seconds_from_ms(active_ms + idle_ms),
        active_seconds: seconds_from_ms(active_ms),
        idle_seconds: seconds_from_ms(idle_ms),
        project_id: row.get(10)?,
        task_id: row.get(11)?,
        source: row.get(12)?,
        sync_status: row.get(13)?,
        state: row.get(14)?,
        end_reason,
        revision: row.get(16)?,
        started_at_ms,
        ended_at_ms,
    })
}

/// Build the record the UI sees for an in-memory interval (live overlay of the open interval).
///
/// The record is what the row would look like once written: `source = automatic`,
/// `sync_status = pending`, no user, project or task. `revision` is `1` because an in-memory
/// interval does not know how often it has been checkpointed; the UI does not use it.
pub fn record_from_interval(interval: &Interval, device_id: &str) -> TrackingEventRecord {
    TrackingEventRecord {
        id: interval.id.clone(),
        user_id: None,
        device_id: device_id.to_owned(),
        application_id: interval.application_id.clone(),
        application_name: interval.application_name.clone(),
        kind: interval.kind,
        started_at: iso_from_ms(interval.started_at_ms),
        ended_at: iso_from_ms(interval.ended_at_ms),
        duration_seconds: seconds_from_ms(interval.duration_ms()),
        active_seconds: seconds_from_ms(interval.active_ms()),
        idle_seconds: seconds_from_ms(interval.idle_ms()),
        project_id: None,
        task_id: None,
        source: SOURCE_AUTOMATIC.to_owned(),
        sync_status: SYNC_PENDING.to_owned(),
        state: state_str(interval.open).to_owned(),
        end_reason: interval.end_reason,
        revision: 1,
        started_at_ms: interval.started_at_ms,
        ended_at_ms: interval.ended_at_ms,
    }
}
