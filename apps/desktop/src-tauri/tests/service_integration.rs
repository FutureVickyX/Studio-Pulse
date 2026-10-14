//! Tracker service integration: the real engine + the real SQLite store, driven by a fake
//! platform probe and a manual clock. No threads, no Tauri, no Win32, so it runs on any OS.
//!
//! Covers restart without duplicates, crash recovery, pause, timed pause, sleep gaps,
//! onboarding consent, disabling, history deletion and the offline outbox.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, RwLock};

use studio_pulse_lib::platform::{ProcessInfo, SystemProbe};
use studio_pulse_lib::registry::Registry;
use studio_pulse_lib::settings::Settings;
use studio_pulse_lib::store::{Store, TrackingEventRecord};
use studio_pulse_lib::tracker::service::{
    Clock, TrackerCommand, TrackerCore, TrackerDeps, TrackerObserver, TrackerState, TrackerStatus,
};
use studio_pulse_lib::tracker::{EndReason, SessionState};

/// 2026-10-13T09:00:00Z
const BASE_WALL: i64 = 1_791_882_000_000;
const DEVICE: &str = "device-under-test";

#[derive(Clone)]
struct World {
    inner: Arc<Mutex<WorldState>>,
}

struct WorldState {
    wall: i64,
    mono: u64,
    foreground: Option<ProcessInfo>,
    last_input_wall: i64,
    session: SessionState,
}

impl World {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(WorldState {
                wall: BASE_WALL,
                mono: 0,
                foreground: None,
                last_input_wall: BASE_WALL,
                session: SessionState::Active,
            })),
        }
    }

    fn focus(&self, exe: &str) {
        let mut s = self.inner.lock().unwrap();
        s.foreground = Some(ProcessInfo {
            pid: 4242,
            exe_name: exe.to_string(),
            exe_path: format!(r"C:\Program Files\Test\{exe}"),
        });
        s.last_input_wall = s.wall;
    }

    fn focus_nothing(&self) {
        self.inner.lock().unwrap().foreground = None;
    }

    /// Advance both clocks by one second; `active` means the user touched the input.
    fn second(&self, active: bool) {
        let mut s = self.inner.lock().unwrap();
        s.wall += 1_000;
        s.mono += 1_000;
        if active {
            s.last_input_wall = s.wall;
        }
    }

    /// System sleep: the wall clock jumps, the monotonic clock barely moves.
    fn sleep(&self, ms: i64) {
        let mut s = self.inner.lock().unwrap();
        s.wall += ms;
        s.mono += 500;
        s.last_input_wall = s.wall;
    }

    fn wall(&self) -> i64 {
        self.inner.lock().unwrap().wall
    }
}

impl SystemProbe for World {
    fn foreground_process(&mut self) -> Option<ProcessInfo> {
        self.inner.lock().unwrap().foreground.clone()
    }

    fn idle_ms(&mut self) -> Option<u64> {
        let s = self.inner.lock().unwrap();
        Some(u64::try_from(s.wall - s.last_input_wall).unwrap_or(0))
    }

    fn session_state(&mut self) -> SessionState {
        self.inner.lock().unwrap().session
    }
}

impl Clock for World {
    fn wall_ms(&self) -> i64 {
        self.inner.lock().unwrap().wall
    }

    fn mono_ms(&self) -> u64 {
        self.inner.lock().unwrap().mono
    }
}

#[derive(Clone, Default)]
struct Counter {
    statuses: Arc<Mutex<Vec<TrackerStatus>>>,
    events_changed: Arc<AtomicUsize>,
    auto_resumed: Arc<AtomicUsize>,
}

impl TrackerObserver for Counter {
    fn status_changed(&self, status: &TrackerStatus) {
        self.statuses.lock().unwrap().push(status.clone());
    }

    fn events_changed(&self) {
        self.events_changed.fetch_add(1, Ordering::SeqCst);
    }

    fn auto_resumed(&self) {
        self.auto_resumed.fetch_add(1, Ordering::SeqCst);
    }
}

