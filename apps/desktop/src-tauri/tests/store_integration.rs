//! Store integration tests: migrations, the tracking invariants enforced by SQLite, crash
//! recovery, settings, the application registry table and the exports.
//!
//! Registry functions are exercised through the store's injection points
//! (`seed_applications`, `save_application_with`, `reset_applications_to`) with the embedded
//! defaults parsed here, so these tests do not depend on the registry module's implementation.

use std::path::{Path, PathBuf};
use std::slice;

use rusqlite::{params, Connection};
use studio_pulse_lib::registry::{
    AppCategory, ApplicationDefinition, ApplicationInput, DefaultApplication,
    DefaultApplicationsFile, ProcessMatcher, DEFAULT_APPLICATIONS_JSON,
};
use studio_pulse_lib::settings::{Settings, ThemePreference};
use studio_pulse_lib::store::{
    export_csv, export_json, iso_from_ms, record_from_interval, RecoveryReport, Store, StoreError,
    TrackingEventRecord, EXPORT_FORMAT, MIGRATIONS, STORED_TRACKING_FIELDS,
};
use studio_pulse_lib::tracker::IntervalKind::{Active, Idle};
use studio_pulse_lib::tracker::{EndReason, Interval, IntervalKind};
use tempfile::TempDir;

/// 2026-10-13T09:15:00.000Z.
const T0: i64 = 1_791_882_900_000;
const SEC: i64 = 1_000;

// ---- helpers ------------------------------------------------------------------------------

/// `T0` plus whole seconds.
fn at(seconds: i64) -> i64 {
    T0 + seconds * SEC
}

fn supported_version() -> i64 {
    i64::try_from(MIGRATIONS.len()).unwrap()
}

fn db_path(dir: &TempDir) -> PathBuf {
    dir.path().join("data").join("studio-pulse.sqlite3")
}

/// A second, raw connection to the same file (for checks the public API does not expose).
fn raw(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    conn
}

fn open_iv(id: &str, app: &str, kind: IntervalKind, start: i64, end: i64) -> Interval {
    Interval {
        id: id.to_owned(),
        application_id: app.to_owned(),
        application_name: format!("{app} (name)"),
        kind,
        started_at_ms: start,
        ended_at_ms: end,
        open: true,
        end_reason: None,
    }
}

fn closed_iv(
    id: &str,
    app: &str,
    kind: IntervalKind,
    start: i64,
    end: i64,
    reason: EndReason,
) -> Interval {
    Interval {
        open: false,
        end_reason: Some(reason),
        ..open_iv(id, app, kind, start, end)
    }
}

/// `interval`, closed at `end`.
fn close(interval: &Interval, end: i64, reason: EndReason) -> Interval {
    Interval {
        ended_at_ms: end,
        open: false,
        end_reason: Some(reason),
        ..interval.clone()
    }
}

fn ids(records: &[TrackingEventRecord]) -> Vec<&str> {
    records.iter().map(|r| r.id.as_str()).collect()
}

fn defaults() -> Vec<DefaultApplication> {
    serde_json::from_str::<DefaultApplicationsFile>(DEFAULT_APPLICATIONS_JSON)
        .unwrap()
        .applications
}

/// Test stand-in for `registry::validate_input`, implementing its documented rules.
fn validate(input: &ApplicationInput) -> Result<(), String> {
    let name = input.display_name.trim().chars().count();
    if !(1..=80).contains(&name) {
        return Err("display name must be 1-80 characters".to_owned());
    }
    if !(1..=16).contains(&input.matchers.len()) {
        return Err("an application needs 1-16 matchers".to_owned());
    }
    if input.matchers.iter().any(|m| m.exe.trim().is_empty()) {
        return Err("matcher exe must not be empty".to_owned());
    }
    if let Some(id) = &input.id {
        let valid = (2..=64).contains(&id.len())
            && !id.starts_with('-')
            && id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !valid {
            return Err("invalid id".to_owned());
        }
    }
    Ok(())
}

fn input(id: Option<&str>, name: &str, exe: &str) -> ApplicationInput {
    ApplicationInput {
        id: id.map(str::to_owned),
        display_name: name.to_owned(),
        category: AppCategory::Other,
        matchers: vec![ProcessMatcher {
            exe: exe.to_owned(),
            path_includes: None,
        }],
        enabled: true,
        include_in_reports: true,
    }
}

fn find<'a>(apps: &'a [ApplicationDefinition], id: &str) -> &'a ApplicationDefinition {
    apps.iter()
        .find(|app| app.id == id)
        .unwrap_or_else(|| panic!("application {id} missing"))
}

fn seeded_memory_store() -> Store {
    let store = Store::open_in_memory().unwrap();
    store.seed_applications(&defaults()).unwrap();
    store
}

fn is_constraint_violation(err: &StoreError) -> bool {
    matches!(
        err,
        StoreError::Sqlite(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

/// Minimal RFC 4180 reader: asserts CRLF line endings and returns the rows.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c != '"' {
                field.push(c);
            } else if chars.peek() == Some(&'"') {
                field.push('"');
                chars.next();
            } else {
                quoted = false;
            }
            continue;
        }
        match c {
            '"' => {
                assert!(field.is_empty(), "quote inside an unquoted field");
                quoted = true;
            }
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {
                assert_eq!(chars.next(), Some('\n'), "CR must start a CRLF");
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            '\n' => panic!("bare LF outside a quoted field"),
            other => field.push(other),
        }
    }
    assert!(!quoted, "unterminated quoted field");
    assert!(
        field.is_empty() && row.is_empty(),
        "the last line must end with CRLF"
    );
    rows
}

// ---- migrations and connection ------------------------------------------------------------

#[test]
fn migrations_apply_fresh_and_reopen_idempotently() {
    let dir = TempDir::new().unwrap();
    let path = db_path(&dir);
    let device = {
        let store = Store::open(&path).unwrap();
        assert!(path.exists(), "parent directory and file are created");
        assert_eq!(store.path(), Some(path.as_path()));
        assert_eq!(store.schema_version().unwrap(), supported_version());
        store.device_id().unwrap()
    };

    let tables: Vec<String> = raw(&path)
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        tables,
        ["applications", "meta", "preferences", "tracking_events"]
    );

    for _ in 0..2 {
        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), supported_version());
        assert_eq!(
            store.device_id().unwrap(),
            device,
            "data survives reopening"
        );
    }

    let memory = Store::open_in_memory().unwrap();
    assert_eq!(memory.schema_version().unwrap(), supported_version());
    assert_eq!(memory.path(), None);
}

