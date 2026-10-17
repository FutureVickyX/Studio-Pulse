//! The Phase 2A local outbox: [`Store`] as [`SyncLedger`], account stamping on insert, and the
//! proof that migration 0002 upgrades a Phase 1 database in place without losing or changing
//! any history.
//!
//! The sync bookkeeping columns (`workspace_id`, `synced_at_ms`, `sync_attempts`,
//! `last_sync_error`) are not part of the public record type, so these tests read them through a
//! second, raw connection to a file-backed database.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{params, Connection, TransactionBehavior};
use studio_pulse_lib::cloud::ledger::{OutboxCounts, PendingEntry, SyncLedger};
use studio_pulse_lib::settings::Settings;
use studio_pulse_lib::store::{
    PauseRecord, RecoveryReport, Store, StoreError, MIGRATIONS, STORED_TRACKING_FIELDS,
};
use studio_pulse_lib::tracker::IntervalKind::{Active, Idle};
use studio_pulse_lib::tracker::{EndReason, Interval, IntervalKind};
use tempfile::TempDir;

/// 2026-10-13T09:15:00.000Z.
const T0: i64 = 1_791_882_900_000;
const SEC: i64 = 1_000;

const USER_1: &str = "6f1c0e52-2b4f-4c55-9d3a-2f0e7f1b9a01";
const USER_2: &str = "0b7d7a3e-91a4-4f0e-a3b1-6c2d9e8f4b02";
const WORKSPACE: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
/// Another installation's rows (a second open interval needs a second device).
const OTHER_DEVICE: &str = "laptop-2";

// ---- helpers ------------------------------------------------------------------------------

/// `T0` plus whole seconds.
fn at(seconds: i64) -> i64 {
    T0 + seconds * SEC
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

/// A closed active `figma` interval `[start s, end s)`.
fn done(id: &str, start: i64, end: i64) -> Interval {
    closed_iv(
        id,
        "figma",
        Active,
        at(start),
        at(end),
        EndReason::AppSwitch,
    )
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

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| (*id).to_owned()).collect()
}

fn rejection(id: &str, reason: &str) -> (String, String) {
    (id.to_owned(), reason.to_owned())
}

/// A second, raw connection to the same file (for checks the public API does not expose).
fn raw(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    conn
}

/// Every row of `sql`, every column as a dynamically typed value.
fn dump(conn: &Connection, sql: &str) -> Vec<Vec<Value>> {
    let mut stmt = conn.prepare(sql).unwrap();
    let width = stmt.column_count();
    let rows = stmt
        .query_map([], |row| {
            (0..width)
                .map(|i| row.get::<_, Value>(i))
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    rows
}

fn text(value: &str) -> Value {
    Value::Text(value.to_owned())
}

fn user_version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn tracking_columns(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info('tracking_events') ORDER BY cid")
        .unwrap();
    let columns = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    columns
}

/// The sync-relevant state of one `tracking_events` row.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SyncRow {
    user_id: Option<String>,
    state: String,
    sync_status: String,
    workspace_id: Option<String>,
    synced_at_ms: Option<i64>,
    sync_attempts: i64,
    last_sync_error: Option<String>,
    revision: i64,
    updated_at_ms: i64,
}

fn sync_row(conn: &Connection, id: &str) -> SyncRow {
    conn.query_row(
        "SELECT user_id, state, sync_status, workspace_id, synced_at_ms, sync_attempts,
                last_sync_error, revision, updated_at_ms
         FROM tracking_events WHERE id = ?1",
        params![id],
        |r| {
            Ok(SyncRow {
                user_id: r.get(0)?,
                state: r.get(1)?,
                sync_status: r.get(2)?,
                workspace_id: r.get(3)?,
                synced_at_ms: r.get(4)?,
                sync_attempts: r.get(5)?,
                last_sync_error: r.get(6)?,
                revision: r.get(7)?,
                updated_at_ms: r.get(8)?,
            })
        },
    )
    .unwrap_or_else(|err| panic!("row {id}: {err}"))
}

/// A file-backed store (so a raw connection can read the sync columns) and its device id.
struct Fixture {
    _dir: TempDir,
    path: PathBuf,
    store: Store,
    device: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("studio-pulse.sqlite3");
        let store = Store::open(&path).unwrap();
        let device = store.device_id().unwrap();
        Self {
            _dir: dir,
            path,
            store,
            device,
        }
    }

    /// Write `intervals` on this device the way the tracker does while `owner` is signed in
    /// (`None` = signed out).
    fn record(&self, owner: Option<&str>, intervals: &[Interval]) {
        self.store.set_account_user(owner).unwrap();
        self.store
            .upsert_intervals(&self.device, intervals)
            .unwrap();
    }

    /// [`Fixture::record`] on [`OTHER_DEVICE`].
    fn record_elsewhere(&self, owner: Option<&str>, intervals: &[Interval]) {
        self.store.set_account_user(owner).unwrap();
        self.store
            .upsert_intervals(OTHER_DEVICE, intervals)
            .unwrap();
    }

    fn row(&self, id: &str) -> SyncRow {
        sync_row(&raw(&self.path), id)
    }

    fn owner(&self, id: &str) -> Option<String> {
        self.row(id).user_id
    }

    fn pending_ids(&self, user: &str) -> Vec<String> {
        self.store
            .pending_entries(user, usize::MAX)
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect()
    }

    fn counts(&self, user: Option<&str>) -> OutboxCounts {
        self.store.outbox_counts(user).unwrap()
    }

    fn revisions(&self) -> Vec<(String, i64)> {
        self.store
            .list_all_events()
            .unwrap()
            .into_iter()
            .map(|r| (r.id, r.revision))
            .collect()
    }
}

fn counts(pending: u64, unclaimed: u64, rejected: u64) -> OutboxCounts {
    OutboxCounts {
        pending,
        unclaimed,
        rejected,
    }
}

// ---- account, workspace and last success (meta) -------------------------------------------