fn onboarded_settings() -> Settings {
    let mut settings = Settings::default();
    settings.onboarding.completed = true;
    settings.tracking.checkpoint_seconds = 15;
    settings.tracking.minimum_interval_seconds = 2;
    settings.tracking.idle_timeout_minutes = 5;
    settings
}

struct Harness {
    world: World,
    store: Arc<Store>,
    settings: Arc<RwLock<Settings>>,
    registry: Arc<RwLock<Registry>>,
    observer: Counter,
    core: TrackerCore,
}

fn registry_from(store: &Store) -> Registry {
    Registry::new(store.list_applications().unwrap())
}

fn harness_with(store: Arc<Store>, world: World, settings: Settings) -> Harness {
    store.seed_default_applications().unwrap();
    let settings = Arc::new(RwLock::new(settings));
    let registry = Arc::new(RwLock::new(registry_from(&store)));
    let observer = Counter::default();
    let core = TrackerCore::new(TrackerDeps {
        store: Arc::clone(&store),
        probe: Box::new(world.clone()),
        clock: Box::new(world.clone()),
        registry: Arc::clone(&registry),
        settings: Arc::clone(&settings),
        device_id: DEVICE.to_string(),
        observer: Box::new(observer.clone()),
    })
    .unwrap();
    Harness {
        world,
        store,
        settings,
        registry,
        observer,
        core,
    }
}

fn harness() -> Harness {
    harness_with(
        Arc::new(Store::open_in_memory().unwrap()),
        World::new(),
        onboarded_settings(),
    )
}

impl Harness {
    fn run_seconds(&mut self, seconds: u32, active: bool) {
        for _ in 0..seconds {
            self.world.second(active);
            self.core.tick();
        }
    }

    fn rows(&self) -> Vec<TrackingEventRecord> {
        self.store.list_all_events().unwrap()
    }

    /// Handle a command synchronously and return its reply. (`Shutdown` makes `handle` return
    /// false, which is expected.)
    fn send<T>(&mut self, build: impl FnOnce(mpsc::Sender<T>) -> TrackerCommand) -> T {
        let (tx, rx) = mpsc::channel();
        self.core.handle(build(tx));
        rx.try_recv().expect("tracker replied")
    }

    fn update_settings(&mut self, change: impl FnOnce(&mut Settings)) {
        change(&mut self.settings.write().unwrap());
        self.send(|reply| TrackerCommand::SettingsChanged { reply });
    }
}

fn assert_no_overlaps(rows: &[TrackingEventRecord]) {
    let mut sorted: Vec<_> = rows.iter().collect();
    sorted.sort_by_key(|r| r.started_at_ms);
    for pair in sorted.windows(2) {
        assert!(
            pair[0].ended_at_ms <= pair[1].started_at_ms,
            "overlap between {} and {}",
            pair[0].id,
            pair[1].id
        );
    }
}

fn reason(row: &TrackingEventRecord) -> Option<EndReason> {
    row.end_reason
}

#[test]
fn records_the_foreground_app_and_checkpoints_the_open_interval() {
    let mut h = harness();
    h.world.focus("Photoshop.exe");
    h.run_seconds(20, true);

    let status = h.core.status();
    assert_eq!(status.state, TrackerState::Tracking);
    let current = status.current.expect("current interval");
    assert_eq!(current.application_id, "adobe-photoshop");

    let rows = h.rows();
    assert_eq!(rows.len(), 1, "one interval row, updated in place");
    assert_eq!(rows[0].state, "open");
    assert!(rows[0].ended_at_ms > rows[0].started_at_ms);
    assert!(h.observer.events_changed.load(Ordering::SeqCst) >= 1);
}

#[test]
fn switching_apps_closes_the_previous_interval() {
    let mut h = harness();
    h.world.focus("Photoshop.exe");
    h.run_seconds(10, true);
    h.world.focus("blender.exe");
    h.run_seconds(10, true);
    h.send(|reply| TrackerCommand::Shutdown { reply });

    let rows = h.rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].application_id, "adobe-photoshop");
    assert_eq!(reason(&rows[0]), Some(EndReason::AppSwitch));
    assert_eq!(rows[1].application_id, "blender");
    assert_eq!(reason(&rows[1]), Some(EndReason::Shutdown));
    assert_eq!(rows[0].ended_at_ms, rows[1].started_at_ms);
    assert_no_overlaps(&rows);
}