#[test]
fn a_database_from_a_newer_app_is_refused_untouched() {
    let dir = TempDir::new().unwrap();
    let path = db_path(&dir);
    drop(Store::open(&path).unwrap());
    let future = supported_version() + 1;
    {
        let conn = raw(&path);
        conn.pragma_update(None, "user_version", future).unwrap();
        // A rollback-journal file shows whether opening changed its (persistent) journal mode.
        let mode: String = conn
            .pragma_update_and_check(None, "journal_mode", "DELETE", |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "delete");
    }

    match Store::open(&path) {
        Err(StoreError::UnsupportedSchema { found, supported }) => {
            assert_eq!(found, future);
            assert_eq!(supported, supported_version());
        }
        Err(other) => panic!("expected UnsupportedSchema, got {other:?}"),
        Ok(_) => panic!("expected UnsupportedSchema, got a store"),
    }
    let conn = raw(&path);
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, future, "the newer database is not migrated");
    let mode: String = conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "delete", "not even the journal mode is changed");
}

#[test]
fn device_id_is_a_uuid_v4_stable_across_reopen() {
    let dir = TempDir::new().unwrap();
    let path = db_path(&dir);
    let first = {
        let store = Store::open(&path).unwrap();
        let id = store.device_id().unwrap();
        assert_eq!(store.device_id().unwrap(), id, "stable within a session");
        id
    };
    assert_eq!(uuid::Uuid::parse_str(&first).unwrap().get_version_num(), 4);

    let store = Store::open(&path).unwrap();
    assert_eq!(store.device_id().unwrap(), first, "stable across restarts");
    let rows: i64 = raw(&path)
        .query_row(
            "SELECT COUNT(*) FROM meta WHERE key = 'device_id'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn concurrent_first_opens_agree_on_schema_and_device_id() {
    let dir = TempDir::new().unwrap();
    let path = db_path(&dir);
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let path = path.clone();
            std::thread::spawn(move || {
                let store = Store::open(&path).unwrap();
                (store.schema_version().unwrap(), store.device_id().unwrap())
            })
        })
        .collect();
    let results: Vec<(i64, String)> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results[0].0, supported_version());
    assert!(results.iter().all(|r| r == &results[0]), "{results:?}");
}

#[test]
fn file_databases_use_wal() {
    let dir = TempDir::new().unwrap();
    let path = db_path(&dir);
    let store = Store::open(&path).unwrap();
    let device = store.device_id().unwrap();
    store
        .upsert_intervals(&device, &[open_iv("iv-1", "figma", Active, at(0), at(5))])
        .unwrap();
    // journal_mode=WAL is persistent: every connection to the file reports it.
    let mode: String = raw(&path)
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    let mut wal = path.into_os_string();
    wal.push("-wal");
    assert!(
        PathBuf::from(wal).exists(),
        "writes go through the WAL file"
    );
}

// ---- tracking invariants ------------------------------------------------------------------

#[test]
fn at_most_one_open_interval_per_device_is_enforced_by_the_database() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    let first = open_iv("iv-a", "figma", Active, at(0), at(15));
    store
        .upsert_intervals(&device, slice::from_ref(&first))
        .unwrap();

    let second = open_iv("iv-b", "blender", Active, at(15), at(20));
    let err = store
        .upsert_intervals(&device, slice::from_ref(&second))
        .unwrap_err();
    assert!(
        is_constraint_violation(&err),
        "unique partial index: {err:?}"
    );

    // The whole batch is rolled back, including rows that would be valid on their own.
    let unrelated = closed_iv(
        "iv-z",
        "figma",
        Active,
        at(-60),
        at(-50),
        EndReason::AppSwitch,
    );
    assert!(store
        .upsert_intervals(&device, &[unrelated, second.clone()])
        .is_err());
    let rows = store.list_all_events().unwrap();
    assert_eq!(
        rows,
        [record_from_interval(&first, &device)],
        "the first is intact"
    );

    // Another device may have its own open interval.
    store.upsert_intervals("other-device", &[second]).unwrap();

    // "Close A, open B" in one batch works whatever order the caller lists them in.
    let third = open_iv("iv-c", "blender", Active, at(15), at(16));
    let first_closed = close(&first, at(15), EndReason::AppSwitch);
    store
        .upsert_intervals(&device, &[third, first_closed])
        .unwrap();
    let rows = store.list_all_events().unwrap();
    assert_eq!(ids(&rows), ["iv-a", "iv-b", "iv-c"]);
    assert_eq!(rows[0].state, "closed");
    assert_eq!(rows[0].end_reason, Some(EndReason::AppSwitch));
    assert_eq!(rows[0].revision, 2);
    assert_eq!(rows[2].state, "open");
}

#[test]
fn upserting_the_same_closed_interval_twice_is_idempotent() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    let interval = closed_iv("iv-1", "figma", Active, at(0), at(90), EndReason::AppSwitch);
    store
        .upsert_intervals(&device, slice::from_ref(&interval))
        .unwrap();
    store
        .upsert_intervals(&device, slice::from_ref(&interval))
        .unwrap();
    store
        .upsert_intervals(&device, &[interval.clone(), interval.clone()])
        .unwrap();

    let rows = store.list_all_events().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].revision, 1);
    assert_eq!(rows[0], record_from_interval(&interval, &device));
}