#[test]
fn account_workspace_and_last_success_live_in_meta_and_survive_restarts() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("studio-pulse.sqlite3");
    let device = {
        let store = Store::open(&path).unwrap();
        assert_eq!(store.account_user().unwrap(), None);
        assert_eq!(store.sync_workspace().unwrap(), None);
        assert_eq!(store.last_sync_success().unwrap(), None);
        store.set_account_user(Some(USER_1)).unwrap();
        store.set_sync_workspace(Some(WORKSPACE)).unwrap();
        store.set_last_sync_success(at(5)).unwrap();
        // Later values replace earlier ones.
        store.set_account_user(Some(USER_2)).unwrap();
        store.set_last_sync_success(at(6)).unwrap();
        store.save_pause(Some(PauseRecord::UntilResumed)).unwrap();
        store.device_id().unwrap()
    };

    let store = Store::open(&path).unwrap();
    assert_eq!(store.account_user().unwrap().as_deref(), Some(USER_2));
    assert_eq!(store.sync_workspace().unwrap().as_deref(), Some(WORKSPACE));
    assert_eq!(store.last_sync_success().unwrap(), Some(at(6)));
    let meta = dump(
        &raw(&path),
        "SELECT key, value FROM meta WHERE key NOT IN ('device_id', 'tracker_pause') ORDER BY key",
    );
    assert_eq!(
        meta,
        [
            [text("account_user_id"), text(USER_2)],
            [text("last_sync_success_ms"), text(&at(6).to_string())],
            [text("sync_workspace_id"), text(WORKSPACE)],
        ],
        "the documented keys, stored as strings"
    );

    // Empty ids would create an owner or workspace nobody has: refused, nothing changes.
    assert!(store.set_account_user(Some("")).is_err());
    assert!(store.set_account_user(Some("  ")).is_err());
    assert!(store.set_sync_workspace(Some("")).is_err());
    assert_eq!(store.account_user().unwrap().as_deref(), Some(USER_2));
    assert_eq!(store.sync_workspace().unwrap().as_deref(), Some(WORKSPACE));

    // Signing out and clearing the workspace remove the keys (twice is fine).
    for _ in 0..2 {
        store.set_account_user(None).unwrap();
        store.set_sync_workspace(None).unwrap();
    }
    assert_eq!(store.account_user().unwrap(), None);
    assert_eq!(store.sync_workspace().unwrap(), None);
    assert_eq!(store.last_sync_success().unwrap(), Some(at(6)));

    // An unreadable stored time is "never", not a guess.
    raw(&path)
        .execute(
            "UPDATE meta SET value = 'yesterday' WHERE key = 'last_sync_success_ms'",
            [],
        )
        .unwrap();
    assert_eq!(store.last_sync_success().unwrap(), None);
    store.set_last_sync_success(at(7)).unwrap();
    assert_eq!(store.last_sync_success().unwrap(), Some(at(7)));

    // Phase 1 meta keys are untouched by any of this.
    assert_eq!(store.device_id().unwrap(), device);
    assert_eq!(store.load_pause().unwrap(), Some(PauseRecord::UntilResumed));
}

#[test]
fn an_in_memory_store_is_a_shareable_sync_ledger() {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let ledger: Arc<dyn SyncLedger> = store.clone();
    ledger.set_account_user(Some(USER_1)).unwrap();
    store
        .upsert_intervals("device", &[done("a", 0, 10)])
        .unwrap();
    assert_eq!(ledger.outbox_counts(Some(USER_1)).unwrap(), counts(1, 0, 0));
    let entries = ledger.pending_entries(USER_1, 10).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        ledger.mark_synced(&ids(&["a"]), WORKSPACE, at(20)).unwrap(),
        1
    );
    assert_eq!(ledger.outbox_counts(Some(USER_1)).unwrap(), counts(0, 0, 0));
    assert_eq!(store.list_all_events().unwrap()[0].sync_status, "synced");
}

// ---- stamping new rows with the signed-in account -----------------------------------------

#[test]
fn new_rows_take_the_signed_in_account_and_never_change_owner() {
    let f = Fixture::new();

    // Signed out: no owner.
    let a = open_iv("a", "figma", Active, at(0), at(15));
    f.record(None, slice_of(&a));
    assert_eq!(f.owner("a"), None);

    // Signing in does not adopt the interval already being recorded, at a checkpoint...
    f.store.set_account_user(Some(USER_1)).unwrap();
    let a_checkpoint = Interval {
        ended_at_ms: at(30),
        ..a.clone()
    };
    f.store
        .upsert_intervals(&f.device, &[a_checkpoint])
        .unwrap();
    assert_eq!(f.owner("a"), None, "a checkpoint keeps the owner");
    // ...or when it closes; the next interval is the user's.
    let b = open_iv("b", "figma", Idle, at(40), at(45));
    f.store
        .upsert_intervals(
            &f.device,
            &[b.clone(), close(&a, at(40), EndReason::BecameIdle)],
        )
        .unwrap();
    assert_eq!(f.owner("a"), None);
    assert_eq!(f.owner("b").as_deref(), Some(USER_1));
    // The public record shows the owner too.
    let records = f.store.list_all_events().unwrap();
    assert_eq!(records[1].user_id.as_deref(), Some(USER_1));

    // Another account signs in: rows keep their first owner through checkpoints and closing.
    f.store.set_account_user(Some(USER_2)).unwrap();
    let b_checkpoint = Interval {
        ended_at_ms: at(50),
        ..b.clone()
    };
    f.store
        .upsert_intervals(&f.device, &[b_checkpoint])
        .unwrap();
    assert_eq!(f.owner("b").as_deref(), Some(USER_1));
    let c = done("c", 60, 70);
    f.store
        .upsert_intervals(
            &f.device,
            &[close(&b, at(60), EndReason::InputResumed), c.clone()],
        )
        .unwrap();
    assert_eq!(f.owner("b").as_deref(), Some(USER_1));
    assert_eq!(f.owner("c").as_deref(), Some(USER_2));

    // Signed out again: a replayed closed interval changes nothing, new rows are unowned.
    f.store.set_account_user(None).unwrap();
    f.store.upsert_intervals(&f.device, slice_of(&c)).unwrap();
    assert_eq!(f.owner("c").as_deref(), Some(USER_2));
    f.store
        .upsert_intervals(&f.device, &[open_iv("d", "figma", Active, at(80), at(85))])
        .unwrap();
    assert_eq!(f.owner("d"), None);

    // Crash recovery closes open rows without touching their owner either.
    f.record_elsewhere(
        Some(USER_1),
        &[open_iv("e", "blender", Active, at(0), at(10))],
    );
    assert_eq!(f.owner("e").as_deref(), Some(USER_1));
    assert_eq!(
        f.store.recover_open_intervals(2 * SEC).unwrap(),
        RecoveryReport {
            closed: 2,
            discarded: 0
        }
    );
    assert_eq!(f.owner("d"), None);
    assert_eq!(f.owner("e").as_deref(), Some(USER_1));

    // Phase 1 bookkeeping is unchanged: revisions count tracker writes only.
    assert_eq!(
        f.revisions(),
        [
            ("a".to_owned(), 3),
            ("e".to_owned(), 2),
            ("b".to_owned(), 3),
            ("c".to_owned(), 1),
            ("d".to_owned(), 2),
        ]
    );

    // And there is still at most one open interval per device while signed in.
    f.store
        .upsert_intervals(&f.device, &[open_iv("f", "figma", Active, at(90), at(95))])
        .unwrap();
    assert_eq!(f.owner("f").as_deref(), Some(USER_1));
    assert!(f
        .store
        .upsert_intervals(&f.device, &[open_iv("g", "figma", Active, at(95), at(99))])
        .is_err());
}

