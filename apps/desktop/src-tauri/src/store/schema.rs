//! Connection PRAGMAs and schema migrations (`PRAGMA user_version`).

use std::time::Duration;

use rusqlite::{Connection, ErrorCode, TransactionBehavior};

use super::{to_i64, StoreError, StoreResult, BUSY_TIMEOUT_MS, MIGRATIONS};

/// Pause between attempts at switching a database to WAL while another connection holds it.
const WAL_RETRY_DELAY_MS: u64 = 50;
/// Attempts at switching to WAL: together they wait about as long as the busy timeout.
const WAL_ATTEMPTS: u64 = BUSY_TIMEOUT_MS / WAL_RETRY_DELAY_MS;

/// Per-connection settings. `file_backed` enables WAL (meaningless for `:memory:`).
pub(super) fn configure(conn: &Connection, file_backed: bool) -> StoreResult<()> {
    conn.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))?;
    if file_backed {
        enable_wal(conn)?;
    }
    // NORMAL is corruption-safe in WAL mode; a power cut can lose at most the last commits,
    // which crash recovery already tolerates (it under-counts, never over-counts).
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(())
}

/// Switch the file to WAL (a persistent property of the file, so usually already done).
///
/// Converting needs an exclusive lock. When two connections convert the same fresh file at
/// once, SQLite fails one of them with `SQLITE_BUSY` immediately (deadlock avoidance, so the
/// busy timeout does not apply); that attempt is retried within the same time budget.
/// `journal_mode` answers with the mode actually in effect: WAL can be refused (for example on
/// some network shares). The rollback journal is still durable, so that is logged, not fatal.
fn enable_wal(conn: &Connection) -> StoreResult<()> {
    let current: String = conn.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    if current.eq_ignore_ascii_case("wal") {
        return Ok(());
    }
    let mut attempt = 1;
    let mode: String = loop {
        match conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0)) {
            Ok(mode) => break mode,
            Err(err) if is_busy(&err) && attempt < WAL_ATTEMPTS => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(WAL_RETRY_DELAY_MS));
            }
            Err(err) => return Err(err.into()),
        }
    };
    if !mode.eq_ignore_ascii_case("wal") {
        log::warn!("SQLite could not enable WAL (journal_mode = {mode}); using {mode}");
    }
    Ok(())
}

fn is_busy(err: &rusqlite::Error) -> bool {
    matches!(
        err.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

/// `PRAGMA user_version`.
pub(super) fn user_version(conn: &Connection) -> StoreResult<i64> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

/// Apply every pending migration, each in its own `BEGIN IMMEDIATE` transaction together with
/// its `user_version` bump. A database newer than [`MIGRATIONS`] is refused and left untouched.
pub(super) fn migrate(conn: &mut Connection) -> StoreResult<()> {
    let supported = to_i64(MIGRATIONS.len());
    let mut current = checked_version(user_version(conn)?, supported)?;
    while current < supported {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Re-read under the write lock: another process may have migrated meanwhile.
        current = checked_version(user_version(&tx)?, supported)?;
        let pending = usize::try_from(current)
            .ok()
            .and_then(|index| MIGRATIONS.get(index));
        let Some(sql) = pending else {
            // Up to date after all.
            tx.commit()?;
            break;
        };
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", current + 1)?;
        tx.commit()?;
        current += 1;
        log::info!("applied local database migration {current}");
    }
    Ok(())
}

/// Reject versions this build cannot work with.
fn checked_version(found: i64, supported: i64) -> StoreResult<i64> {
    if found > supported {
        return Err(StoreError::UnsupportedSchema { found, supported });
    }
    if found < 0 {
        return Err(StoreError::Invalid(format!(
            "the local database has an unrecognised schema version ({found})"
        )));
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        configure(&conn, false).unwrap();
        conn
    }

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = fresh();
        migrate(&mut conn).unwrap();
        assert_eq!(user_version(&conn).unwrap(), to_i64(MIGRATIONS.len()));
        migrate(&mut conn).unwrap();
        assert_eq!(user_version(&conn).unwrap(), to_i64(MIGRATIONS.len()));
    }

    #[test]
    fn newer_or_negative_versions_are_refused_untouched() {
        let mut conn = fresh();
        conn.pragma_update(None, "user_version", 42).unwrap();
        assert!(matches!(
            migrate(&mut conn),
            Err(StoreError::UnsupportedSchema { found: 42, .. })
        ));
        assert_eq!(user_version(&conn).unwrap(), 42);
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0, "nothing was created");

        conn.pragma_update(None, "user_version", -1).unwrap();
        assert!(matches!(migrate(&mut conn), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn a_failing_migration_leaves_the_version_unchanged() {
        let mut conn = fresh();
        // Occupy a name the migration creates so it fails halfway through.
        conn.execute_batch("CREATE TABLE tracking_events (x INTEGER)")
            .unwrap();
        assert!(migrate(&mut conn).is_err());
        assert_eq!(user_version(&conn).unwrap(), 0);
        let meta_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'meta'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(meta_exists, 0, "the partial migration was rolled back");
    }
}