#[test]
fn checkpoints_bump_the_revision_and_closed_rows_are_immutable() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    let opened = open_iv("iv-1", "figma", Active, at(0), at(15));
    store
        .upsert_intervals(&device, slice::from_ref(&opened))
        .unwrap();
    assert_eq!(store.list_all_events().unwrap()[0].revision, 1);

    let checkpoint = Interval {
        ended_at_ms: at(30),
        ..opened.clone()
    };
    store
        .upsert_intervals(&device, slice::from_ref(&checkpoint))
        .unwrap();
    let row = &store.list_all_events().unwrap()[0];
    assert_eq!(row.revision, 2);
    assert_eq!(row.ended_at_ms, at(30));
    assert_eq!(row.duration_seconds, 30.0);
    assert_eq!(row.state, "open");

    let closed = close(&checkpoint, at(40), EndReason::AppSwitch);
    store
        .upsert_intervals(&device, slice::from_ref(&closed))
        .unwrap();
    let after_close = store.list_all_events().unwrap();
    assert_eq!(after_close.len(), 1);
    assert_eq!(after_close[0].revision, 3);
    assert_eq!(after_close[0].state, "closed");
    assert_eq!(after_close[0].end_reason, Some(EndReason::AppSwitch));
    assert_eq!(after_close[0].ended_at_ms, at(40));

    // Replays: the same closed interval, older open snapshots, a different closing.
    let other_closing = close(&checkpoint, at(35), EndReason::TimeGap);
    let replays = [closed, opened, checkpoint, other_closing];
    for replay in replays.clone() {
        store.upsert_intervals(&device, &[replay]).unwrap();
    }
    assert_eq!(
        store.list_all_events().unwrap(),
        after_close,
        "nothing changed"
    );

    // Still no-ops (not constraint errors) while the device has another interval open: the
    // id conflict is resolved before the one-open-per-device index is consulted.
    let next = open_iv("iv-2", "blender", Active, at(40), at(45));
    store
        .upsert_intervals(&device, slice::from_ref(&next))
        .unwrap();
    for replay in replays {
        store.upsert_intervals(&device, &[replay]).unwrap();
    }
    let rows = store.list_all_events().unwrap();
    assert_eq!(rows[0], after_close[0]);
    assert_eq!(rows[1], record_from_interval(&next, &device));
}

#[test]
fn an_open_interval_can_be_relabelled_idle_until_it_closes() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    let active = open_iv("iv-1", "blender", Active, at(0), at(15));
    store
        .upsert_intervals(&device, slice::from_ref(&active))
        .unwrap();
    let idle = Interval {
        kind: Idle,
        ended_at_ms: at(20),
        ..active
    };
    store.upsert_intervals(&device, &[idle]).unwrap();
    let row = &store.list_all_events().unwrap()[0];
    assert_eq!(row.kind, Idle);
    assert_eq!(row.active_seconds, 0.0);
    assert_eq!(row.idle_seconds, 20.0);
    assert_eq!(row.duration_seconds, 20.0);
    assert_eq!(row.revision, 2);
}

#[test]
fn inconsistent_intervals_are_rejected_before_anything_is_written() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    let good = closed_iv("iv-ok", "figma", Active, at(0), at(5), EndReason::AppSwitch);
    let backwards = closed_iv(
        "iv-bad",
        "figma",
        Active,
        at(5),
        at(0),
        EndReason::AppSwitch,
    );
    let open_with_reason = Interval {
        end_reason: Some(EndReason::Paused),
        ..open_iv("iv-bad2", "figma", Active, at(0), at(5))
    };
    let closed_without_reason = Interval {
        open: false,
        ..open_iv("iv-bad3", "figma", Active, at(0), at(5))
    };
    let empty_id = open_iv("", "figma", Active, at(0), at(5));
    for bad in [backwards, open_with_reason, closed_without_reason, empty_id] {
        let err = store
            .upsert_intervals(&device, &[good.clone(), bad])
            .unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)), "{err:?}");
    }
    assert!(store.list_all_events().unwrap().is_empty());
    store.upsert_intervals(&device, &[]).unwrap();
}

#[test]
fn check_constraints_reject_inconsistent_rows() {
    let dir = TempDir::new().unwrap();
    let path = db_path(&dir);
    let _store = Store::open(&path).unwrap();
    let conn = raw(&path);
    // (id, kind, start, end, active_ms, idle_ms, state, end_reason)
    type Row<'a> = (
        &'a str,
        &'a str,
        i64,
        i64,
        i64,
        i64,
        &'a str,
        Option<&'a str>,
    );
    let insert = |(id, kind, start, end, active, idle, state, reason): Row<'_>| {
        conn.execute(
            "INSERT INTO tracking_events (id, device_id, application_id, application_name, kind,
                 started_at_ms, ended_at_ms, active_ms, idle_ms, state, end_reason,
                 created_at_ms, updated_at_ms)
             VALUES (?1, 'dev', 'figma', 'Figma', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0)",
            params![id, kind, start, end, active, idle, state, reason],
        )
    };
    let reason = Some("appSwitch");
    let rejected: [Row<'_>; 10] = [
        // active_ms + idle_ms must equal the duration.
        ("a", "active", 0, 10_000, 9_000, 0, "closed", reason),
        ("b", "idle", 0, 10_000, 0, 10_001, "closed", reason),
        // The duration belongs to one side only, according to kind.
        ("c", "active", 0, 10_000, 5_000, 5_000, "closed", reason),
        ("d", "idle", 0, 10_000, 10_000, 0, "closed", reason),
        // Ends before it starts (negative parts).
        ("e", "active", 10_000, 0, -10_000, 0, "closed", reason),
        // end_reason is set exactly when closed, and must be a known reason.
        ("f", "active", 0, 10_000, 10_000, 0, "open", reason),
        ("g", "active", 0, 10_000, 10_000, 0, "closed", None),
        ("h", "active", 0, 10_000, 10_000, 0, "closed", Some("bogus")),
        // Unknown kind / state.
        ("i", "busy", 0, 10_000, 10_000, 0, "closed", reason),
        ("j", "active", 0, 10_000, 10_000, 0, "paused", reason),
    ];
    for row in rejected {
        assert!(insert(row).is_err(), "row {} was accepted", row.0);
    }
    // Control: a consistent row is accepted.
    insert(("ok", "active", 0, 10_000, 10_000, 0, "closed", reason)).unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM tracking_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

// ---- crash recovery -----------------------------------------------------------------------

/// `path` with `suffix` appended to the file name (`-wal`, `-shm`).
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Copy the database file and its WAL as they are on disk right now, while a connection still
/// has them open: the state a power cut leaves behind (committed transactions SQLite has
/// written, no checkpoint, no orderly close). The `-shm` index is not copied; SQLite rebuilds
/// it from the WAL on the next open.
fn snapshot_files(path: &Path, into: &Path) {
    for suffix in ["", "-wal"] {
        // `std::fs::read` opens with full sharing, so SQLite's open handles do not block it.
        let bytes = std::fs::read(sibling(path, suffix)).unwrap();
        std::fs::write(sibling(into, suffix), bytes).unwrap();
    }
}