fn slice_of(interval: &Interval) -> &[Interval] {
    std::slice::from_ref(interval)
}

// ---- reading the outbox -------------------------------------------------------------------

#[test]
fn pending_entries_are_the_users_closed_pending_rows_oldest_first() {
    let f = Fixture::new();
    // Signed out: never returned for anyone until claimed.
    f.record(None, &[done("unowned", -100, -90)]);
    // USER_1, written out of order; the open interval is still being recorded.
    let open = open_iv("u1-open", "figma", Active, at(60), at(70));
    f.record(
        Some(USER_1),
        &[
            closed_iv(
                "u1-c",
                "blender",
                Active,
                at(40),
                at(60),
                EndReason::AppSwitch,
            ),
            closed_iv(
                "u1-a",
                "figma",
                Idle,
                at(0),
                at(20),
                EndReason::InputResumed,
            ),
            closed_iv(
                "u1-b",
                "figma",
                Active,
                at(20),
                at(40),
                EndReason::BecameIdle,
            ),
            open.clone(),
        ],
    );
    // Same start as u1-b, on another device: equal starts are ordered by id.
    f.record_elsewhere(Some(USER_1), &[done("u1-0-other", 20, 25)]);
    f.record(Some(USER_2), &[done("u2-a", 100, 110)]);

    assert_eq!(
        f.pending_ids(USER_1),
        ["u1-a", "u1-0-other", "u1-b", "u1-c"]
    );
    assert_eq!(f.pending_ids(USER_2), ["u2-a"]);
    assert!(f.pending_ids("someone-else").is_empty());

    // The limit takes the oldest.
    let first_two: Vec<String> = f
        .store
        .pending_entries(USER_1, 2)
        .unwrap()
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    assert_eq!(first_two, ["u1-a", "u1-0-other"]);
    assert!(f.store.pending_entries(USER_1, 0).unwrap().is_empty());

    // Every column is carried over exactly.
    let created: i64 = raw(&f.path)
        .query_row(
            "SELECT created_at_ms FROM tracking_events WHERE id = 'u1-a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        f.store.pending_entries(USER_1, 1).unwrap(),
        [PendingEntry {
            id: "u1-a".to_owned(),
            device_id: f.device.clone(),
            application_id: "figma".to_owned(),
            application_name: "figma (name)".to_owned(),
            kind: "idle".to_owned(),
            started_at_ms: at(0),
            ended_at_ms: at(20),
            active_ms: 0,
            idle_ms: 20_000,
            end_reason: "inputResumed".to_owned(),
            project_id: None,
            task_id: None,
            revision: 1,
            created_at_ms: created,
        }]
    );

    // The open interval joins its owner's outbox once it closes, whoever is signed in then.
    f.store
        .upsert_intervals(&f.device, &[close(&open, at(80), EndReason::Shutdown)])
        .unwrap();
    let entries = f.store.pending_entries(USER_1, 10).unwrap();
    let last = entries.last().unwrap();
    assert_eq!(last.id, "u1-open");
    assert_eq!(last.kind, "active");
    assert_eq!((last.started_at_ms, last.ended_at_ms), (at(60), at(80)));
    assert_eq!((last.active_ms, last.idle_ms), (20_000, 0));
    assert_eq!(last.end_reason, "shutdown");
    assert_eq!(last.revision, 2);
    assert_eq!(f.pending_ids(USER_2), ["u2-a"]);
}

#[test]
fn outbox_counts_split_pending_unclaimed_and_rejected() {
    let f = Fixture::new();
    assert_eq!(f.counts(None), OutboxCounts::default());
    assert_eq!(f.counts(Some(USER_1)), OutboxCounts::default());

    f.record(None, &[done("n1", 0, 10), done("n2", 10, 20)]);
    let open = open_iv("a4", "figma", Active, at(50), at(55));
    f.record(
        Some(USER_1),
        &[
            done("a1", 20, 30),
            done("a2", 30, 40),
            done("a3", 40, 50),
            open.clone(),
        ],
    );
    f.record_elsewhere(Some(USER_2), &[done("b1", 0, 10)]);

    assert_eq!(
        f.counts(Some(USER_1)),
        counts(3, 2, 0),
        "the open row waits"
    );
    assert_eq!(f.counts(Some(USER_2)), counts(1, 2, 0));
    assert_eq!(
        f.counts(None),
        counts(0, 2, 0),
        "signed out: nothing is pending"
    );
    assert_eq!(f.counts(Some("someone-else")), counts(0, 2, 0));

    // Synced rows leave the outbox; rejections are counted whoever owns them.
    assert_eq!(
        f.store
            .mark_synced(&ids(&["a1"]), WORKSPACE, at(100))
            .unwrap(),
        1
    );
    assert_eq!(
        f.store
            .mark_rejected(&[rejection("a2", "23514: check violation")])
            .unwrap(),
        1
    );
    assert_eq!(
        f.store
            .mark_rejected(&[rejection("b1", "22P02: invalid uuid")])
            .unwrap(),
        1
    );
    assert_eq!(f.counts(Some(USER_1)), counts(1, 2, 2));
    assert_eq!(f.counts(Some(USER_2)), counts(0, 2, 2));
    assert_eq!(f.counts(None), counts(0, 2, 2));

    // A transient failure keeps the row pending.
    f.store
        .record_attempt_failure(&ids(&["a3"]), "offline")
        .unwrap();
    assert_eq!(f.counts(Some(USER_1)), counts(1, 2, 2));

    // The open interval counts once it closes; claiming moves unclaimed rows to the user.
    f.store
        .upsert_intervals(&f.device, &[close(&open, at(60), EndReason::Paused)])
        .unwrap();
    assert_eq!(f.counts(Some(USER_1)), counts(2, 2, 2));
    assert_eq!(f.store.claim_unowned(USER_1).unwrap(), 2);
    assert_eq!(f.counts(Some(USER_1)), counts(4, 0, 2));

    // Phase 1's summary still counts every closed, pending row, whoever owns it.
    assert_eq!(f.store.data_summary().unwrap().pending_sync_count, 4);
}

