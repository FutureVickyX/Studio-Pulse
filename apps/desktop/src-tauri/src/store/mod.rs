//! Local SQLite persistence (WAL). Schema: `migrations/*.sql`, docs/architecture.md §6.
//!
//! All SQL uses bound parameters. The tracker's upsert never modifies a closed row
//! (`ON CONFLICT(id) DO UPDATE … WHERE tracking_events.state = 'open'`), so replays are no-ops.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

use crate::registry::{ApplicationDefinition, ApplicationInput};
use crate::settings::Settings;
use crate::tracker::{EndReason, EpochMs, Interval, IntervalKind};

/// Ordered migrations, embedded at compile time. Index + 1 = `PRAGMA user_version` after applying.
pub const MIGRATIONS: &[&str] = &[include_str!("../../migrations/0001_init.sql")];

/// Column names stored per tracking record (shown verbatim in Privacy settings).
pub const STORED_TRACKING_FIELDS: &[&str] = &[
    "id",
    "device_id",
    "user_id",
    "application_id",
    "application_name",
    "kind",
    "started_at",
    "ended_at",
    "active_ms",
    "idle_ms",
    "state",
    "end_reason",
    "project_id",
    "task_id",
    "source",
    "sync_status",
    "revision",
];

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("database is newer than this app (schema {found}, supported {supported})")]
    UnsupportedSchema { found: i64, supported: i64 },
}

pub type StoreResult<T> = Result<T, StoreError>;

/// A stored interval. Serialized shape = `TrackingEvent` in shared-types.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingEventRecord {
    pub id: String,
    pub user_id: Option<String>,
    pub device_id: String,
    pub application_id: String,
    pub application_name: String,
    pub kind: IntervalKind,
    /// ISO-8601 UTC with milliseconds.
    pub started_at: String,
    pub ended_at: String,
    /// Seconds with millisecond precision.
    pub duration_seconds: f64,
    pub active_seconds: f64,
    pub idle_seconds: f64,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    /// `automatic` | `manual`.
    pub source: String,
    /// `pending` | `synced` | `failed`.
    pub sync_status: String,
    /// `open` | `closed`.
    pub state: String,
    pub end_reason: Option<EndReason>,
    pub revision: i64,
    #[serde(skip)]
    pub started_at_ms: EpochMs,
    #[serde(skip)]
    pub ended_at_ms: EpochMs,
}

/// Serialized shape = `DataSummary` in shared-types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSummary {
    pub device_id: String,
    pub database_path: String,
    pub event_count: i64,
    pub open_event_count: i64,
    pub pending_sync_count: i64,
    pub application_count: i64,
    pub oldest_event_at: Option<String>,
    pub newest_event_at: Option<String>,
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

pub struct Store {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
}

impl Store {
    /// Open (creating parent directories), enable WAL + foreign keys + busy timeout, migrate.
    pub fn open(_path: &Path) -> StoreResult<Self> {
        todo!("Store::open")
    }