#[test]
fn paused_tracking_records_nothing_until_resumed() {
    let mut h = harness();
    h.world.focus("AfterFX.exe");
    h.run_seconds(10, true);
    h.send(|reply| TrackerCommand::Pause {
        until_ms: None,
        reply,
    });
    assert_eq!(h.core.status().state, TrackerState::Paused);
    let paused_at = h.world.wall();
    h.run_seconds(120, true);
    assert_eq!(h.rows().len(), 1, "no interval while paused");
    assert_eq!(reason(&h.rows()[0]), Some(EndReason::Paused));
    assert!(h.rows()[0].ended_at_ms <= paused_at);

    h.send(|reply| TrackerCommand::Resume { reply });
    h.run_seconds(20, true);
    let rows = h.rows();
    assert_eq!(rows.len(), 2);
    assert!(
        rows[1].started_at_ms >= paused_at + 120_000,
        "paused span never credited"
    );
    assert_no_overlaps(&rows);
}

#[test]
fn timed_pause_resumes_by_itself() {
    let mut h = harness();
    h.world.focus("AfterFX.exe");
    h.run_seconds(5, true);
    let until = h.world.wall() + 60_000;
    h.send(|reply| TrackerCommand::Pause {
        until_ms: Some(until),
        reply,
    });
    assert!(h.core.status().paused_until.is_some());
    h.run_seconds(59, true);
    assert_eq!(h.core.status().state, TrackerState::Paused);
    h.run_seconds(3, true);
    assert_eq!(h.core.status().state, TrackerState::Tracking);
    assert_eq!(h.observer.auto_resumed.load(Ordering::SeqCst), 1);
}

#[test]
fn nothing_is_recorded_before_onboarding_consent() {
    let mut settings = onboarded_settings();
    settings.onboarding.completed = false;
    let mut h = harness_with(
        Arc::new(Store::open_in_memory().unwrap()),
        World::new(),
        settings,
    );
    h.world.focus("Figma.exe");
    h.run_seconds(60, true);
    assert_eq!(h.core.status().state, TrackerState::NotStarted);
    assert!(h.rows().is_empty());

    h.update_settings(|s| s.onboarding.completed = true);
    h.run_seconds(20, true);
    assert_eq!(h.core.status().state, TrackerState::Tracking);
    assert_eq!(h.rows().len(), 1);
}

#[test]
fn disabling_tracking_closes_the_interval_and_stops_recording() {
    let mut h = harness();
    h.world.focus("Figma.exe");
    h.run_seconds(10, true);
    h.update_settings(|s| s.tracking.enabled = false);
    assert_eq!(h.core.status().state, TrackerState::Disabled);
    h.run_seconds(30, true);
    let rows = h.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(reason(&rows[0]), Some(EndReason::Disabled));
}

#[test]
fn sleep_is_never_credited() {
    let mut h = harness();
    h.world.focus("Resolve.exe");
    h.run_seconds(30, true);
    let before_sleep = h.world.wall();
    h.world.sleep(10 * 60 * 1000);
    h.core.tick();
    h.run_seconds(30, true);
    h.send(|reply| TrackerCommand::Shutdown { reply });

    let rows = h.rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].ended_at_ms, before_sleep);
    assert_eq!(reason(&rows[0]), Some(EndReason::TimeGap));
    let credited: i64 = rows.iter().map(|r| r.ended_at_ms - r.started_at_ms).sum();
    assert!(
        credited <= 61_000,
        "credited {credited} ms across a 10-minute sleep"
    );
    assert_no_overlaps(&rows);
}

#[test]
fn disabling_an_application_mid_session_closes_its_interval() {
    let mut h = harness();
    h.world.focus("Photoshop.exe");
    h.run_seconds(10, true);
    let mut apps = h.store.list_applications().unwrap();
    let photoshop = apps.iter_mut().find(|a| a.id == "adobe-photoshop").unwrap();
    photoshop.enabled = false;
    *h.registry.write().unwrap() = Registry::new(apps);
    h.core.handle(TrackerCommand::RegistryChanged);
    h.run_seconds(10, true);
    let rows = h.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(reason(&rows[0]), Some(EndReason::Untracked));
    assert_eq!(h.core.status().state, TrackerState::Untracked);
}