// ---- writing sync results -----------------------------------------------------------------

#[test]
fn mark_synced_changes_only_closed_pending_rows_and_is_idempotent() {
    let f = Fixture::new();
    let open = open_iv("open", "figma", Active, at(30), at(35));
    let p1 = done("p1", 0, 10);
    f.record(
        Some(USER_1),
        &[
            p1.clone(),
            closed_iv(
                "p2",
                "blender",
                Idle,
                at(10),
                at(20),
                EndReason::InputResumed,
            ),
            done("rej", 20, 30),
            open.clone(),
        ],
    );
    assert_eq!(
        f.store
            .mark_rejected(&[rejection("rej", "23514: bad row")])
            .unwrap(),
        1
    );
    f.store
        .record_attempt_failure(&ids(&["p1"]), "timed out")
        .unwrap();
    let before_p1 = f.row("p1");
    let before_open = f.row("open");
    let before_rej = f.row("rej");
    assert_eq!(before_p1.sync_attempts, 1);
    assert_eq!(before_p1.last_sync_error.as_deref(), Some("timed out"));

    let batch = ids(&["p1", "p2", "open", "rej", "unknown", "p1"]);
    assert_eq!(f.store.mark_synced(&batch, WORKSPACE, at(100)).unwrap(), 2);
    assert_eq!(
        f.row("p1"),
        SyncRow {
            sync_status: "synced".to_owned(),
            workspace_id: Some(WORKSPACE.to_owned()),
            synced_at_ms: Some(at(100)),
            last_sync_error: None,
            ..before_p1
        },
        "only the sync columns change; attempts, revision and updated_at are kept"
    );
    assert_eq!(f.row("p2").sync_status, "synced");
    assert_eq!(f.row("open"), before_open, "open rows are never marked");
    assert_eq!(f.row("rej"), before_rej, "rejected rows stay rejected");
    assert!(f.pending_ids(USER_1).is_empty());

    // A retry after a lost response is a no-op: nothing is overwritten.
    let after = (f.row("p1"), f.row("p2"));
    assert_eq!(
        f.store
            .mark_synced(&batch, "another-workspace", at(200))
            .unwrap(),
        0
    );
    assert_eq!((f.row("p1"), f.row("p2")), after);

    // A tracker replay of a synced interval cannot put it back into the outbox.
    f.store.upsert_intervals(&f.device, slice_of(&p1)).unwrap();
    assert_eq!(f.row("p1"), after.0);

    // The open interval becomes uploadable once it closes.
    f.store
        .upsert_intervals(&f.device, &[close(&open, at(40), EndReason::Shutdown)])
        .unwrap();
    assert_eq!(f.pending_ids(USER_1), ["open"]);
    assert_eq!(
        f.store
            .mark_synced(&ids(&["open"]), WORKSPACE, at(300))
            .unwrap(),
        1
    );
    assert_eq!(f.row("open").revision, 2);

    // Nothing to do, or an invalid workspace: nothing changes.
    assert_eq!(f.store.mark_synced(&[], WORKSPACE, at(1)).unwrap(), 0);
    f.store
        .upsert_intervals(&f.device, &[done("p3", 50, 60)])
        .unwrap();
    assert!(f.store.mark_synced(&ids(&["p3"]), "", at(1)).is_err());
    assert!(f.store.mark_synced(&ids(&["p3"]), " ", at(1)).is_err());
    assert_eq!(f.row("p3").sync_status, "pending");
    assert_eq!(f.row("p3").workspace_id, None);
}

#[test]
fn rejected_rows_are_kept_but_leave_the_outbox_with_a_short_reason() {
    let f = Fixture::new();
    f.record(
        Some(USER_1),
        &[
            done("p1", 0, 10),
            done("p2", 10, 20),
            done("p3", 20, 30),
            done("s1", 30, 40),
            open_iv("o1", "figma", Active, at(40), at(45)),
        ],
    );
    f.store
        .mark_synced(&ids(&["s1"]), WORKSPACE, at(50))
        .unwrap();
    let before_s1 = f.row("s1");
    let before_o1 = f.row("o1");

    let long = "é".repeat(1_000);
    let updated = f
        .store
        .mark_rejected(&[
            rejection("p1", "23514: new row violates check constraint"),
            rejection("p2", &long),
            rejection("o1", "open rows are never rejected"),
            rejection("s1", "synced rows are final"),
            rejection("unknown", "no such row"),
            rejection("p1", "a second reason for the same row"),
        ])
        .unwrap();
    assert_eq!(updated, 2);

    let p1 = f.row("p1");
    assert_eq!(p1.sync_status, "failed");
    assert_eq!(p1.state, "closed");
    assert_eq!(
        p1.last_sync_error.as_deref(),
        Some("23514: new row violates check constraint"),
        "the first rejection wins"
    );
    assert_eq!(p1.workspace_id, None);
    assert_eq!(p1.synced_at_ms, None);
    let p2_error = f.row("p2").last_sync_error.unwrap();
    assert_eq!(p2_error.chars().count(), 300, "cut at 300 characters");
    assert_eq!(p2_error, "é".repeat(300));
    assert_eq!(f.row("o1"), before_o1);
    assert_eq!(f.row("s1"), before_s1);

    // Out of the outbox, counted, and kept locally.
    assert_eq!(f.pending_ids(USER_1), ["p3"]);
    assert_eq!(f.counts(Some(USER_1)), counts(1, 0, 2));
    let records = f.store.list_all_events().unwrap();
    assert_eq!(records.len(), 5);
    assert_eq!(records[0].sync_status, "failed");

    // Rejections are final: no later sync, failure bookkeeping or rejection changes them.
    let rejected = (f.row("p1"), f.row("p2"));
    assert_eq!(
        f.store
            .mark_synced(&ids(&["p1", "p2"]), WORKSPACE, at(60))
            .unwrap(),
        0
    );
    f.store
        .record_attempt_failure(&ids(&["p1", "p2"]), "offline")
        .unwrap();
    assert_eq!(
        f.store.mark_rejected(&[rejection("p1", "again")]).unwrap(),
        0
    );
    assert_eq!(f.store.mark_rejected(&[]).unwrap(), 0);
    assert_eq!((f.row("p1"), f.row("p2")), rejected);
}

