//! Local SQLite persistence (WAL). Schema: `migrations/*.sql`, docs/architecture.md §6.
//!
//! All SQL uses bound parameters. The tracker's upsert never modifies a closed row
//! (`ON CONFLICT(id) DO UPDATE … WHERE tracking_events.state = 'open'`), so replays are no-ops.
//!
//! Layout:
//! - this file: the public API, connection setup and locking;
//! - `schema`: PRAGMAs and migrations;
//! - `preferences`, `applications`, `events`: the SQL for each table group;
//! - `format`: ISO timestamps and the CSV / JSON exports (pure functions).
//!
//! Every public method takes the connection lock once. Writes that touch more than one row run
//! in a single `BEGIN IMMEDIATE` transaction, so they are all-or-nothing.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde::Serialize;

use crate::registry::{ApplicationDefinition, ApplicationInput, DefaultApplication};
use crate::settings::Settings;
use crate::tracker::{EndReason, EpochMs, Interval, IntervalKind};

mod applications;
mod events;
mod format;
mod preferences;
mod schema;

pub use events::record_from_interval;
pub use format::{export_csv, export_json, iso_from_ms, EXPORT_FORMAT};

/// Ordered migrations, embedded at compile time. Index + 1 = `PRAGMA user_version` after applying.
pub const MIGRATIONS: &[&str] = &[include_str!("../../migrations/0001_init.sql")];

/// Every column of `tracking_events`, exactly as stored (shown verbatim in Privacy settings).
/// A test keeps this in lockstep with the schema.
pub const STORED_TRACKING_FIELDS: &[&str] = &[
    "id",
    "device_id",
    "user_id",
    "application_id",
    "application_name",
    "kind",
    "started_at_ms",
    "ended_at_ms",
    "active_ms",
    "idle_ms",
    "state",
    "end_reason",
    "project_id",
    "task_id",
    "source",
    "sync_status",
    "revision",
    "created_at_ms",
    "updated_at_ms",
];

/// A user pause that must survive restarts ("Pause until I resume", "Pause for 1 hour").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseRecord {
    /// Paused until the user resumes.
    UntilResumed,
    /// Paused until this UTC epoch ms.
    Until(EpochMs),
}

/// Everything that can go wrong in the store.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// SQLite failed, including constraint violations (e.g. a second open interval).
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// A JSON document (matchers, settings) could not be serialized.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// The database directory could not be created.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// The referenced row does not exist. The message is shown to the user.
    #[error("{0}")]
    NotFound(String),
    /// The request was rejected (validation, a rule, or a poisoned lock). Shown to the user.
    #[error("{0}")]
    Invalid(String),
    /// The database was written by a newer version of the app.
    #[error("database is newer than this app (schema {found}, supported {supported})")]
    UnsupportedSchema {
        /// `PRAGMA user_version` of the file.
        found: i64,
        /// The newest schema this build knows (`MIGRATIONS.len()`).
        supported: i64,
    },
}

/// Result alias for store operations.
pub type StoreResult<T> = Result<T, StoreError>;

/// A stored interval. Serialized shape = `TrackingEvent` in shared-types.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingEventRecord {
    /// Stable UUIDv7 of the interval (the sync idempotency key).
    pub id: String,
    /// `None` until Phase-2 sign-in.
    pub user_id: Option<String>,
    /// The installation that recorded the interval.
    pub device_id: String,
    /// Registry id of the application.
    pub application_id: String,
    /// Display-name snapshot taken when the interval opened.
    pub application_name: String,
    /// Active or idle; the whole duration is one or the other.
    pub kind: IntervalKind,
    /// ISO-8601 UTC with milliseconds.
    pub started_at: String,
    /// ISO-8601 UTC with milliseconds (exclusive end).
    pub ended_at: String,
    /// Seconds with millisecond precision. Always `active_seconds + idle_seconds`.
    pub duration_seconds: f64,
    /// Seconds of active time (the whole duration for `kind = active`, else 0).
    pub active_seconds: f64,
    /// Seconds of idle time (the whole duration for `kind = idle`, else 0).
    pub idle_seconds: f64,
    /// Phase-3 attribution; always `None` in Phase 1.
    pub project_id: Option<String>,
    /// Phase-3 attribution; always `None` in Phase 1.
    pub task_id: Option<String>,
    /// `automatic` | `manual`.
    pub source: String,
    /// `pending` | `synced` | `failed`.
    pub sync_status: String,
    /// `open` | `closed`.
    pub state: String,
    /// Why the interval closed; `None` exactly while it is open.
    pub end_reason: Option<EndReason>,
    /// Bumped on every update of an open row (the Phase-2 sync keeps the highest).
    pub revision: i64,
    /// `started_at` as UTC epoch milliseconds (not serialized).
    #[serde(skip)]
    pub started_at_ms: EpochMs,
    /// `ended_at` as UTC epoch milliseconds (not serialized).
    #[serde(skip)]
    pub ended_at_ms: EpochMs,
}