#[test]
fn local_database_recovery_closes_the_open_interval_at_its_last_checkpoint() {
    let dir = TempDir::new().unwrap();
    let path = db_path(&dir);
    let power_cut = dir.path().join("power-cut.sqlite3");
    let checkpoint_end = at(30);
    let device = {
        let store = Store::open(&path).unwrap();
        let device = store.device_id().unwrap();
        let earlier = closed_iv(
            "iv-0",
            "photoshop",
            Active,
            at(-60),
            at(0),
            EndReason::AppSwitch,
        );
        let mut open = open_iv("iv-1", "figma", Active, at(0), at(15));
        store
            .upsert_intervals(&device, &[earlier, open.clone()])
            .unwrap();
        open.ended_at_ms = checkpoint_end;
        store.upsert_intervals(&device, &[open]).unwrap();
        assert_eq!(store.list_all_events().unwrap()[1].state, "open");

        // Power cut: only the files survive, and the recent commits live only in the WAL.
        assert!(std::fs::metadata(sibling(&path, "-wal")).unwrap().len() > 0);
        snapshot_files(&path, &power_cut);
        // App crash: the Store goes away without the tracker's shutdown write, so the
        // interval is still `open` in the database.
        drop(store);
        device
    };

    for crashed in [&path, &power_cut] {
        assert_recovered_at_checkpoint(crashed, &device, checkpoint_end);
    }
}

/// Reopen a database left behind by a crash and check that recovery closes the open interval
/// at its last checkpoint, exactly once.
fn assert_recovered_at_checkpoint(path: &Path, device: &str, checkpoint_end: i64) {
    let store = Store::open(path).unwrap();
    assert_eq!(store.device_id().unwrap(), device);
    let report = store.recover_open_intervals(2 * SEC).unwrap();
    assert_eq!(
        report,
        RecoveryReport {
            closed: 1,
            discarded: 0
        }
    );

    let rows = store.list_all_events().unwrap();
    assert_eq!(ids(&rows), ["iv-0", "iv-1"], "no duplicates");
    let recovered = &rows[1];
    assert_eq!(recovered.state, "closed");
    assert_eq!(recovered.end_reason, Some(EndReason::Recovered));
    assert_eq!(
        recovered.ended_at_ms, checkpoint_end,
        "never beyond the last checkpoint"
    );
    assert_eq!(recovered.duration_seconds, 30.0);
    assert_eq!(recovered.revision, 3);
    assert_eq!(
        rows[0].end_reason,
        Some(EndReason::AppSwitch),
        "closed rows untouched"
    );
    assert_eq!(rows[0].revision, 1);
    assert_eq!(store.high_water_ms(device).unwrap(), Some(checkpoint_end));

    // Recovery is idempotent, and a late replay of the open snapshot cannot reopen the row.
    assert_eq!(
        store.recover_open_intervals(2 * SEC).unwrap(),
        RecoveryReport::default()
    );
    let late = open_iv("iv-1", "figma", Active, at(0), at(99));
    store.upsert_intervals(device, &[late]).unwrap();
    assert_eq!(store.list_all_events().unwrap(), rows);

    // Tracking resumes with a new open interval after the high-water mark.
    let resumed = open_iv(
        "iv-2",
        "figma",
        Active,
        checkpoint_end + SEC,
        checkpoint_end + 5 * SEC,
    );
    store.upsert_intervals(device, &[resumed]).unwrap();
    assert_eq!(store.list_all_events().unwrap().len(), 3);
}

#[test]
fn recovery_discards_open_rows_shorter_than_the_minimum() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    let short_closed = closed_iv(
        "iv-closed",
        "figma",
        Active,
        at(-9),
        at(-8),
        EndReason::Paused,
    );
    let short_open = open_iv("iv-short", "figma", Active, at(0), at(0) + 1_999);
    store
        .upsert_intervals(&device, &[short_closed, short_open])
        .unwrap();
    let report = store.recover_open_intervals(2 * SEC).unwrap();
    assert_eq!(
        report,
        RecoveryReport {
            closed: 0,
            discarded: 1
        }
    );
    assert_eq!(ids(&store.list_all_events().unwrap()), ["iv-closed"]);

    // Exactly the minimum is kept.
    let exact = open_iv("iv-exact", "figma", Idle, at(0), at(2));
    store.upsert_intervals(&device, &[exact]).unwrap();
    let report = store.recover_open_intervals(2 * SEC).unwrap();
    assert_eq!(
        report,
        RecoveryReport {
            closed: 1,
            discarded: 0
        }
    );
    let rows = store.list_all_events().unwrap();
    assert_eq!(ids(&rows), ["iv-closed", "iv-exact"]);
    assert_eq!(rows[1].end_reason, Some(EndReason::Recovered));
}

#[test]
fn discard_open_intervals_never_deletes_closed_rows() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    let closed = closed_iv(
        "iv-closed",
        "figma",
        Active,
        at(0),
        at(1),
        EndReason::AppSwitch,
    );
    let open = open_iv("iv-open", "figma", Active, at(1), at(3));
    store.upsert_intervals(&device, &[closed, open]).unwrap();

    let to_discard = ["iv-closed", "iv-open", "iv-unknown"].map(str::to_owned);
    assert_eq!(store.discard_open_intervals(&to_discard).unwrap(), 1);
    assert_eq!(ids(&store.list_all_events().unwrap()), ["iv-closed"]);
    assert_eq!(store.discard_open_intervals(&to_discard).unwrap(), 0);
    assert_eq!(store.discard_open_intervals(&[]).unwrap(), 0);
}

#[test]
fn high_water_is_the_latest_end_on_this_device() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    assert_eq!(store.high_water_ms(&device).unwrap(), None);
    let mine = [
        closed_iv(
            "iv-1",
            "figma",
            Active,
            at(0),
            at(10),
            EndReason::BecameIdle,
        ),
        open_iv("iv-2", "figma", Idle, at(10), at(12)),
    ];
    store.upsert_intervals(&device, &mine).unwrap();
    let theirs = closed_iv("iv-x", "figma", Active, at(0), at(99), EndReason::AppSwitch);
    store.upsert_intervals("other-device", &[theirs]).unwrap();
    assert_eq!(store.high_water_ms(&device).unwrap(), Some(at(12)));
}

// ---- queries and deletion -----------------------------------------------------------------

/// `iv-a` closed [0 s, 10 s), `iv-b` closed idle [10 s, 20 s), `iv-c` open [20 s, 25 s).
fn three_intervals(store: &Store, device: &str) {
    let intervals = [
        closed_iv(
            "iv-a",
            "figma",
            Active,
            at(0),
            at(10),
            EndReason::BecameIdle,
        ),
        closed_iv(
            "iv-b",
            "figma",
            Idle,
            at(10),
            at(20),
            EndReason::InputResumed,
        ),
        open_iv("iv-c", "figma", Active, at(20), at(25)),
    ];
    store.upsert_intervals(device, &intervals).unwrap();
}