#[test]
fn transient_failures_count_attempts_and_keep_rows_pending() {
    let f = Fixture::new();
    f.record(
        Some(USER_1),
        &[
            done("p1", 0, 10),
            done("p2", 10, 20),
            done("s1", 20, 30),
            done("r1", 30, 40),
            open_iv("o1", "figma", Active, at(40), at(45)),
        ],
    );
    f.store
        .mark_synced(&ids(&["s1"]), WORKSPACE, at(50))
        .unwrap();
    f.store
        .mark_rejected(&[rejection("r1", "22023: bad")])
        .unwrap();
    let untouched = [f.row("s1"), f.row("r1"), f.row("o1")];

    f.store
        .record_attempt_failure(
            &ids(&["p1", "p2", "p1", "o1", "s1", "r1", "unknown"]),
            "network: connection reset",
        )
        .unwrap();
    for id in ["p1", "p2"] {
        let row = f.row(id);
        assert_eq!(row.sync_attempts, 1, "{id}: one call is one attempt");
        assert_eq!(
            row.last_sync_error.as_deref(),
            Some("network: connection reset")
        );
        assert_eq!(row.sync_status, "pending");
        assert_eq!(row.state, "closed");
    }
    assert_eq!(
        [f.row("s1"), f.row("r1"), f.row("o1")],
        untouched,
        "only closed, pending rows are touched"
    );

    let long = "x".repeat(400);
    f.store
        .record_attempt_failure(&ids(&["p1"]), &long)
        .unwrap();
    let p1 = f.row("p1");
    assert_eq!(p1.sync_attempts, 2);
    assert_eq!(
        p1.last_sync_error.as_deref(),
        Some("x".repeat(300).as_str())
    );
    assert_eq!(f.row("p2").sync_attempts, 1);
    assert_eq!(f.pending_ids(USER_1), ["p1", "p2"], "still in the outbox");

    // An empty list is a no-op.
    f.store.record_attempt_failure(&[], "ignored").unwrap();
    assert_eq!(f.row("p1"), p1);

    // A later success clears the error and keeps the attempt count as history.
    f.store
        .mark_synced(&ids(&["p1"]), WORKSPACE, at(60))
        .unwrap();
    let p1 = f.row("p1");
    assert_eq!(p1.sync_attempts, 2);
    assert_eq!(p1.last_sync_error, None);
}

// ---- claiming intervals recorded while signed out -----------------------------------------

#[test]
fn claiming_takes_only_unowned_rows_that_are_not_synced() {
    let f = Fixture::new();
    let open = open_iv("n-open", "figma", Active, at(40), at(45));
    f.record(
        None,
        &[
            done("n-pending", 0, 10),
            done("n-rejected", 10, 20),
            done("n-synced", 20, 30),
            open.clone(),
        ],
    );
    f.record_elsewhere(Some(USER_2), &[done("u2", 0, 10)]);
    f.record_elsewhere(Some(USER_1), &[done("u1", 60, 70)]);
    f.store
        .mark_rejected(&[rejection("n-rejected", "22007: bad timestamp")])
        .unwrap();
    f.store
        .mark_synced(&ids(&["n-synced"]), WORKSPACE, at(80))
        .unwrap();
    assert_eq!(f.counts(Some(USER_1)), counts(1, 1, 1));
    let before_synced = f.row("n-synced");

    assert_eq!(f.store.claim_unowned(USER_1).unwrap(), 3);
    for id in ["n-pending", "n-rejected", "n-open"] {
        assert_eq!(f.owner(id).as_deref(), Some(USER_1), "{id}");
    }
    assert_eq!(
        f.row("n-synced"),
        before_synced,
        "synced rows are never re-attributed"
    );
    assert_eq!(
        f.owner("u2").as_deref(),
        Some(USER_2),
        "other accounts keep theirs"
    );
    assert_eq!(f.owner("u1").as_deref(), Some(USER_1));
    // Only the owner changes.
    assert_eq!(f.row("n-rejected").sync_status, "failed");
    assert_eq!(f.row("n-open").state, "open");
    assert_eq!(f.pending_ids(USER_1), ["n-pending", "u1"]);
    assert_eq!(f.counts(Some(USER_1)), counts(2, 0, 1));

    // Idempotent, and nothing is left for anyone else.
    assert_eq!(f.store.claim_unowned(USER_1).unwrap(), 0);
    assert_eq!(f.store.claim_unowned(USER_2).unwrap(), 0);
    assert_eq!(f.pending_ids(USER_2), ["u2"]);

    // The claimed open interval keeps its new owner when it closes, even while signed out.
    f.store.set_account_user(None).unwrap();
    f.store
        .upsert_intervals(&f.device, &[close(&open, at(50), EndReason::Shutdown)])
        .unwrap();
    assert_eq!(f.owner("n-open").as_deref(), Some(USER_1));
    assert_eq!(f.pending_ids(USER_1), ["n-pending", "n-open", "u1"]);

    // An empty user id is refused and claims nothing.
    f.store
        .upsert_intervals(&f.device, &[done("later", 100, 110)])
        .unwrap();
    assert!(f.store.claim_unowned("").is_err());
    assert!(f.store.claim_unowned("   ").is_err());
    assert_eq!(f.owner("later"), None);
}

// ---- volume and deletion ------------------------------------------------------------------