/// Serialized shape = `DataSummary` in shared-types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSummary {
    /// This installation's device id.
    pub device_id: String,
    /// The database file, or `:memory:`.
    pub database_path: String,
    /// Every stored interval.
    pub event_count: i64,
    /// Intervals still being recorded (at most one per device).
    pub open_event_count: i64,
    /// Closed intervals not yet synced (the Phase-2 outbox).
    pub pending_sync_count: i64,
    /// Rows in the application registry.
    pub application_count: i64,
    /// Earliest `started_at` (ISO-8601), if any interval is stored.
    pub oldest_event_at: Option<String>,
    /// Latest `ended_at` (ISO-8601), if any interval is stored.
    pub newest_event_at: Option<String>,
    /// [`STORED_TRACKING_FIELDS`].
    pub stored_fields: Vec<String>,
}

/// Result of closing intervals left open by a crash or power loss.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Open rows closed at their last checkpoint with reason `recovered`.
    pub closed: usize,
    /// Open rows deleted because they were shorter than the minimum interval.
    pub discarded: usize,
}

/// The local database. One connection behind a mutex; `Send + Sync`, shared as `Arc<Store>`.
pub struct Store {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
}

/// `busy_timeout` for the connection, in milliseconds.
const BUSY_TIMEOUT_MS: u64 = 5_000;

/// Message of the error returned when a thread panicked while holding the connection.
const POISONED: &str = "database lock poisoned";