#[test]
fn list_events_returns_overlapping_intervals_only() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    three_intervals(&store, &device);
    let list = |from: i64, to: i64| -> Vec<String> {
        let records = store.list_events(from, to).unwrap();
        records.into_iter().map(|r| r.id).collect()
    };
    let none: Vec<String> = Vec::new();

    // Touching endpoints are excluded on both sides.
    assert_eq!(list(at(10), at(20)), ["iv-b"]);
    assert_eq!(list(at(10) - 1, at(20) + 1), ["iv-a", "iv-b", "iv-c"]);
    // The open interval is included, also when the range lies inside it.
    assert_eq!(list(at(22), at(23)), ["iv-c"]);
    assert_eq!(list(at(25), at(60)), none);
    assert_eq!(list(at(-60), at(0)), none);
    // Empty and inverted ranges overlap nothing.
    assert_eq!(list(at(5), at(5)), none);
    assert_eq!(list(at(20), at(0)), none);

    // Ordered by start, then id.
    let same_start = [
        closed_iv(
            "iv-0b",
            "blender",
            Active,
            at(0),
            at(1),
            EndReason::AppSwitch,
        ),
        closed_iv(
            "iv-0a",
            "blender",
            Active,
            at(0),
            at(1),
            EndReason::AppSwitch,
        ),
    ];
    store.upsert_intervals("other-device", &same_start).unwrap();
    assert_eq!(list(at(0), at(1)), ["iv-0a", "iv-0b", "iv-a"]);
    assert_eq!(
        ids(&store.list_all_events().unwrap()),
        ["iv-0a", "iv-0b", "iv-a", "iv-b", "iv-c"]
    );
}

#[test]
fn delete_events_before_keeps_open_and_newer_rows_and_none_removes_everything() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    three_intervals(&store, &device);

    // Inclusive: iv-a ended exactly at the cutoff.
    assert_eq!(store.delete_events(Some(at(10))).unwrap(), 1);
    assert_eq!(ids(&store.list_all_events().unwrap()), ["iv-b", "iv-c"]);
    // The open interval survives even when it ended before the cutoff.
    assert_eq!(store.delete_events(Some(at(99))).unwrap(), 1);
    assert_eq!(ids(&store.list_all_events().unwrap()), ["iv-c"]);

    three_intervals(&store, &device); // iv-c is still open, so this is a plain checkpoint
    assert_eq!(store.delete_events(None).unwrap(), 3);
    assert!(store.list_all_events().unwrap().is_empty());
    assert_eq!(store.high_water_ms(&device).unwrap(), None);
    let summary = store.data_summary().unwrap();
    assert_eq!(summary.event_count, 0);
    assert_eq!(summary.oldest_event_at, None);
    assert_eq!(summary.newest_event_at, None);
    assert_eq!(store.delete_events(None).unwrap(), 0);
}

// ---- settings -----------------------------------------------------------------------------

#[test]
fn settings_round_trip_and_default_when_absent() {
    let dir = TempDir::new().unwrap();
    let path = db_path(&dir);
    let mut settings = Settings::default();
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(store.load_settings().unwrap(), Settings::default());
        settings.general.theme = ThemePreference::Light;
        settings.tracking.idle_timeout_minutes = 12;
        settings.tracking.checkpoint_seconds = 30;
        settings.onboarding.completed = true;
        settings.onboarding.completed_at = Some(iso_from_ms(T0));
        store.save_settings(&settings).unwrap();
        assert_eq!(store.load_settings().unwrap(), settings);

        let mut invalid = settings.clone();
        invalid.tracking.checkpoint_seconds = 1;
        let err = store.save_settings(&invalid).unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)), "{err:?}");
        assert_eq!(
            store.load_settings().unwrap(),
            settings,
            "nothing was written"
        );
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.load_settings().unwrap(),
        settings,
        "persisted across restarts"
    );
}