    pub fn open_in_memory() -> StoreResult<Self> {
        todo!("Store::open_in_memory")
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn schema_version(&self) -> StoreResult<i64> {
        todo!("Store::schema_version")
    }

    /// This installation's device id (UUIDv4), created on first call and stable afterwards.
    pub fn device_id(&self) -> StoreResult<String> {
        todo!("Store::device_id")
    }

    // ---- settings ------------------------------------------------------------------------

    /// Stored settings, or defaults if none are stored. An invalid stored document is logged and
    /// replaced by defaults: never a crash.
    pub fn load_settings(&self) -> StoreResult<Settings> {
        todo!("Store::load_settings")
    }

    /// Validates, then stores.
    pub fn save_settings(&self, _settings: &Settings) -> StoreResult<()> {
        todo!("Store::save_settings")
    }

    // ---- applications --------------------------------------------------------------------

    /// Insert built-in applications missing by id (first run, or new built-ins after an upgrade).
    /// Existing rows, including user edits, are never touched. Returns the number inserted.
    pub fn seed_default_applications(&self) -> StoreResult<usize> {
        todo!("Store::seed_default_applications")
    }

    /// Ordered by sort_order, then display name.
    pub fn list_applications(&self) -> StoreResult<Vec<ApplicationDefinition>> {
        todo!("Store::list_applications")
    }

    /// Validates (registry::validate_input). `id: None` creates `custom-<8 hex>` (built_in = false,
    /// sort_order after the last row). An existing id updates the row: built-ins keep
    /// `built_in = true`. An unknown id → `NotFound`.
    pub fn save_application(&self, _input: &ApplicationInput) -> StoreResult<ApplicationDefinition> {
        todo!("Store::save_application")
    }

    /// Custom applications only. Built-ins → `Invalid` (disable them instead). Tracking history
    /// is kept (it carries the name snapshot).
    pub fn delete_application(&self, _id: &str) -> StoreResult<()> {
        todo!("Store::delete_application")
    }

    /// Restore every built-in to its default definition. Optionally delete custom applications.
    pub fn reset_applications(&self, _remove_custom: bool) -> StoreResult<Vec<ApplicationDefinition>> {
        todo!("Store::reset_applications")
    }

    /// Onboarding: `enabled = (id ∈ ids)` for every application. Unknown ids → `Invalid`.
    pub fn set_enabled_applications(&self, _ids: &[String]) -> StoreResult<()> {
        todo!("Store::set_enabled_applications")
    }

    // ---- tracking ------------------------------------------------------------------------

    /// Close every `open` row at its stored `ended_at_ms` with reason `recovered`. Delete those
    /// shorter than `min_interval_ms`. Run once at startup before the tracker starts.
    pub fn recover_open_intervals(&self, _min_interval_ms: i64) -> StoreResult<RecoveryReport> {
        todo!("Store::recover_open_intervals")
    }

    /// Latest `ended_at_ms` on this device, or `None` when there are no rows.
    pub fn high_water_ms(&self, _device_id: &str) -> StoreResult<Option<EpochMs>> {
        todo!("Store::high_water_ms")
    }

    /// Insert or update intervals in one transaction. Bumps `revision` and `updated_at_ms` on
    /// update. Never modifies a row that is already closed.
    pub fn upsert_intervals(&self, _device_id: &str, _intervals: &[Interval]) -> StoreResult<()> {
        todo!("Store::upsert_intervals")
    }

    /// Delete rows with these ids **only if they are still open**. Returns rows deleted.
    pub fn discard_open_intervals(&self, _ids: &[String]) -> StoreResult<usize> {
        todo!("Store::discard_open_intervals")
    }

    /// Intervals overlapping `[from_ms, to_ms)`, ordered by start.
    pub fn list_events(&self, _from_ms: EpochMs, _to_ms: EpochMs) -> StoreResult<Vec<TrackingEventRecord>> {
        todo!("Store::list_events")
    }

    /// Every interval, ordered by start (for export).
    pub fn list_all_events(&self) -> StoreResult<Vec<TrackingEventRecord>> {
        todo!("Store::list_all_events")
    }

    /// `None` deletes every row (the caller resets the engine). `Some(t)` deletes closed rows
    /// that ended at or before `t`. Returns rows deleted.
    pub fn delete_events(&self, _before_ms: Option<EpochMs>) -> StoreResult<u64> {
        todo!("Store::delete_events")
    }

    pub fn data_summary(&self) -> StoreResult<DataSummary> {
        todo!("Store::data_summary")
    }
}

/// Build the record the UI sees for an in-memory interval (live overlay of the open interval).
pub fn record_from_interval(_interval: &Interval, _device_id: &str) -> TrackingEventRecord {
    todo!("store::record_from_interval")
}

/// `2026-10-13T09:15:00.000Z`.
pub fn iso_from_ms(_ms: EpochMs) -> String {
    todo!("store::iso_from_ms")
}

/// RFC-4180 CSV with a header row; one line per record; times in ISO-8601 UTC.
pub fn export_csv(_records: &[TrackingEventRecord]) -> String {
    todo!("store::export_csv")
}

/// Pretty JSON: `{ "exportedAt", "deviceId", "format": "studio-pulse.tracking.v1", "events": [...] }`.
pub fn export_json(_records: &[TrackingEventRecord], _device_id: &str, _exported_at_ms: EpochMs) -> String {
    todo!("store::export_json")
}