impl Store {
    /// Open (creating parent directories), enable WAL + foreign keys + busy timeout, migrate.
    ///
    /// Fails with [`StoreError::UnsupportedSchema`] when the file was written by a newer app;
    /// such a file is left untouched.
    pub fn open(path: &Path) -> StoreResult<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        schema::configure(&conn, true)?;
        schema::migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: Some(path.to_path_buf()),
        })
    }

    /// A private, fully migrated in-memory database (tests and fallbacks).
    pub fn open_in_memory() -> StoreResult<Self> {
        let mut conn = Connection::open_in_memory()?;
        schema::configure(&conn, false)?;
        schema::migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: None,
        })
    }

    /// The database file, or `None` for an in-memory store.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// `PRAGMA user_version`: the number of migrations applied.
    pub fn schema_version(&self) -> StoreResult<i64> {
        self.with_conn(schema::user_version)
    }

    /// This installation's device id (UUIDv4), created on first call and stable afterwards.
    pub fn device_id(&self) -> StoreResult<String> {
        self.with_conn(preferences::device_id)
    }

    // ---- settings ------------------------------------------------------------------------

    /// Stored settings, or defaults if none are stored. An invalid stored document is logged and
    /// replaced by defaults: never a crash. The invalid document stays on disk until the next
    /// [`Store::save_settings`].
    pub fn load_settings(&self) -> StoreResult<Settings> {
        self.with_conn(preferences::load_settings)
    }

    /// Validates, then stores. An invalid document → [`StoreError::Invalid`], nothing written.
    pub fn save_settings(&self, settings: &Settings) -> StoreResult<()> {
        self.with_conn(|conn| preferences::save_settings(conn, settings, now_ms()))
    }

    // ---- applications --------------------------------------------------------------------

    /// Insert built-in applications missing by id (first run, or new built-ins after an upgrade).
    /// Existing rows, including user edits, are never touched. Returns the number inserted.
    ///
    /// Consent: once onboarding is complete, newly added built-ins are inserted **disabled**, so
    /// an upgrade never starts tracking an application the user did not choose.
    pub fn seed_default_applications(&self) -> StoreResult<usize> {
        self.seed_applications(&crate::registry::default_applications())
    }

    /// [`Store::seed_default_applications`] with an explicit list of built-ins (the embedded
    /// registry in production; fixtures in tests). Built-in `i` gets `sort_order = i * 10`.
    /// A definition that violates the schema fails the whole call: nothing is skipped silently.
    pub fn seed_applications(&self, defaults: &[DefaultApplication]) -> StoreResult<usize> {
        let now = now_ms();
        self.write(|tx| {
            let onboarded = preferences::load_settings(tx)?.onboarding.completed;
            applications::seed(tx, defaults, !onboarded, now)
        })
    }

    /// Ordered by sort_order, then display name.
    pub fn list_applications(&self) -> StoreResult<Vec<ApplicationDefinition>> {
        self.with_conn(applications::list)
    }

    /// Validates (registry::validate_input). `id: None` creates `custom-<8 hex>` (built_in = false,
    /// sort_order after the last row). An existing id updates the row: built-ins keep
    /// `built_in = true`. An unknown id → `NotFound`.
    pub fn save_application(&self, input: &ApplicationInput) -> StoreResult<ApplicationDefinition> {
        self.save_application_with(input, crate::registry::validate_input)
    }

    /// [`Store::save_application`] with an explicit validator. The validator's error becomes
    /// [`StoreError::Invalid`] and nothing is written. Production code uses
    /// `save_application`, which validates with `registry::validate_input`.
    pub fn save_application_with<V>(
        &self,
        input: &ApplicationInput,
        validate: V,
    ) -> StoreResult<ApplicationDefinition>
    where
        V: FnOnce(&ApplicationInput) -> Result<(), String>,
    {
        validate(input).map_err(StoreError::Invalid)?;
        let now = now_ms();
        self.write(|tx| applications::save(tx, input, now))
    }

    /// Custom applications only. Built-ins → `Invalid` (disable them instead). Tracking history
    /// is kept (it carries the name snapshot).
    pub fn delete_application(&self, id: &str) -> StoreResult<()> {
        self.write(|tx| applications::delete(tx, id))
    }

    /// Restore every built-in to its default definition. Optionally delete custom applications.
    pub fn reset_applications(
        &self,
        remove_custom: bool,
    ) -> StoreResult<Vec<ApplicationDefinition>> {
        self.reset_applications_to(&crate::registry::default_applications(), remove_custom)
    }

    /// [`Store::reset_applications`] with an explicit list of built-ins. In one transaction:
    /// every built-in in `defaults` is rewritten to its default definition (name, category,
    /// matchers, `enabled_by_default`, included in reports, `sort_order = i * 10`) or inserted
    /// if missing; custom rows are deleted when `remove_custom`. Built-in rows that are no longer
    /// in `defaults` are left as they are. Returns the resulting list.
    pub fn reset_applications_to(
        &self,
        defaults: &[DefaultApplication],
        remove_custom: bool,
    ) -> StoreResult<Vec<ApplicationDefinition>> {
        let now = now_ms();
        self.write(|tx| applications::reset(tx, defaults, remove_custom, now))
    }

    /// Onboarding: `enabled = (id ∈ ids)` for every application. Unknown ids → `Invalid`.
    pub fn set_enabled_applications(&self, ids: &[String]) -> StoreResult<()> {
        let now = now_ms();
        self.write(|tx| applications::set_enabled(tx, ids, now))
    }

    // ---- tracking ------------------------------------------------------------------------

    /// Close every `open` row at its stored `ended_at_ms` with reason `recovered`. Delete those
    /// shorter than `min_interval_ms`. Run once at startup before the tracker starts.
    pub fn recover_open_intervals(&self, min_interval_ms: i64) -> StoreResult<RecoveryReport> {
        let now = now_ms();
        let report = self.write(|tx| events::recover_open(tx, min_interval_ms, now))?;
        if report != RecoveryReport::default() {
            log::info!(
                "recovered intervals left open by an unclean exit: {} closed, {} discarded",
                report.closed,
                report.discarded
            );
        }
        Ok(report)
    }

    /// Latest `ended_at_ms` on this device, or `None` when there are no rows.
    pub fn high_water_ms(&self, device_id: &str) -> StoreResult<Option<EpochMs>> {
        self.with_conn(|conn| events::high_water(conn, device_id))
    }

    /// Insert or update intervals in one transaction. Bumps `revision` and `updated_at_ms` on
    /// update. Never modifies a row that is already closed.
    ///
    /// Closed intervals in the batch are written before open ones, so "close A, open B" never
    /// trips the one-open-interval-per-device index whatever order the caller lists them in.
    /// An inconsistent interval (ends before it starts, `open` disagreeing with `end_reason`)
    /// fails the whole batch with [`StoreError::Invalid`]. A second open interval for a device
    /// that already has one fails with a SQLite constraint error; nothing is written.
    pub fn upsert_intervals(&self, device_id: &str, intervals: &[Interval]) -> StoreResult<()> {
        if intervals.is_empty() {
            return Ok(());
        }
        let now = now_ms();
        self.write(|tx| events::upsert(tx, device_id, intervals, now))
    }

    /// Delete rows with these ids **only if they are still open**. Returns rows deleted.
    pub fn discard_open_intervals(&self, ids: &[String]) -> StoreResult<usize> {
        if ids.is_empty() {
            return Ok(0);
        }
        self.write(|tx| events::discard_open(tx, ids))
    }

    /// Intervals overlapping `[from_ms, to_ms)`, ordered by start (then id). Intervals that only
    /// touch an endpoint are excluded; an empty or inverted range returns nothing.
    pub fn list_events(
        &self,
        from_ms: EpochMs,
        to_ms: EpochMs,
    ) -> StoreResult<Vec<TrackingEventRecord>> {
        self.with_conn(|conn| events::list_range(conn, from_ms, to_ms))
    }

    /// Every interval, ordered by start (for export).
    pub fn list_all_events(&self) -> StoreResult<Vec<TrackingEventRecord>> {
        self.with_conn(events::list_all)
    }

    /// `None` deletes every row (the caller resets the engine). `Some(t)` deletes closed rows
    /// that ended at or before `t`. Returns rows deleted.
    ///
    /// Deleted data does not linger: `secure_delete` zeroes the freed pages, and a
    /// `wal_checkpoint(TRUNCATE)` afterwards empties the write-ahead log, which still held the
    /// pre-delete page images.
    pub fn delete_events(&self, before_ms: Option<EpochMs>) -> StoreResult<u64> {
        let deleted = self.write(|tx| events::delete(tx, before_ms))?;
        if self.path.is_some() {
            self.with_conn(|conn| {
                conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
                Ok(())
            })?;
        }
        Ok(deleted)
    }

    // ---- tracker pause -------------------------------------------------------------------

    /// The persisted user pause, if any (restored by the tracker at startup).
    pub fn load_pause(&self) -> StoreResult<Option<PauseRecord>> {
        self.with_conn(preferences::load_pause)
    }

    /// Persist (`Some`) or clear (`None`) the user pause.
    pub fn save_pause(&self, pause: Option<PauseRecord>) -> StoreResult<()> {
        self.with_conn(|conn| preferences::save_pause(conn, pause))
    }

    /// Counts and bounds for the Privacy settings page.
    pub fn data_summary(&self) -> StoreResult<DataSummary> {
        let database_path = self
            .path
            .as_deref()
            .map_or_else(|| ":memory:".to_owned(), |p| p.display().to_string());
        self.with_conn(|conn| {
            let device_id = preferences::device_id(conn)?;
            events::summary(conn, device_id, database_path)
        })
    }

    // ---- internals -----------------------------------------------------------------------

    /// The connection, or `Invalid` if a thread panicked while holding it.
    fn lock(&self) -> StoreResult<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| StoreError::Invalid(POISONED.to_owned()))
    }

    /// Run `f` on the connection in autocommit mode (reads and single-statement writes).
    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> StoreResult<T>) -> StoreResult<T> {
        let conn = self.lock()?;
        f(&conn)
    }

    /// Run `f` in one `BEGIN IMMEDIATE` transaction; committed only if `f` succeeds.
    fn write<T>(&self, f: impl FnOnce(&Transaction<'_>) -> StoreResult<T>) -> StoreResult<T> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = f(&tx)?;
        tx.commit()?;
        Ok(value)
    }
}