#[test]
fn corrupt_stored_settings_fall_back_to_defaults_without_crashing() {
    let dir = TempDir::new().unwrap();
    let path = db_path(&dir);
    let store = Store::open(&path).unwrap();
    let conn = raw(&path);
    let put = |json: &str| {
        conn.execute(
            "INSERT OR REPLACE INTO preferences (key, value_json, updated_at_ms)
             VALUES ('settings', ?1, 0)",
            params![json],
        )
        .unwrap();
    };
    let stored = || -> String {
        conn.query_row(
            "SELECT value_json FROM preferences WHERE key = 'settings'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };

    for corrupt in [
        r#"{"tracking":{"idleTimeoutMinutes":"ten"}}"#, // wrong type
        r#"{"tracking":{"idleTimeoutMinutes":0}}"#,     // out of range
        r#"{"general":{"theme":"neon"}}"#,              // unknown enum value
        r#"[1,2,3]"#,                                   // not an object
        r#"null"#,
    ] {
        put(corrupt);
        assert_eq!(
            store.load_settings().unwrap(),
            Settings::default(),
            "{corrupt}"
        );
        assert_eq!(stored(), corrupt, "not overwritten until the next save");
    }

    // Not JSON at all (the CHECK constraint is bypassed to simulate on-disk corruption).
    conn.execute_batch("PRAGMA ignore_check_constraints = ON")
        .unwrap();
    put("{definitely not json");
    conn.execute_batch("PRAGMA ignore_check_constraints = OFF")
        .unwrap();
    assert_eq!(store.load_settings().unwrap(), Settings::default());

    // Lenient: unknown fields are ignored and missing fields take defaults.
    put(r#"{"tracking":{"idleTimeoutMinutes":9},"futureField":{"x":1}}"#);
    let loaded = store.load_settings().unwrap();
    assert_eq!(loaded.tracking.idle_timeout_minutes, 9);
    assert_eq!(loaded.general, Settings::default().general);

    // The next save replaces the corrupt document.
    store.save_settings(&Settings::default()).unwrap();
    let saved: Settings = serde_json::from_str(&stored()).unwrap();
    assert_eq!(saved, Settings::default());
}

// ---- applications -------------------------------------------------------------------------

#[test]
fn seeding_inserts_every_default_once_and_never_overwrites_user_edits() {
    let defaults = defaults();
    assert!(defaults.len() > 5, "the embedded registry is not empty");
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.seed_applications(&defaults).unwrap(), defaults.len());

    let apps = store.list_applications().unwrap();
    assert_eq!(apps.len(), defaults.len());
    for (index, default) in defaults.iter().enumerate() {
        let app = find(&apps, &default.id);
        assert_eq!(app.display_name, default.display_name);
        assert_eq!(app.category, default.category);
        assert_eq!(app.matchers, default.matchers);
        assert_eq!(app.enabled, default.enabled_by_default);
        assert!(app.include_in_reports);
        assert!(app.built_in);
        assert_eq!(app.sort_order, i64::try_from(index).unwrap() * 10);
        assert_eq!(app.created_at.len(), 24);
        assert!(app.created_at.ends_with('Z'));
    }
    let listed: Vec<&str> = apps.iter().map(|a| a.id.as_str()).collect();
    let expected: Vec<&str> = defaults.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(listed, expected, "ordered by sort_order");

    assert_eq!(
        store.seed_applications(&defaults).unwrap(),
        0,
        "re-seed inserts nothing"
    );

    // A user edit survives re-seeding.
    let first = &defaults[0];
    let mut edit = input(Some(&first.id), "My renamed app", "Renamed.exe");
    edit.enabled = !first.enabled_by_default;
    edit.include_in_reports = false;
    store.save_application_with(&edit, validate).unwrap();
    assert_eq!(store.seed_applications(&defaults).unwrap(), 0);
    let edited = find(&store.list_applications().unwrap(), &first.id).clone();
    assert_eq!(edited.display_name, "My renamed app");
    assert_eq!(edited.enabled, !first.enabled_by_default);
    assert!(!edited.include_in_reports);

    // A built-in added by a later release is inserted; edits stay.
    let mut upgraded = defaults.clone();
    upgraded.push(DefaultApplication {
        id: "new-tool".to_owned(),
        display_name: "New Tool".to_owned(),
        category: AppCategory::ThreeD,
        enabled_by_default: false,
        matchers: vec![ProcessMatcher {
            exe: "NewTool.exe".to_owned(),
            path_includes: Some("Vendor".to_owned()),
        }],
    });
    assert_eq!(store.seed_applications(&upgraded).unwrap(), 1);
    let apps = store.list_applications().unwrap();
    assert_eq!(apps.len(), defaults.len() + 1);
    let added = find(&apps, "new-tool");
    assert!(added.built_in);
    assert!(!added.enabled);
    assert_eq!(
        added.sort_order,
        i64::try_from(defaults.len()).unwrap() * 10
    );
    assert_eq!(added.matchers[0].path_includes.as_deref(), Some("Vendor"));
    assert_eq!(find(&apps, &first.id), &edited);
}

#[test]
fn custom_applications_are_created_updated_and_deleted() {
    let store = seeded_memory_store();
    let before = store.list_applications().unwrap();
    let max_sort = before.iter().map(|a| a.sort_order).max().unwrap();

    let created = store
        .save_application_with(&input(None, "  My Tool, Pro  ", "mytool*.exe"), validate)
        .unwrap();
    let suffix = created.id.strip_prefix("custom-").expect("custom- prefix");
    assert_eq!(suffix.len(), 8);
    assert!(
        suffix.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
        "{}",
        created.id
    );
    assert!(!created.built_in);
    assert_eq!(created.display_name, "My Tool, Pro", "trimmed");
    assert_eq!(created.sort_order, max_sort + 10);
    assert_eq!(store.list_applications().unwrap().last(), Some(&created));

    let second = store
        .save_application_with(&input(None, "Another", "another.exe"), validate)
        .unwrap();
    assert_ne!(second.id, created.id);
    assert_eq!(second.sort_order, max_sort + 20);

    // Updating a custom application keeps it custom, with the same id and position.
    let mut change = input(Some(&created.id), "My Tool", "mytool.exe");
    change.category = AppCategory::Code;
    change.enabled = false;
    let updated = store.save_application_with(&change, validate).unwrap();
    assert_eq!(updated.id, created.id);
    assert!(!updated.built_in);
    assert_eq!(updated.category, AppCategory::Code);
    assert!(!updated.enabled);
    assert_eq!(updated.sort_order, created.sort_order);
    assert_eq!(updated.created_at, created.created_at);

    // Tracking history outlives the application (it carries a name snapshot).
    let device = store.device_id().unwrap();
    let mut history = closed_iv(
        "iv-1",
        &created.id,
        Active,
        at(0),
        at(60),
        EndReason::AppSwitch,
    );
    history.application_name = "My Tool".to_owned();
    store.upsert_intervals(&device, &[history]).unwrap();

    store.delete_application(&created.id).unwrap();
    let after = store.list_applications().unwrap();
    assert!(after.iter().all(|a| a.id != created.id));
    assert_eq!(after.len(), before.len() + 1);
    let err = store.delete_application(&created.id).unwrap_err();
    assert!(matches!(err, StoreError::NotFound(_)), "{err:?}");
    let events = store.list_all_events().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].application_name, "My Tool");
}

#[test]
fn built_ins_can_be_edited_but_not_deleted() {
    let store = seeded_memory_store();
    let original = store.list_applications().unwrap()[0].clone();

    let mut change = input(Some(&original.id), "Renamed built-in", "Other.exe");
    change.include_in_reports = false;
    let updated = store.save_application_with(&change, validate).unwrap();
    assert!(updated.built_in, "built_in is unchanged by an update");
    assert_eq!(updated.sort_order, original.sort_order);
    assert_eq!(updated.created_at, original.created_at);
    assert_eq!(updated.display_name, "Renamed built-in");
    assert!(!updated.include_in_reports);

    match store.delete_application(&original.id) {
        Err(StoreError::Invalid(message)) => {
            assert_eq!(
                message,
                "built-in applications can be disabled but not deleted"
            );
        }
        other => panic!("expected Invalid, got {other:?}"),
    }
    let apps = store.list_applications().unwrap();
    assert!(apps.iter().any(|a| a.id == original.id));
}