#[test]
fn id_lists_beyond_any_sql_parameter_limit_are_handled_in_one_call() {
    let f = Fixture::new();
    const N: i64 = 2_500;
    let intervals: Vec<Interval> = (0..N)
        .map(|i| done(&format!("iv-{i:05}"), i * 10, i * 10 + 5))
        .collect();
    f.record(Some(USER_1), &intervals);
    let all: Vec<String> = intervals.iter().map(|iv| iv.id.clone()).collect();
    assert_eq!(f.pending_ids(USER_1), all, "oldest first");
    assert_eq!(f.store.pending_entries(USER_1, 100).unwrap().len(), 100);

    // Every id, 600 unknown ids and 300 duplicates.
    let mut noisy = all.clone();
    noisy.extend((0..600).map(|i| format!("unknown-{i}")));
    noisy.extend(all[..300].iter().cloned());

    f.store.record_attempt_failure(&noisy, "timed out").unwrap();
    let attempts = dump(
        &raw(&f.path),
        "SELECT COUNT(*), MIN(sync_attempts), MAX(sync_attempts) FROM tracking_events",
    );
    assert_eq!(
        attempts,
        [[Value::Integer(N), Value::Integer(1), Value::Integer(1)]]
    );

    let rejections: Vec<(String, String)> = all[..700]
        .iter()
        .map(|id| rejection(id, "22023: invalid"))
        .collect();
    assert_eq!(f.store.mark_rejected(&rejections).unwrap(), 700);
    assert_eq!(
        f.store.mark_synced(&noisy, WORKSPACE, at(99_999)).unwrap(),
        1_800
    );
    assert_eq!(f.counts(Some(USER_1)), counts(0, 0, 700));
    let synced = dump(
        &raw(&f.path),
        "SELECT COUNT(*) FROM tracking_events
         WHERE sync_status = 'synced' AND workspace_id IS NOT NULL AND synced_at_ms IS NOT NULL",
    );
    assert_eq!(synced, [[Value::Integer(1_800)]]);
    assert_eq!(
        f.store.mark_synced(&noisy, WORKSPACE, at(99_999)).unwrap(),
        0
    );
}

#[test]
fn deleting_history_removes_outbox_rows_and_their_counts() {
    let f = Fixture::new();
    f.record(None, &[done("n1", 0, 10)]);
    f.record(
        Some(USER_1),
        &[
            done("a", 10, 20),
            done("b", 20, 30),
            done("c", 30, 40),
            done("d", 40, 50),
            done("e", 50, 60),
            open_iv("open", "figma", Active, at(60), at(65)),
        ],
    );
    f.store.set_sync_workspace(Some(WORKSPACE)).unwrap();
    f.store
        .mark_rejected(&[rejection("d", "22023: invalid")])
        .unwrap();
    f.store
        .mark_synced(&ids(&["e"]), WORKSPACE, at(70))
        .unwrap();
    assert_eq!(f.counts(Some(USER_1)), counts(3, 1, 1));

    // Pending rows can be deleted before they are uploaded.
    assert_eq!(f.store.delete_events(Some(at(25))).unwrap(), 2); // n1, a
    assert_eq!(f.counts(Some(USER_1)), counts(2, 0, 1));
    assert_eq!(f.pending_ids(USER_1), ["b", "c"]);
    // A late confirmation for a deleted row does not bring it back.
    assert_eq!(
        f.store
            .mark_synced(&ids(&["a"]), WORKSPACE, at(80))
            .unwrap(),
        0
    );
    assert!(f
        .store
        .list_all_events()
        .unwrap()
        .iter()
        .all(|r| r.id != "a"));

    assert_eq!(f.store.delete_events(Some(at(60))).unwrap(), 4); // b, c, d, e
    assert_eq!(f.counts(Some(USER_1)), OutboxCounts::default());
    assert_eq!(f.store.delete_events(None).unwrap(), 1); // the open row
    assert_eq!(f.counts(Some(USER_1)), OutboxCounts::default());

    // The account and sync settings are not history: they survive, and stamping continues.
    assert_eq!(f.store.account_user().unwrap().as_deref(), Some(USER_1));
    assert_eq!(
        f.store.sync_workspace().unwrap().as_deref(),
        Some(WORKSPACE)
    );
    f.store
        .upsert_intervals(&f.device, &[done("z", 100, 110)])
        .unwrap();
    assert_eq!(f.owner("z").as_deref(), Some(USER_1));
    assert_eq!(f.pending_ids(USER_1), ["z"]);
}

// ---- migration 0002 on a Phase 1 database -------------------------------------------------

const V1_DEVICE: &str = "3f2b8c1e-7d4a-4e9b-a6c5-0d1e2f3a4b5c";
const L1: &str = "0199dc6a-7a00-7000-8000-000000000001";
const L2: &str = "0199dc6a-7a00-7000-8000-000000000002";
const L3: &str = "0199dc6a-7a00-7000-8000-000000000003";
const L4: &str = "0199dc6a-7a00-7000-8000-000000000004";
const L5: &str = "0199dc6a-7a00-7000-8000-000000000005";
const L4_NAME: &str = "Studio, Inc \u{2014} \"Cinema 4D\"";

/// The `tracking_events` columns of schema version 1, in table order.
const V1_TRACKING_COLUMNS: [&str; 19] = [
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

/// One Phase 1 row: `(id, app id, app name, kind, start s, end s, end reason, revision)`;
/// `None` reason = still open.
type V1Event = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    i64,
    i64,
    Option<&'static str>,
    i64,
);

const V1_EVENTS: [V1Event; 5] = [
    (L1, "figma", "Figma", "active", 0, 600, Some("appSwitch"), 3),
    (
        L2,
        "blender",
        "Blender",
        "active",
        600,
        900,
        Some("becameIdle"),
        2,
    ),
    (
        L3,
        "blender",
        "Blender",
        "idle",
        900,
        960,
        Some("inputResumed"),
        1,
    ),
    (
        L4,
        "custom-0000beef",
        L4_NAME,
        "active",
        960,
        1_000,
        Some("recovered"),
        4,
    ),
    // Checkpointed three times, then the app stopped: Phase 1 left it open.
    (L5, "figma", "Figma", "active", 1_000, 1_045, None, 4),
];