/// Current UTC time in epoch milliseconds, for `created_at_ms` / `updated_at_ms` bookkeeping.
fn now_ms() -> EpochMs {
    chrono::Utc::now().timestamp_millis()
}

/// A row value the schema should have made impossible (corrupt or hand-edited database).
fn invalid_column(index: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, message.into())
}

/// Saturating `usize` → `i64` for SQL parameters.
fn to_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pragma_i64(store: &Store, name: &str) -> i64 {
        let conn = store.lock().unwrap();
        conn.pragma_query_value(None, name, |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn in_memory_store_is_migrated_and_configured() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.schema_version().unwrap(), to_i64(MIGRATIONS.len()));
        assert!(store.path().is_none());
        assert_eq!(pragma_i64(&store, "foreign_keys"), 1);
        assert_eq!(pragma_i64(&store, "busy_timeout"), 5_000);
    }

    #[test]
    fn file_store_uses_wal_and_normal_sync() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("pulse.sqlite3");
        let store = Store::open(&path).unwrap();
        assert!(path.exists(), "parent directories are created");
        assert_eq!(store.path(), Some(path.as_path()));
        let mode: String = store
            .lock()
            .unwrap()
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        assert_eq!(pragma_i64(&store, "synchronous"), 1, "NORMAL");
        assert_eq!(pragma_i64(&store, "foreign_keys"), 1);
        assert_eq!(pragma_i64(&store, "busy_timeout"), 5_000);
    }

    #[test]
    fn poisoned_lock_is_an_error_not_a_panic() {
        let store = std::sync::Arc::new(Store::open_in_memory().unwrap());
        let poisoner = std::sync::Arc::clone(&store);
        let joined = std::thread::spawn(move || {
            let _guard = poisoner.conn.lock().unwrap();
            panic!("poison the connection lock");
        })
        .join();
        assert!(joined.is_err());
        match store.device_id() {
            Err(StoreError::Invalid(message)) => assert_eq!(message, POISONED),
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn failed_write_rolls_back_the_whole_transaction() {
        let store = Store::open_in_memory().unwrap();
        let result: StoreResult<()> = store.write(|tx| {
            tx.execute("INSERT INTO meta (key, value) VALUES ('a', '1')", [])?;
            Err(StoreError::Invalid("abort".into()))
        });
        assert!(result.is_err());
        let count: i64 = store
            .with_conn(|conn| {
                let sql = "SELECT COUNT(*) FROM meta WHERE key = 'a'";
                Ok(conn.query_row(sql, [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn corrupt_rows_are_errors_not_panics() {
        let store = Store::open_in_memory().unwrap();
        store
            .with_conn(|conn| {
                conn.execute_batch(
                    "PRAGMA ignore_check_constraints = ON;
                     INSERT INTO tracking_events (id, device_id, application_id,
                         application_name, kind, started_at_ms, ended_at_ms, active_ms, idle_ms,
                         state, end_reason, created_at_ms, updated_at_ms)
                     VALUES ('x', 'd', 'a', 'A', 'busy', 0, 1, 1, 0, 'closed', 'meteor', 0, 0);
                     INSERT INTO applications (id, display_name, category, matchers_json,
                         enabled, include_in_reports, built_in, sort_order, created_at_ms,
                         updated_at_ms)
                     VALUES ('bad', 'Bad', 'design', '{}', 1, 1, 0, 0, 0, 0);
                     PRAGMA ignore_check_constraints = OFF;",
                )?;
                Ok(())
            })
            .unwrap();
        assert!(matches!(
            store.list_all_events(),
            Err(StoreError::Sqlite(_))
        ));
        assert!(matches!(
            store.list_events(0, 10),
            Err(StoreError::Sqlite(_))
        ));
        assert!(matches!(
            store.list_applications(),
            Err(StoreError::Sqlite(_))
        ));
    }

    #[test]
    fn first_custom_application_in_an_empty_table_sorts_at_zero() {
        let store = Store::open_in_memory().unwrap();
        let input = ApplicationInput {
            id: None,
            display_name: "Solo".to_owned(),
            category: crate::registry::AppCategory::Other,
            matchers: vec![crate::registry::ProcessMatcher {
                exe: "solo.exe".to_owned(),
                path_includes: None,
            }],
            enabled: true,
            include_in_reports: true,
        };
        let created = store.save_application_with(&input, |_| Ok(())).unwrap();
        assert_eq!(created.sort_order, 0);
        assert!(!created.built_in);
    }

    #[test]
    fn store_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Store>();
    }
}