#[test]
fn unknown_ids_and_invalid_input_are_rejected_without_writing() {
    let store = seeded_memory_store();
    let before = store.list_applications().unwrap();

    let ghost = input(Some("no-such-app"), "Ghost", "ghost.exe");
    let err = store.save_application_with(&ghost, validate).unwrap_err();
    assert!(matches!(err, StoreError::NotFound(_)), "{err:?}");

    let no_matchers = ApplicationInput {
        matchers: Vec::new(),
        ..input(None, "No matchers", "x.exe")
    };
    for bad in [
        input(None, "   ", "x.exe"),
        input(None, &"x".repeat(81), "x.exe"),
        no_matchers,
        input(Some("Bad Id"), "Bad id", "x.exe"),
    ] {
        let err = store.save_application_with(&bad, validate).unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)), "{err:?}");
    }
    // The validator's message is passed through for the UI.
    let fine = input(None, "Fine", "x.exe");
    let err = store
        .save_application_with(&fine, |_| Err("rejected: reason".to_owned()))
        .unwrap_err();
    assert_eq!(err.to_string(), "rejected: reason");

    let err = store.delete_application("no-such-app").unwrap_err();
    assert!(matches!(err, StoreError::NotFound(_)), "{err:?}");
    assert_eq!(store.list_applications().unwrap(), before);
}

#[test]
fn reset_restores_built_ins_and_optionally_removes_custom_applications() {
    let defaults = defaults();
    let store = Store::open_in_memory().unwrap();
    // An older release knew one built-in fewer.
    let (latest, older) = defaults.split_last().unwrap();
    store.seed_applications(older).unwrap();

    let first = &defaults[0];
    let mut change = input(Some(&first.id), "Renamed", "Renamed.exe");
    change.enabled = !first.enabled_by_default;
    change.include_in_reports = false;
    store.save_application_with(&change, validate).unwrap();
    let custom = store
        .save_application_with(&input(None, "Custom", "custom.exe"), validate)
        .unwrap();

    let apps = store.reset_applications_to(&defaults, false).unwrap();
    assert_eq!(
        apps,
        store.list_applications().unwrap(),
        "returns the new list"
    );
    assert_eq!(apps.len(), defaults.len() + 1);
    for (index, default) in defaults.iter().enumerate() {
        let app = find(&apps, &default.id);
        assert_eq!(app.display_name, default.display_name);
        assert_eq!(app.category, default.category);
        assert_eq!(app.matchers, default.matchers);
        assert_eq!(app.enabled, default.enabled_by_default);
        assert!(app.include_in_reports);
        assert!(app.built_in);
        assert_eq!(app.sort_order, i64::try_from(index).unwrap() * 10);
    }
    assert!(
        apps.iter().any(|a| a.id == latest.id),
        "missing built-in inserted"
    );
    assert_eq!(find(&apps, &custom.id), &custom, "custom kept");

    let apps = store.reset_applications_to(&defaults, true).unwrap();
    assert_eq!(apps.len(), defaults.len());
    assert!(apps.iter().all(|a| a.built_in));
}

#[test]
fn set_enabled_applications_enables_exactly_the_given_ids() {
    let store = seeded_memory_store();
    let custom = store
        .save_application_with(&input(None, "Custom", "custom.exe"), validate)
        .unwrap();
    let apps = store.list_applications().unwrap();
    let chosen = [apps[1].id.clone(), custom.id.clone()];

    store.set_enabled_applications(&chosen).unwrap();
    let apps = store.list_applications().unwrap();
    for app in &apps {
        assert_eq!(app.enabled, chosen.contains(&app.id), "{}", app.id);
    }

    let unknown = [apps[0].id.clone(), "no-such-app".to_owned()];
    let err = store.set_enabled_applications(&unknown).unwrap_err();
    assert!(matches!(err, StoreError::Invalid(_)), "{err:?}");
    assert_eq!(store.list_applications().unwrap(), apps, "nothing changed");

    store.set_enabled_applications(&[]).unwrap();
    assert!(store
        .list_applications()
        .unwrap()
        .iter()
        .all(|a| !a.enabled));
}

// ---- outbox, summary and exports ----------------------------------------------------------

#[test]
fn closed_rows_form_the_offline_outbox() {
    let dir = TempDir::new().unwrap();
    let path = db_path(&dir);
    let store = Store::open(&path).unwrap();
    store.seed_applications(&defaults()).unwrap();
    let device = store.device_id().unwrap();
    let intervals = [
        closed_iv(
            "iv-1",
            "figma",
            Active,
            at(0),
            at(10),
            EndReason::BecameIdle,
        ),
        closed_iv(
            "iv-2",
            "figma",
            Idle,
            at(10),
            at(20),
            EndReason::InputResumed,
        ),
        closed_iv(
            "iv-3",
            "blender",
            Active,
            at(20),
            at(30),
            EndReason::AppSwitch,
        ),
        open_iv("iv-4", "figma", Active, at(30), at(45)),
    ];
    store.upsert_intervals(&device, &intervals).unwrap();
    // Simulate a later sync of one row.
    raw(&path)
        .execute(
            "UPDATE tracking_events SET sync_status = 'synced' WHERE id = 'iv-3'",
            [],
        )
        .unwrap();

    let rows = store.list_all_events().unwrap();
    for row in &rows {
        assert_eq!(row.source, "automatic");
        assert_eq!(row.user_id, None, "no user until Phase-2 sign-in");
        assert_eq!(row.device_id, device);
        assert_eq!(row.project_id, None);
        assert_eq!(row.task_id, None);
    }
    let pending: Vec<&str> = rows
        .iter()
        .filter(|r| r.sync_status == "pending")
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(pending, ["iv-1", "iv-2", "iv-4"]);

    let summary = store.data_summary().unwrap();
    assert_eq!(summary.device_id, device);
    assert_eq!(summary.event_count, 4);
    assert_eq!(summary.open_event_count, 1);
    assert_eq!(summary.pending_sync_count, 2, "closed and pending only");
    assert_eq!(
        summary.application_count,
        i64::try_from(defaults().len()).unwrap()
    );
    assert_eq!(
        summary.oldest_event_at.as_deref(),
        Some("2026-10-13T09:15:00.000Z")
    );
    assert_eq!(
        summary.newest_event_at.as_deref(),
        Some("2026-10-13T09:15:45.000Z")
    );
    assert_eq!(summary.database_path, path.display().to_string());
    assert_eq!(summary.stored_fields, STORED_TRACKING_FIELDS);

    let json = serde_json::to_value(&summary).unwrap();
    assert_eq!(json["pendingSyncCount"], 2);
    assert_eq!(json["openEventCount"], 1);

    let memory = Store::open_in_memory().unwrap();
    let summary = memory.data_summary().unwrap();
    assert_eq!(summary.database_path, ":memory:");
    assert_eq!(summary.event_count, 0);
    assert_eq!(summary.pending_sync_count, 0);
    assert_eq!(summary.device_id, memory.device_id().unwrap());
}

