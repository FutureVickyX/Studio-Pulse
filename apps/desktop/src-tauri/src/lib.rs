//! Studio Pulse desktop core.
//!
//! Module map (docs/architecture.md §3):
//! - [`tracker`]  pure accounting engine + background service
//! - [`platform`] Win32 probes (foreground process, idle, session state)
//! - [`registry`] application definitions and process matching
//! - [`store`]    local SQLite persistence
//! - [`startup`]  launch-at-login registration
//! - [`settings`] user settings
//! - `commands`, `tray`, `window_manager`, `app_state`: the Tauri shell

pub mod error;
pub mod platform;
pub mod registry;
pub mod settings;
pub mod startup;
pub mod store;
pub mod tracker;

mod app_state;
mod commands;
mod tray;
mod window_manager;

use std::sync::{Arc, RwLock};

use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_notification::NotificationExt;

use crate::app_state::AppState;
use crate::registry::Registry;
use crate::settings::Settings;
use crate::startup::StartupConfig;
use crate::store::Store;
use crate::tracker::service::{
    self, SystemClock, TrackerCommand, TrackerCore, TrackerDeps, TrackerObserver, TrackerStatus,
};

/// Database file inside the app data directory (`%APPDATA%\com.studiopulse.desktop`).
pub const DATABASE_FILE: &str = "studio-pulse.sqlite3";
/// Tracker poll period.
const POLL_MS: u64 = 1_000;

/// Bridges tracker callbacks to Tauri events, the tray and notifications.
struct ShellObserver {
    app: AppHandle,
    settings: Arc<RwLock<Settings>>,
}

impl ShellObserver {
    fn notifications_enabled(&self) -> bool {
        match self.settings.read() {
            Ok(s) => s.tracking.notifications,
            Err(poisoned) => poisoned.into_inner().tracking.notifications,
        }
    }
}

impl TrackerObserver for ShellObserver {
    fn status_changed(&self, status: &TrackerStatus) {
        tray::update(&self.app, status);
        let _ = self.app.emit(commands::EVENT_TRACKER_STATUS, status);
    }

    fn events_changed(&self) {
        let at = store::iso_from_ms(chrono::Utc::now().timestamp_millis());
        let _ = self.app.emit(
            commands::EVENT_EVENTS_CHANGED,
            serde_json::json!({ "at": at }),
        );
    }

    fn auto_resumed(&self) {
        if self.notifications_enabled() {
            notify(&self.app, "Tracking resumed", "Your timed pause has ended.");
        }
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        log::debug!("notification failed: {err}");
    }
}

/// `%APPDATA%\com.studiopulse.desktop`. Development builds honour `STUDIO_PULSE_DATA_DIR` so
/// end-to-end tests never touch a real installation's data; release builds ignore it.
fn data_directory(app: &tauri::App) -> tauri::Result<std::path::PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(dir) = std::env::var_os("STUDIO_PULSE_DATA_DIR").filter(|d| !d.is_empty()) {
            return Ok(std::path::PathBuf::from(dir));
        }
    }
    app.path().app_data_dir()
}

/// Open the store, recover, build the tracker, tray and windows. Runs inside Tauri's `setup`.
fn initialise(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let data_dir = data_directory(app)?;
    std::fs::create_dir_all(&data_dir)?;
    let store = Arc::new(Store::open(&data_dir.join(DATABASE_FILE))?);
    let device_id = store.device_id()?;
    let seeded = store.seed_default_applications()?;
    let settings = store.load_settings()?;
    let recovery = store
        .recover_open_intervals(i64::from(settings.tracking.minimum_interval_seconds) * 1_000)?;
    log::info!(
        "Studio Pulse {} starting (schema {}, {} built-in app(s) added, recovered {} / discarded {} unfinished interval(s))",
        app.package_info().version,
        store.schema_version()?,
        seeded,
        recovery.closed,
        recovery.discarded
    );

    let registry = Arc::new(RwLock::new(Registry::new(store.list_applications()?)));
    let settings_lock = Arc::new(RwLock::new(settings.clone()));
    let launched_at_login = startup::launched_at_login(std::env::args());

    // The tray must exist before the tracker publishes its first status.
    let tray_state = tray::create(&handle)?;
    app.manage(tray_state);

    let core = TrackerCore::new(TrackerDeps {
        store: Arc::clone(&store),
        probe: platform::create_probe(),
        clock: Box::new(SystemClock::new()),
        registry: Arc::clone(&registry),
        settings: Arc::clone(&settings_lock),
        device_id: device_id.clone(),
        observer: Box::new(ShellObserver {
            app: handle.clone(),
            settings: Arc::clone(&settings_lock),
        }),
    })?;
    let initial_status = core.status();
    let tracker = service::spawn(core, POLL_MS)?;
    tray::update(&handle, &initial_status);

    app.manage(AppState {
        store,
        tracker,
        settings: settings_lock,
        registry,
        device_id,
        startup: StartupConfig::default(),
        launched_at_login,
        data_dir,
    });

    window_manager::apply_theme(&handle, settings.general.theme);
    let view = window_manager::startup_view(&settings, launched_at_login);
    window_manager::apply_startup_view(&handle, view);

    if launched_at_login
        && settings.tracking.notifications
        && settings.onboarding.completed
        && settings.tracking.enabled
    {
        notify(
            &handle,
            "Studio Pulse is running",
            "Tracking your enabled creative apps in the background. Pause any time from the tray.",
        );
    }
    Ok(())
}

/// Close the open interval and stop the tracker thread before the process exits.
fn shutdown_tracker(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if state
            .tracker
            .request(|reply| TrackerCommand::Shutdown { reply })
            .is_none()
        {
            log::warn!("tracker did not confirm shutdown; the last checkpoint will be recovered on next start");
        }
    }
}

/// Entry point used by `main.rs`.
pub fn run() {
    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("studio-pulse".into()),
            }),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
        ])
        .max_file_size(2_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
        .build();

    let app = tauri::Builder::default()
        // Must be registered first: a second launch focuses the running instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window_manager::show_main(app);
        }))
        .plugin(log_plugin)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            initialise(app).map_err(|err| {
                log::error!("Studio Pulse failed to start: {err}");
                err
            })
        })
        .on_window_event(window_manager::handle_main_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::get_tracker_status,
            commands::pause_tracking,
            commands::resume_tracking,
            commands::list_tracking_events,
            commands::get_settings,
            commands::update_settings,
            commands::complete_onboarding,
            commands::get_startup_status,
            commands::set_launch_at_login,
            commands::list_applications,
            commands::save_application,
            commands::delete_application,
            commands::reset_applications,
            commands::list_running_applications,
            commands::pick_executable,
            commands::get_data_summary,
            commands::export_tracking_events,
            commands::delete_tracking_events,
            commands::get_app_info,
            commands::show_main_window,
            commands::hide_indicator,
            commands::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Studio Pulse");

    app.run(|app, event| match event {
        // Windows are hidden, not closed, when minimizing to tray. If every window does close,
        // keep running in the tray; explicit quits (`app.exit`) carry an exit code and proceed.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        RunEvent::Exit => shutdown_tracker(app),
        _ => {}
    });
}