/// A database exactly as Phase 1 leaves it: migration 1 applied with its `user_version` bump in
/// one `BEGIN IMMEDIATE` transaction (as Phase 1's `migrate` does), WAL mode, and realistic
/// content written with Phase 1's column list.
fn build_v1_database(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut conn = Connection::open(path).unwrap();
    let mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    conn.pragma_update(None, "secure_delete", true).unwrap();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    tx.execute_batch(MIGRATIONS[0]).unwrap();
    tx.pragma_update(None, "user_version", 1).unwrap();
    tx.commit().unwrap();

    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('device_id', ?1), ('tracker_pause', ?2)",
        params![V1_DEVICE, at(3_600).to_string()],
    )
    .unwrap();
    let mut settings = Settings::default();
    settings.onboarding.completed = true;
    conn.execute(
        "INSERT INTO preferences (key, value_json, updated_at_ms) VALUES ('settings', ?1, ?2)",
        params![serde_json::to_string(&settings).unwrap(), at(-86_400)],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO applications (id, display_name, category, matchers_json, enabled,
             include_in_reports, built_in, sort_order, created_at_ms, updated_at_ms)
         VALUES ('figma', 'Figma', 'design', '[{\"exe\":\"Figma.exe\"}]', 1, 1, 1, 0, ?1, ?1),
                ('blender', 'Blender', '3d', '[{\"exe\":\"blender.exe\"}]', 1, 1, 1, 10, ?1, ?1),
                ('custom-0000beef', 'Cinema 4D', 'other', '[{\"exe\":\"Cinema 4D.exe\"}]',
                 1, 0, 0, 20, ?1, ?2)",
        params![at(-86_400), at(-3_600)],
    )
    .unwrap();
    let mut insert = conn
        .prepare(
            "INSERT INTO tracking_events (
                 id, device_id, user_id, application_id, application_name, kind,
                 started_at_ms, ended_at_ms, active_ms, idle_ms, state, end_reason,
                 project_id, task_id, source, sync_status, revision, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL,
                     'automatic', 'pending', ?12, ?13, ?14)",
        )
        .unwrap();
    for (id, app, name, kind, start, end, reason, revision) in V1_EVENTS {
        let duration = (end - start) * SEC;
        let (active, idle) = if kind == "active" {
            (duration, 0)
        } else {
            (0, duration)
        };
        let state = if reason.is_some() { "closed" } else { "open" };
        insert
            .execute(params![
                id,
                V1_DEVICE,
                app,
                name,
                kind,
                at(start),
                at(end),
                active,
                idle,
                state,
                reason,
                revision,
                at(start) + 20,
                at(end) + 20,
            ])
            .unwrap();
    }
}

/// Everything a migration could disturb, read through a raw connection.
#[derive(Debug, PartialEq)]
struct Snapshot {
    user_version: i64,
    tracking_columns: Vec<String>,
    /// The Phase 1 columns of every row.
    tracking_rows: Vec<Vec<Value>>,
    meta: Vec<Vec<Value>>,
    preferences: Vec<Vec<Value>>,
    applications: Vec<Vec<Value>>,
    /// `sqlite_schema` rows of the other tables and their indexes.
    other_schema: Vec<Vec<Value>>,
    /// `(name, sql)` of the indexes on `tracking_events`.
    tracking_indexes: Vec<Vec<Value>>,
}

impl Snapshot {
    fn take(conn: &Connection) -> Self {
        let columns = V1_TRACKING_COLUMNS.join(", ");
        Self {
            user_version: user_version(conn),
            tracking_columns: tracking_columns(conn),
            tracking_rows: dump(
                conn,
                &format!("SELECT {columns} FROM tracking_events ORDER BY id"),
            ),
            meta: dump(conn, "SELECT * FROM meta ORDER BY key"),
            preferences: dump(conn, "SELECT * FROM preferences ORDER BY key"),
            applications: dump(conn, "SELECT * FROM applications ORDER BY id"),
            other_schema: dump(
                conn,
                "SELECT type, name, tbl_name, sql FROM sqlite_schema
                 WHERE tbl_name <> 'tracking_events' ORDER BY type, name",
            ),
            tracking_indexes: dump(
                conn,
                "SELECT name, sql FROM sqlite_schema
                 WHERE type = 'index' AND tbl_name = 'tracking_events' ORDER BY name",
            ),
        }
    }
}

#[test]
fn a_phase1_database_is_upgraded_in_place_without_changing_its_history() {
    assert_eq!(MIGRATIONS.len(), 2, "this test proves the 1 -> 2 upgrade");
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("data").join("studio-pulse.sqlite3");
    build_v1_database(&path);
    let before = Snapshot::take(&raw(&path));
    assert_eq!(before.user_version, 1);
    assert_eq!(before.tracking_columns, V1_TRACKING_COLUMNS);
    assert_eq!(before.tracking_rows.len(), 5);

    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 2);

    // Additive: every Phase 1 table, index, row and value is exactly as it was.
    let conn = raw(&path);
    let after = Snapshot::take(&conn);
    assert_eq!(after.user_version, 2);
    assert_eq!(after.tracking_rows, before.tracking_rows, "history intact");
    assert_eq!(after.meta, before.meta);
    assert_eq!(after.preferences, before.preferences);
    assert_eq!(after.applications, before.applications);
    assert_eq!(
        after.other_schema, before.other_schema,
        "other tables untouched"
    );
    assert_eq!(after.tracking_columns, STORED_TRACKING_FIELDS);
    assert_eq!(
        after.tracking_columns[..V1_TRACKING_COLUMNS.len()],
        V1_TRACKING_COLUMNS,
        "new columns are appended, never reordered"
    );
    for index in &before.tracking_indexes {
        assert!(
            after.tracking_indexes.contains(index),
            "Phase 1 index kept: {index:?}"
        );
    }
    let added: Vec<&Vec<Value>> = after
        .tracking_indexes
        .iter()
        .filter(|index| !before.tracking_indexes.contains(index))
        .collect();
    assert_eq!(added.len(), 1);
    assert_eq!(added[0][0], text("tracking_events_outbox_by_user"));

    // The new columns start empty on every existing row.
    let sync_columns = dump(
        &conn,
        "SELECT workspace_id, synced_at_ms, sync_attempts, last_sync_error
         FROM tracking_events ORDER BY id",
    );
    assert_eq!(sync_columns.len(), 5);
    for row in sync_columns {
        assert_eq!(
            row,
            [Value::Null, Value::Null, Value::Integer(0), Value::Null]
        );
    }
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");

    // Through the API: the same device, pause, settings and records.
    assert_eq!(store.device_id().unwrap(), V1_DEVICE);
    assert_eq!(
        store.load_pause().unwrap(),
        Some(PauseRecord::Until(at(3_600)))
    );
    assert!(store.load_settings().unwrap().onboarding.completed);
    let records = store.list_all_events().unwrap();
    let record_ids: Vec<&str> = records.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(record_ids, [L1, L2, L3, L4, L5]);
    let revisions: Vec<i64> = records.iter().map(|r| r.revision).collect();
    assert_eq!(revisions, [3, 2, 1, 4, 4]);
    assert!(records
        .iter()
        .all(|r| r.user_id.is_none() && r.sync_status == "pending" && r.device_id == V1_DEVICE));
    assert_eq!(records[0].duration_seconds, 600.0);
    assert_eq!(records[2].kind, Idle);
    assert_eq!(records[2].idle_seconds, 60.0);
    assert_eq!(records[3].application_name, L4_NAME);
    assert_eq!(records[3].end_reason, Some(EndReason::Recovered));
    assert_eq!(records[4].state, "open");
    let summary = store.data_summary().unwrap();
    assert_eq!(summary.event_count, 5);
    assert_eq!(summary.open_event_count, 1);
    assert_eq!(summary.pending_sync_count, 4);
    assert_eq!(summary.stored_fields, STORED_TRACKING_FIELDS);

    // Phase 1 history has no owner: nothing is uploaded until the user claims it.
    assert_eq!(store.account_user().unwrap(), None);
    assert_eq!(store.outbox_counts(Some(USER_1)).unwrap(), counts(0, 4, 0));
    assert!(store.pending_entries(USER_1, 100).unwrap().is_empty());

    // Crash recovery still closes the interval Phase 1 left open, at its last checkpoint.
    assert_eq!(
        store.recover_open_intervals(2 * SEC).unwrap(),
        RecoveryReport {
            closed: 1,
            discarded: 0
        }
    );
    let recovered = &store.list_all_events().unwrap()[4];
    assert_eq!(recovered.state, "closed");
    assert_eq!(recovered.end_reason, Some(EndReason::Recovered));
    assert_eq!(recovered.ended_at_ms, at(1_045));
    assert_eq!(recovered.revision, 5);
    assert_eq!(recovered.user_id, None);

    // Tracking continues after the high-water mark; new rows take the signed-in account.
    assert_eq!(store.high_water_ms(V1_DEVICE).unwrap(), Some(at(1_045)));
    store.set_account_user(Some(USER_1)).unwrap();
    let open = open_iv("n2", "figma", Active, at(1_100), at(1_115));
    store
        .upsert_intervals(V1_DEVICE, &[done("n1", 1_050, 1_100), open.clone()])
        .unwrap();
    store
        .upsert_intervals(
            V1_DEVICE,
            &[Interval {
                ended_at_ms: at(1_130),
                ..open
            }],
        )
        .unwrap();
    let records = store.list_all_events().unwrap();
    assert_eq!(records.len(), 7);
    assert_eq!(records[5].id, "n1");
    assert_eq!(records[5].user_id.as_deref(), Some(USER_1));
    assert_eq!(records[6].id, "n2");
    assert_eq!(records[6].user_id.as_deref(), Some(USER_1));
    assert_eq!(records[6].revision, 2);
    assert_eq!(store.outbox_counts(Some(USER_1)).unwrap(), counts(1, 5, 0));

    // With consent, Phase 1 history joins the user's outbox, oldest first.
    assert_eq!(store.claim_unowned(USER_1).unwrap(), 5);
    let pending: Vec<String> = store
        .pending_entries(USER_1, 100)
        .unwrap()
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    assert_eq!(pending, [L1, L2, L3, L4, L5, "n1"]);

    // Reopening does not run the migration again.
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 2);
    assert_eq!(store.list_all_events().unwrap().len(), 7);
}