#[test]
fn crash_and_restart_do_not_duplicate_intervals() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("studio-pulse.sqlite3");
    let world = World::new();

    // Session 1: track for 40 s, then "crash" (drop without shutdown).
    {
        let store = Arc::new(Store::open(&path).unwrap());
        let mut h = harness_with(store, world.clone(), onboarded_settings());
        h.world.focus("blender.exe");
        h.run_seconds(40, true);
        assert_eq!(h.rows().len(), 1);
        assert_eq!(h.rows()[0].state, "open");
    }

    // Session 2: recover, then keep tracking the same app.
    let store = Arc::new(Store::open(&path).unwrap());
    let report = store.recover_open_intervals(2_000).unwrap();
    assert_eq!(report.closed, 1);
    let recovered = store.list_all_events().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(reason(&recovered[0]), Some(EndReason::Recovered));
    let recovered_end = recovered[0].ended_at_ms;
    assert!(
        recovered_end <= world.wall(),
        "never past the last observation"
    );

    let mut h = harness_with(store, world, onboarded_settings());
    h.run_seconds(30, true);
    h.send(|reply| TrackerCommand::Shutdown { reply });
    let rows = h.rows();
    assert_eq!(
        rows.len(),
        2,
        "the recovered interval plus one new interval"
    );
    assert!(rows[1].started_at_ms >= recovered_end);
    assert_ne!(rows[0].id, rows[1].id);
    assert_no_overlaps(&rows);
}

#[test]
fn deleting_all_history_does_not_resurrect_the_open_interval() {
    let mut h = harness();
    h.world.focus("Figma.exe");
    h.run_seconds(40, true);
    let deleted = h.send(|reply| TrackerCommand::DeleteHistory {
        before_ms: None,
        reply,
    });
    assert_eq!(deleted, Ok(1));
    assert!(h.rows().is_empty());
    h.run_seconds(20, true);
    let rows = h.rows();
    assert_eq!(rows.len(), 1);
    assert!(
        rows[0].started_at_ms >= h.world.wall() - 21_000,
        "a fresh interval, not the deleted one"
    );
}

#[test]
fn closed_intervals_wait_in_the_offline_outbox() {
    let mut h = harness();
    h.world.focus("Photoshop.exe");
    h.run_seconds(10, true);
    h.world.focus("blender.exe");
    h.run_seconds(10, true);
    h.world.focus_nothing();
    h.run_seconds(5, true);
    let rows = h.rows();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.sync_status == "pending"));
    let summary = h.store.data_summary().unwrap();
    assert_eq!(summary.pending_sync_count, 2);
    assert_eq!(h.core.status().state, TrackerState::Untracked);
}

#[test]
fn idle_time_is_split_from_active_time() {
    let mut h = harness();
    h.world.focus("Photoshop.exe");
    h.run_seconds(10 * 60, true); // 10 min active
    h.run_seconds(8 * 60, false); // 8 min without input
    assert_eq!(h.core.status().state, TrackerState::Idle);
    h.run_seconds(2 * 60, true); // back to work
    h.send(|reply| TrackerCommand::Shutdown { reply });

    let rows = h.rows();
    let active: i64 = rows
        .iter()
        .map(|r| (r.active_seconds * 1000.0).round() as i64)
        .sum();
    let idle: i64 = rows
        .iter()
        .map(|r| (r.idle_seconds * 1000.0).round() as i64)
        .sum();
    let foreground: i64 = rows.iter().map(|r| r.ended_at_ms - r.started_at_ms).sum();
    // The interval opens on the first tick, one second after focus.
    assert!(
        (foreground - (20 * 60 - 1) * 1000).abs() <= 1_000,
        "foreground {foreground} ms"
    );
    assert!(
        (idle - 8 * 60 * 1000).abs() <= 1_000,
        "idle {idle} ms ≈ 8 min of no input"
    );
    assert_eq!(active + idle, foreground);
    assert_no_overlaps(&rows);
}