#[test]
fn stored_records_match_the_live_overlay_and_serialize_in_camel_case() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    let idle = closed_iv(
        "iv-1",
        "figma",
        Idle,
        at(0),
        at(0) + 1_500,
        EndReason::InputResumed,
    );
    let open = open_iv("iv-2", "figma", Active, at(0) + 1_500, at(61) + 501);
    store
        .upsert_intervals(&device, &[idle.clone(), open.clone()])
        .unwrap();
    let rows = store.list_all_events().unwrap();
    assert_eq!(rows[0], record_from_interval(&idle, &device));
    assert_eq!(rows[1], record_from_interval(&open, &device));

    let record = &rows[0];
    assert_eq!(record.started_at, "2026-10-13T09:15:00.000Z");
    assert_eq!(record.ended_at, "2026-10-13T09:15:01.500Z");
    assert_eq!(record.duration_seconds, 1.5);
    assert_eq!(record.idle_seconds, 1.5);
    assert_eq!(record.active_seconds, 0.0);
    assert_eq!(rows[1].duration_seconds, 60.001);
    assert_eq!(rows[1].state, "open");
    assert_eq!(rows[1].end_reason, None);

    let json = serde_json::to_value(record).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "activeSeconds",
            "applicationId",
            "applicationName",
            "deviceId",
            "durationSeconds",
            "endReason",
            "endedAt",
            "id",
            "idleSeconds",
            "kind",
            "projectId",
            "revision",
            "source",
            "startedAt",
            "state",
            "syncStatus",
            "taskId",
            "userId",
        ],
        "the TrackingEvent shape, without the internal *_ms fields"
    );
    assert_eq!(json["kind"], "idle");
    assert_eq!(json["endReason"], "inputResumed");
    assert_eq!(json["userId"], serde_json::Value::Null);
    assert_eq!(json["syncStatus"], "pending");
}

#[test]
fn csv_export_quotes_names_with_commas_quotes_and_newlines() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    let names = [
        "Plain",
        "Studio, Inc",
        "Say \"hi\"",
        "Line\nBreak",
        "Car\r\nReturn",
    ];
    let intervals: Vec<Interval> = (0..)
        .zip(names)
        .map(|(i, name)| Interval {
            application_name: name.to_owned(),
            ..closed_iv(
                &format!("iv-{i}"),
                "custom-0000beef",
                Active,
                at(i * 10),
                at(i * 10 + 10),
                EndReason::AppSwitch,
            )
        })
        .collect();
    store.upsert_intervals(&device, &intervals).unwrap();
    let csv = export_csv(&store.list_all_events().unwrap());

    let rows = parse_csv(&csv);
    assert_eq!(
        rows[0],
        [
            "id",
            "device_id",
            "application_id",
            "application_name",
            "kind",
            "started_at",
            "ended_at",
            "duration_seconds",
            "active_seconds",
            "idle_seconds",
            "state",
            "end_reason",
            "project_id",
            "task_id",
            "source",
            "sync_status",
        ]
    );
    assert_eq!(rows.len(), names.len() + 1);
    for (row, name) in rows[1..].iter().zip(names) {
        assert_eq!(row.len(), 16);
        assert_eq!(row[3], name, "round-trips exactly");
    }
    assert_eq!(
        rows[1],
        [
            "iv-0",
            device.as_str(),
            "custom-0000beef",
            "Plain",
            "active",
            "2026-10-13T09:15:00.000Z",
            "2026-10-13T09:15:10.000Z",
            "10.000",
            "10.000",
            "0.000",
            "closed",
            "appSwitch",
            "",
            "",
            "automatic",
            "pending",
        ]
    );
    // Literal encoding of the tricky fields.
    assert!(csv.contains(",\"Studio, Inc\","));
    assert!(csv.contains(",\"Say \"\"hi\"\"\","));
    assert!(csv.contains(",\"Line\nBreak\","));
    assert!(csv.contains(",\"Car\r\nReturn\","));
    assert!(csv.contains(",Plain,"), "plain fields are not quoted");
}

#[test]
fn json_export_has_the_documented_shape() {
    let store = Store::open_in_memory().unwrap();
    let device = store.device_id().unwrap();
    three_intervals(&store, &device);
    let records = store.list_all_events().unwrap();
    let text = export_json(&records, &device, at(3_600));
    assert!(
        text.starts_with("{\n  \"exportedAt\""),
        "pretty-printed, documented order"
    );

    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["deviceId", "events", "exportedAt", "format"]);
    assert_eq!(json["format"], EXPORT_FORMAT);
    assert_eq!(json["format"], "studio-pulse.tracking.v1");
    assert_eq!(json["deviceId"], device.as_str());
    assert_eq!(json["exportedAt"], "2026-10-13T10:15:00.000Z");

    let events = json["events"].as_array().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["id"], "iv-a");
    assert_eq!(events[0]["startedAt"], "2026-10-13T09:15:00.000Z");
    assert_eq!(events[0]["durationSeconds"], 10.0);
    assert_eq!(events[1]["kind"], "idle");
    assert_eq!(events[1]["idleSeconds"], 10.0);
    assert_eq!(events[2]["state"], "open");
    assert_eq!(events[2]["endReason"], serde_json::Value::Null);
    assert!(
        events[0].get("startedAtMs").is_none(),
        "internal fields are not exported"
    );
    assert_eq!(events[0], serde_json::to_value(&records[0]).unwrap());

    let empty: serde_json::Value = serde_json::from_str(&export_json(&[], &device, T0)).unwrap();
    assert_eq!(empty["events"], serde_json::json!([]));
}

#[test]
fn iso_timestamps_are_utc_with_milliseconds_and_safe_for_any_input() {
    assert_eq!(iso_from_ms(T0), "2026-10-13T09:15:00.000Z");
    assert_eq!(iso_from_ms(T0 + 123), "2026-10-13T09:15:00.123Z");
    assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
    // Pre-1970 instants format exactly.
    assert_eq!(iso_from_ms(-1), "1969-12-31T23:59:59.999Z");
    assert_eq!(iso_from_ms(-86_400_000), "1969-12-31T00:00:00.000Z");
    // Instants no clock can produce are clamped to four-digit years instead of panicking.
    assert_eq!(iso_from_ms(i64::MIN), "0000-01-01T00:00:00.000Z");
    assert_eq!(iso_from_ms(i64::MAX), "9999-12-31T23:59:59.999Z");
    for ms in [i64::MIN, -1, 0, T0, i64::MAX] {
        assert_eq!(iso_from_ms(ms).len(), 24);
    }
}