#[test]
fn a_failed_upgrade_leaves_the_phase1_database_as_it_was() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("studio-pulse.sqlite3");
    build_v1_database(&path);
    // An object in the way of migration 2's last statement: it fails after its ALTERs ran.
    raw(&path)
        .execute_batch("CREATE INDEX tracking_events_outbox_by_user ON tracking_events (device_id)")
        .unwrap();
    let before = Snapshot::take(&raw(&path));

    match Store::open(&path) {
        Err(StoreError::Sqlite(_)) => {}
        Err(other) => panic!("expected a SQLite error, got {other:?}"),
        Ok(_) => panic!("the upgrade must fail"),
    }
    let after = Snapshot::take(&raw(&path));
    assert_eq!(after, before, "version, columns and rows are all unchanged");
    assert_eq!(after.user_version, 1);
    assert_eq!(after.tracking_columns, V1_TRACKING_COLUMNS);

    // Once the obstacle is gone the upgrade succeeds: nothing half-applied was left behind
    // (a leftover column would make the ALTERs fail).
    raw(&path)
        .execute_batch("DROP INDEX tracking_events_outbox_by_user")
        .unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 2);
    assert_eq!(store.list_all_events().unwrap().len(), 5);
}

#[test]
fn concurrent_starts_upgrade_a_phase1_database_exactly_once() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("studio-pulse.sqlite3");
    build_v1_database(&path);
    let before = Snapshot::take(&raw(&path));

    let handles: Vec<_> = (0..8)
        .map(|_| {
            let path = path.clone();
            std::thread::spawn(move || {
                Store::open(&path)
                    .and_then(|store| store.schema_version())
                    .map_err(|err| err.to_string())
            })
        })
        .collect();
    for handle in handles {
        assert_eq!(handle.join().unwrap(), Ok(2));
    }
    let after = Snapshot::take(&raw(&path));
    assert_eq!(after.tracking_rows, before.tracking_rows);
    assert_eq!(after.tracking_columns, STORED_TRACKING_FIELDS);
}

#[test]
fn a_database_from_a_newer_app_is_still_refused_byte_for_byte_untouched() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("studio-pulse.sqlite3");
    {
        let store = Store::open(&path).unwrap();
        let device = store.device_id().unwrap();
        store.set_account_user(Some(USER_1)).unwrap();
        store.set_sync_workspace(Some(WORKSPACE)).unwrap();
        store
            .upsert_intervals(&device, &[done("a", 0, 10), done("b", 10, 20)])
            .unwrap();
        store.mark_synced(&ids(&["a"]), WORKSPACE, at(30)).unwrap();
    }
    let supported = i64::try_from(MIGRATIONS.len()).unwrap();
    let future = supported + 1;
    {
        let conn = raw(&path);
        conn.pragma_update(None, "user_version", future).unwrap();
        // A rollback-journal file shows whether opening changed its (persistent) journal mode.
        let mode: String = conn
            .pragma_update_and_check(None, "journal_mode", "DELETE", |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "delete");
    }
    let bytes = std::fs::read(&path).unwrap();

    match Store::open(&path) {
        Err(StoreError::UnsupportedSchema {
            found,
            supported: max,
        }) => {
            assert_eq!(found, future);
            assert_eq!(max, supported);
        }
        Err(other) => panic!("expected UnsupportedSchema, got {other:?}"),
        Ok(_) => panic!("expected UnsupportedSchema, got a store"),
    }
    assert_eq!(
        std::fs::read(&path).unwrap(),
        bytes,
        "not a single byte of the newer database changed"
    );
    let conn = raw(&path);
    assert_eq!(user_version(&conn), future);
    let mode: String = conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
}
